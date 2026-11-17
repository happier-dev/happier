// QA-SWEEP-172 #172c repository Events API capture (2026-11-17).
// IDs, identities, URLs, refs, SHAs and timestamps replaced; absent fields retained.
// The retained capture selected these event fields; type restores its PullRequestEvent discriminator.
export const capturedRepositoryPullRequestEvent = {
  "actor": {
    "avatar_url": "https://avatars.githubusercontent.com/u/99",
    "display_login": "fixture-actor",
    "gravatar_id": "",
    "id": 99,
    "login": "fixture-actor",
    "url": "https://api.github.com/users/fixture-actor"
  },
  "created_at": "1970-01-01T00:00:01.100Z",
  "id": "108",
  "payload": {
    "action": "opened",
    "number": 33,
    "pull_request": {
      "base": {
        "ref": "main",
        "repo": {
          "id": 77,
          "name": "widgets",
          "url": "https://api.github.com/repos/acme/widgets"
        },
        "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "head": {
        "ref": "preview",
        "repo": {
          "id": 77,
          "name": "widgets",
          "url": "https://api.github.com/repos/acme/widgets"
        },
        "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "id": 455,
      "number": 33,
      "url": "https://api.github.com/repos/acme/widgets/pulls/33"
    }
  },
  "repo": {
    "id": 77,
    "name": "acme/widgets",
    "url": "https://api.github.com/repos/acme/widgets"
  },
  "type": "PullRequestEvent"
};
