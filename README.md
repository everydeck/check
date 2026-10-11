# everydeck/check

Keeps everydeck working after every update. Runs on every push and pull request of an app connected to everydeck:

1. re-anchors the places of `everydeck/everydeck-befund.json` that moved since its commit (git, text, symbol – nothing guessed),
2. runs the everydeck skeleton `@everydeck/check` from npm and `everydeck-check` from PyPI, each in the fixed version this release of the action names (new tables, pages, routes; your descriptions stay),
3. checks that every everydeck call is still in the code (`everydeck-check drift` against `everydeck-manifest.lock.json`) – if one is missing the check fails with one sentence per finding and a prompt for your coding agent,
4. sends the result to everydeck, signed in with GitHub's OIDC token of the run (no key). Green on a push to the default branch: with the new facts. Your code never leaves GitHub.

```yaml
permissions:
  contents: read
  id-token: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: everydeck/check@v1
        with:
          url: https://your-everydeck
          project: <project id>
```

`npx everydeck init` writes this file (`.github/workflows/everydeck.yml`) when you say yes.
