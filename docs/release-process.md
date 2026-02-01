# Release process

This repo uses a simple two-branch model:

- `dev` is the integration branch where changes land first.
- `main` is the stable/release branch.
- `deploy/**` branches are managed by automation for deployments (do not push to these manually).

## Contributing flow (recommended)

1. Create a feature branch from `dev`.
2. Open a pull request targeting `dev`.
3. After review, changes are merged into `dev`.

Notes:

- Maintainers may push directly to `dev` when needed (depending on branch rules).
- External contributors should assume **PRs must target `dev`**, not `main`.

## Release flow (maintainers)

When `dev` is stable and you want to ship:

1. Run the **Release (dev → main)** workflow.
2. The workflow runs the repo test suite and typecheck, builds the website/docs (if enabled), and runs a CLI smoke test (if enabled).
3. If checks pass, it promotes `dev` → `main` using a fast-forward (no merge commit). If `main` has diverged, it can optionally perform a guarded reset.
4. Optionally bumps versions on `main`, promotes deploy branches for the selected environment, and (optionally) publishes the CLI.

Deploy branches typically include `deploy/<env>/ui`, `deploy/<env>/server`, `deploy/<env>/website`, and `deploy/<env>/docs` (depending on what changed and which options you select).

If you only need to move branches (no deploy/publish):

- Use **Promote Branch (fast-forward or reset)** to move `source` → `target` in a safe, explicit way.
- Use **Promote main from dev** as a shortcut wrapper for `dev` → `main`.

## Why fast-forward?

Fast-forwarding `main` to `dev` is the safest “no merge commit” promotion:

- It never rewrites history.
- It fails if branches diverged (so you can decide what to do next).

The reset option exists for rare cases where you intentionally want `main` to match `dev` exactly.
