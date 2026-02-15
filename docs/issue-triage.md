# Issue Triage Workflows (Maintainer Tools)

This document explains how the GitHub issue triage workflows in this repository work, and what you need to configure so they can fetch diagnostics and optionally assign a coding agent/bot.

## What the workflows do

Workflows:

- `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/issue-triage.yml`
- `/Users/leeroy/Documents/Development/happier/dev/.github/workflows/issue-triage-manual.yml`

High-level flow:

1. A maintainer triggers triage (comment `/triage` or add the `ai-triage` label, or run the manual workflow).
2. The workflow checks out `happier-dev/maintainers-tools` and builds `hmaint`.
3. `hmaint` calls the deployed bug-report service (the "maintainer service" API) to fetch issue context and diagnostics metadata.
4. The workflow posts a sanitized triage summary comment on the issue.
5. Optionally, it assigns the issue to a configured bot (by GraphQL node id).

## Who can trigger triage

`/Users/leeroy/Documents/Development/happier/dev/.github/workflows/issue-triage.yml` includes an explicit permission check that currently allows only actors with `admin`, `maintain`, `write`, or `triage` permission on the repository.

If you want a dedicated "issue triage" team to be able to trigger triage without granting broader write access, you can:

- Grant that team the `triage` permission level on the repository.

## Required GitHub configuration (secrets + variables)

Configure these in the target repo (for example `happier-dev/happier`):

- Secret: `MAINTAINER_SERVICE_TOKEN`
  - Value: the maintainer token configured on the deployed bug-report service (`BUG_REPORTS_MAINTAINER_TOKEN`).
- Variable: `MAINTAINER_SERVICE_BASE_URL`
  - Example: `https://reports.happier.dev`
- Variable: `MAINTAINER_TOOLS_APP_ID`
  - GitHub App id used to mint a short-lived checkout token at workflow runtime.
- Secret: `MAINTAINER_TOOLS_APP_PRIVATE_KEY`
  - GitHub App private key (PEM) used to mint a short-lived checkout token at workflow runtime.
- Secret: `MAINTAINER_TOOLS_CHECKOUT_TOKEN` (deprecated)
  - Older workflow versions used a PAT here. Prefer the GitHub App token approach above.
- Variable: `TRIAGE_BOT_ID` (optional)
  - GitHub GraphQL node id of the user/bot you want issues assigned to.

If you are storing these values inside a GitHub Environment (for example an environment named `issue-triage`), the workflow job must declare that environment (otherwise the environment-scoped secrets/vars are not injected):

```yaml
jobs:
  triage:
    environment: issue-triage
```

### `MAINTAINER_TOOLS_CHECKOUT_TOKEN`: what it is and how to set it up

This token is only for checking out the private `happier-dev/maintainers-tools` repository in GitHub Actions.

Recommended options:

1. Fine-grained PAT (simple)
   - Create a fine-grained PAT with access limited to `happier-dev/maintainers-tools`.
   - Repository permissions should be read-only (contents read is sufficient for checkout).
   - Store it as the `MAINTAINER_TOOLS_CHECKOUT_TOKEN` secret in the target repo.

2. GitHub App token (no long-lived PAT)
   - Create/install a GitHub App with read access to the `happier-dev/maintainers-tools` repository.
   - In the triage workflow, mint a short-lived installation token and pass it to `actions/checkout`.
   - This avoids storing a long-lived PAT as a secret.
   - You will typically store the App id as an Actions variable (for example `MAINTAINER_TOOLS_APP_ID`) and the private key as an Actions secret (for example `MAINTAINER_TOOLS_APP_PRIVATE_KEY`).
   - Example (using the GitHub-owned action):

     ```yaml
     - name: Create GitHub App token
       id: app-token
       uses: actions/create-github-app-token@v1
       with:
         # Prefer a repo variable, but allow a repo secret as a fallback.
         app-id: ${{ vars.MAINTAINER_TOOLS_APP_ID || secrets.MAINTAINER_TOOLS_APP_ID }}
         private-key: ${{ secrets.MAINTAINER_TOOLS_APP_PRIVATE_KEY }}
         owner: ${{ github.repository_owner }}
         repositories: |
           maintainers-tools

     - name: Checkout maintainer tools
       uses: actions/checkout@v4
       with:
         repository: happier-dev/maintainers-tools
         path: maintainer-tools
         token: ${{ steps.app-token.outputs.token }}
     ```

## What is the "triage bot", and what is `TRIAGE_BOT_ID`?

In these workflows, "triage bot" means: the account that GitHub should assign issues to after posting triage context.

`TRIAGE_BOT_ID` is the **GitHub GraphQL node id** of that account. It is not the numeric user id, and not the login.

How to choose the bot account:

- Use a dedicated machine user (recommended) that is a collaborator on the repo.
- You can also use a bot user associated with a GitHub App, if you want assignments to clearly reflect automation.

How to find `TRIAGE_BOT_ID` from a login:

```bash
gh api users/<bot-login> --jq .node_id
```

If you do not set `TRIAGE_BOT_ID`, triage still works (context comment is posted), but auto-assignment is skipped.

## Why we avoid GitHub Environments for triage

GitHub Environments with required reviewers add an approval prompt on every run. For triage we prefer "one click" execution, so authorization is enforced up front by repo permission level.

## Local validation

To validate the maintainer CLI locally, see:

- `/Users/leeroy/Documents/Development/happier/maintainers-tools/packages/maintainer-cli/README.md`
