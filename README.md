# everydeck/check

Keeps everydeck working after every update. Runs on a push to the default branch and on a pull request of an app connected to everydeck, only when a file listed under `paths` changes (the files with an everydeck call, the app map, the migrations and functions folders, the workflow itself):

1. re-anchors the places of `everydeck/app-map.json` that moved since its commit (git, text, symbol; nothing guessed),
2. runs the everydeck skeleton `@everydeck/check` from npm and `everydeck-check` from PyPI, each in the fixed version this release of the action names (new tables, pages, routes; your descriptions stay),
3. checks that every everydeck call is still in the code (`everydeck-check drift` against `everydeck-manifest.lock.json`); if one is missing the check fails with one sentence per finding and a prompt for your coding agent,
4. sends the result to everydeck, signed in with GitHub's OIDC token of the run (no key). Green on a push to the default branch: with the new facts, as `everydeck-check validate --repo` leaves the app map (the inventory of this commit and the `jobs[]` entries of named pg_cron schedules it writes itself). Your code never leaves GitHub.

```yaml
on:
  push:
    branches: [main]
    paths: ['everydeck/**', 'everydeck-manifest.lock.json', '.github/workflows/everydeck.yml', 'supabase/migrations/**', 'src/lib/everydeck.ts']
  pull_request:
    paths: ['everydeck/**', 'everydeck-manifest.lock.json', '.github/workflows/everydeck.yml', 'supabase/migrations/**', 'src/lib/everydeck.ts']
  workflow_dispatch:
concurrency:
  group: everydeck-${{ github.head_ref || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
permissions:
  contents: read
  id-token: write
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - uses: everydeck/check@v1
        with:
          url: https://your-everydeck
          project: <project id>
```

`npx everydeck init` writes this file (`.github/workflows/everydeck.yml`) when you say yes.

**GitHub Actions minutes.** GitHub bills every job rounded up to a whole minute; a run takes 20 to 30 seconds, so each run costs about one minute (a private repository on the free plan has 2,000 a month, public repositories are free). A pull request that touches the listed files costs about two (the pull request and the merge), one that does not costs nothing; a newer push to the same pull request cancels the older run. Every run says in its summary how long each part took, and names any file with an everydeck call that is not listed under `paths`, so you can add it.
