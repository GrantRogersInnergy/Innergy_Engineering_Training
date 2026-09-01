# Porting this page to another repo

This page is a static GitHub Pages site plus a Cloudflare Worker that holds a
GitHub token and commits links, notes and uploaded documents back into the
repo. Copying the files is **not** enough: several constants name this repo by
hand, and a clone that skips them will happily write into *this* repo instead
of its own.

Source of truth for a port: `GrantRogersInnergy/Innergy_Engineering_Training`
at commit `b77926d` (public, so raw URLs need no auth).

## Files to copy

| File | Why |
|---|---|
| `index.html` | the whole page |
| `worker/worker.js` | the write path |
| `worker/wrangler.toml` | Worker name and entrypoint |
| `worker/package.json` | |
| `worker/README.md` | deploy + `/health` docs |
| `.github/workflows/deploy-worker.yml` | deploys the Worker from Actions |

Start `links.json` as `{}` and `notes.json` as `[]` unless the content is being
migrated too. Do not copy `uploads/` unless the documents should come across.

## Constants that MUST be repointed

Every one of these is currently hardcoded to the source repo.

| File | Line | Current value | Change to |
|---|---|---|---|
| `worker/worker.js` | `OWNER` | `GrantRogersInnergy` | the clone's owner |
| `worker/worker.js` | `REPO` | `Innergy_Engineering_Training` | the clone's repo name |
| `worker/worker.js` | `PAGES_BASE` | `https://grantrogersinnergy.github.io/Innergy_Engineering_Training` | the clone's Pages URL |
| `worker/wrangler.toml` | `name` | `innergy-training-links` | a **different** Worker name, or the deploy overwrites the existing Worker |
| `index.html` | `LINKS_API_URL` | `https://innergy-training-links.zzqxk7f2p9wj3.workers.dev` | the clone's Worker URL |
| `.github/workflows/deploy-worker.yml` | `/health` check | same workers.dev URL | the clone's Worker URL |
| `worker/README.md` | `/health` example | same workers.dev URL | the clone's Worker URL |

`BUILD` in `worker.js` can stay as-is; it only identifies which code is
deployed.

## Setup on the clone

1. **Unarchive the repo** if it is archived — archived repos are read-only and
   nothing below will work.
2. **Enable GitHub Pages** (Settings → Pages → deploy from the default branch,
   root). Confirm `PAGES_BASE` matches the URL Pages reports.
3. **Add two Actions secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — Cloudflare token, "Edit Cloudflare Workers"
     template, for the account that should own the Worker.
   - `GH_CONTENTS_TOKEN` — GitHub fine-grained PAT scoped to **the clone only**,
     **Contents: Read and write**.

   Do not reuse the built-in `secrets.GITHUB_TOKEN` for the second one: it
   expires when the workflow run ends and the Worker would break minutes later.
4. **Run Actions → Deploy Worker → Run workflow.** Adding secrets does not
   re-run a previously failed run; it has to be triggered again.

## Verifying

The deploy is only real if all of these pass.

```
curl https://<the-clone-worker>.workers.dev/health
```

Expect `{"ok":true,"build":"commits-to-github-v2","repo":"<owner>/<repo>",...}`.
Check `repo` names the **clone** — if it names the source repo, `OWNER`/`REPO`
were not repointed and the clone is writing into the wrong place.

- 404 → an older build is deployed; redeploy.
- `{"ok":false,...}` → names the token problem.

Then end-to-end, on the clone's own page: add a link, upload a document, add a
note, and confirm each returns a commit that lands in the **clone's**
`links.json` / `notes.json` / `uploads/`. Delete each one and confirm it is
removed, including the uploaded blob. Refresh immediately after a delete — the
entry must stay gone.

## Behaviour worth knowing before you debug it

- **Writes are committed instantly; Pages takes ~30s to redeploy.** An uploaded
  document is not openable until then, which is why uploads carry a red →
  green badge that polls the real file URL. A delete followed by an immediate
  refresh used to resurrect the entry; the page now records its own recent
  changes in `sessionStorage` and applies them over the published file until it
  catches up.
- **Every write returns a commit sha and the page refuses to claim success
  without one.** This exists because a Worker with no GitHub write path
  answered every write with `{"success":true}` while nothing reached the repo,
  and entries silently vanished for four days. Do not remove that check.
- **The endpoints are unauthenticated.** Anyone with the Worker URL can commit
  files that the clone then serves publicly. `addedBy` is a self-reported
  string, not an identity. Decide whether that is acceptable for the clone —
  an internal repo serving a public Pages site is a different exposure from a
  public one.
- **Fine-grained PATs expire.** When one does, publishing breaks; the page will
  show a red banner rather than silently discarding work. Renewing means
  updating `GH_CONTENTS_TOKEN` and re-running the workflow.
