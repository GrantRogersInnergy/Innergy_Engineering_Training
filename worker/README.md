# innergy-training-links Worker

The page is a static file on GitHub Pages and cannot accept a write. This
Worker is the write path: it holds the GitHub token (the browser never sees it)
and commits notes, links and uploaded documents into this repo. Pages then
serves them to everyone.

| Endpoint             | Writes to                            |
|----------------------|--------------------------------------|
| `POST /add`          | `links.json`                         |
| `POST /upload`       | `uploads/<id>/<file>` + `links.json` |
| `POST /delete`       | `links.json` (+ removes the upload)  |
| `POST /notes/add`    | `notes.json`                         |
| `POST /notes/delete` | `notes.json`                         |
| `GET  /health`       | nothing — checks the token           |

Uploaded documents are committed into the repo under `uploads/` and linked at
their Pages URL, so anyone who opens the page can open them. No login.

## Deploying

### From GitHub (no local setup)

Set two repository secrets under **Settings -> Secrets and variables -> Actions**:

| Secret                 | What it is                                                                 |
|------------------------|----------------------------------------------------------------------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare token, "Edit Cloudflare Workers" template, for the account that owns this Worker |
| `GH_CONTENTS_TOKEN`    | GitHub fine-grained PAT scoped to **this repo only**, **Contents: Read and write** |

Then run **Actions -> Deploy Worker -> Run workflow**. It deploys `worker/`,
uploads `GH_CONTENTS_TOKEN` as the Worker's `GITHUB_TOKEN` secret, and fails the
run if `/health` does not come back `ok:true` on the expected build. After that,
any push to `main` touching `worker/` redeploys automatically.

Do not use the built-in `secrets.GITHUB_TOKEN` for `GH_CONTENTS_TOKEN` — it
expires when the workflow run ends, so the Worker would break minutes later.

### From a terminal

```
cd worker
npx wrangler secret put GITHUB_TOKEN   # paste the PAT
npx wrangler deploy
```

## Checking it works

```
curl https://innergy-training-links.zzqxk7f2p9wj3.workers.dev/health
```

`{"ok":true,"build":"commits-to-github-v2",...}` means this code is live and its
token can reach the repo.

- A **404** means the deployed Worker predates this code — redeploy.
- A different `build` value means something else is deployed over it.
- `{"ok":false,...}` names the token problem.

**Check this first whenever a note or upload seems to vanish.** A Worker with a
dead token, or a build with no GitHub write path, keeps answering writes with
success while nothing reaches the repo. That is what happened on 1 Sep: the
page showed entries as saved and they were gone on reload. Every write now
returns the commit sha it made, and the page refuses to claim success without
one, but only once this code is actually deployed.

Fine-grained PATs expire. When one does, issue a new token and re-run both
commands above.
