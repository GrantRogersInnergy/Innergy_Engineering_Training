INNERGY Engineering Training Matrix
Internal training matrix for INNERGY's Engineering & Optimizer products — 76 competencies across 10 domains (Product & Business Context, ENGINEERING Core Workflow, Libraries & Standards, Drawings & Output, Optimizer Core Workflow, Machines & Post Output, Integration & Data Flow, Platform/Licensing/Permissions, Troubleshooting & Escalation, Customer-Facing Practice), each with a required proficiency level per role (CSM, ERP Onboarding, Onboarding Specialist, Professional Services, Support) and curated INNERGY Help Center links.

Live page: https://innergy-dev.github.io/INNERGY_Engineering_Training_Matrix/

How it works
index.html — the whole page: static training matrix content, role switcher, light/dark mode, and the "add link or document" / delete / general notes UI. Served as-is via GitHub Pages.
links.json — resource links added by visitors, keyed by competency ID. Read directly by the page; written by the Worker.
notes.json — free-form general notes left by visitors. Same read/write pattern as links.json.
uploads/ — documents visitors upload through the page, committed here by the Worker (created on first upload).
worker/ — a Cloudflare Worker (worker.js) that receives add/upload/delete requests from the page and commits the resulting changes to this repo via the GitHub Contents API, using a repo-scoped token held as a Worker secret. This is what lets everyone's changes show up for every other visitor instantly, without anyone needing write access to this repo themselves.
No sign-in is required to add a link, upload a document, or leave a note — anyone with the page URL can contribute, and anyone can delete an entry.
