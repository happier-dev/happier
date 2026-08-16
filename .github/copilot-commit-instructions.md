## **Commit messages (Conventional Commits)**

Use the **Conventional Commits** spec for all commits (and for the final **squash** commit message when squashing). This is the most widely adopted modern standard for readable history and tooling like changelogs/release automation.

Spec: [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

Format:

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

- **type**: one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`
- **scope (optional)**: short, lowercase area name (examples: `scripts`, `wt`, `stack`, `srv`, `env`, `docs`)
- **description**: imperative mood, present tense, no trailing period (example: “add”, “fix”, “remove”)
- **breaking changes**: add `!` (preferred) and/or a footer `BREAKING CHANGE: ...`
- **issue references (optional)**: add in footers. Use `Refs #123` for partial, mitigation, or release-gated work. Use `Fixes #123` only when merging into the default branch satisfies the issue's real closure condition; Happier's default branch is `dev`, so do not use a closing keyword for an issue that must remain open through preview/stable availability or reporter confirmation.
- **contributor attribution**: when an issue report or comment materially supplied the diagnosis, reproduction insight, design, patch, or solution embodied in this commit, add `Co-authored-by: Name <email>` after a blank line. Resolve the contributor's GitHub-associated email or verified GitHub noreply identity; never write `Co-authored-by: @handle`, guess a private email, or award co-authorship for a routine report that did not shape the correction.

Examples:

```text
feat(wt): add --stash option to update-all
fix(ports): avoid collisions when multiple stacks start
docs(agents): document Conventional Commits
refactor(stack): split env loading into helpers
```
