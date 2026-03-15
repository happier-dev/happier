# Contributing to Happier

Thanks for taking the time to improve Happier. Contributions are welcome, and we really appreciate the help.

Happier is currently **pre-release** and in a phase of **rapid iteration** (deep changes, new features, lots of WIP). Expect churn: APIs, flows, structure, code, and preferred patterns may shift as the foundations stabilize.

These guidelines are here to:
- help you avoid spending time on changes we can't merge, and
- reduce review churn by aligning early on *what* we want and *how* we want it implemented.

---

## The most valuable contribution: a great issue

You don't need to write code to make a meaningful contribution to Happier.

A well-written issue, clear repro steps, platform context, observed vs expected behavior, and optionally a hypothesis about the cause, is often *more* useful than a PR. It lets us understand the problem on its own terms and address it in a way that fits the current architecture and direction, without the overhead of reviewing code that may need to be rewritten anyway.

**What makes a great issue:**
- A specific, descriptive title ("Android: back button unresponsive during parallel agent runs" beats "back button broken")
- Platform and version context (iOS/Android, OS version, how you're running the CLI)
- What you did, what you expected, what actually happened
- If you can reproduce it reliably: the steps to do so
- If you have a hypothesis about the cause or a possible fix: include it, even rough ideas help

You don't need to be certain about the cause. You don't need to have a solution. Describing the problem clearly *is* the contribution.

If you've dug deeper and have a specific idea for how to fix something, a code path to look at, an approach that might work, a workaround you found, add it to the issue. **That kind of context is exactly what lets us spin up an agent to investigate and fix it quickly.**

**In short:** if you're deciding between spending an hour writing a PR and spending 15 minutes writing a thorough issue, the issue is often the better use of your time, and ours.

Some example of great issues reports:
- https://github.com/happier-dev/happier/issues/91
- https://github.com/happier-dev/happier/issues/93

## TL;DR

- Small fixes are welcome anytime (docs, tests, small bugs).
- For anything bigger than a small isolated change, **please discuss first** so we can confirm it's wanted and point you at the right approach.
- Open PRs against **`dev`** (not `main`).

## How decisions work

- Is this change something the project actually wants right now?
- What are the constraints and “gotchas” in this area?
- What's the preferred implementation approach (so you don't have to redo work after review)?

Maintainers have the final say on what gets merged so the codebase stays coherent, secure, and maintainable.

## What you can contribute without asking (safe surface)

These are almost always welcome as direct PRs:
- Docs fixes / typos / clarifications
- Small bug fixes with clear repro steps
- Tests (unit/integration/e2e) and CI improvements
- Better error messages / logging / developer UX
- Small *purely mechanical* refactors that don't change behavior

## Please discuss first (to avoid wasted effort)

Please start with a Discord/GitHub discussion before implementing if your change is any of:
- New features
- Behavior changes (including defaults, settings, or flows)
- UI/UX changes
- Large refactors or dependency changes
- Anything spanning multiple components (server + CLI + UI)
- Anything touching security- or data-sensitive areas (auth, encryption, sync protocol, storage formats)
- Anything that will likely take more than ~1–2 hours

If you're not sure which category you're in: ask first.

## Where to discuss

Pick whichever is easiest:
- **Discord**: https://discord.gg/W6Pb8KuHfg (great for quick “is this wanted / what's the best approach?” alignment)
- **GitHub Issues**: https://github.com/happier-dev/happier/issues (best for concrete bugs with repro steps)
- **GitHub Discussions**: https://github.com/happier-dev/happier/discussions (best for feature ideas / design / “should we do this?” questions)

If you want the best chance your PR merges quickly: link the issue/discussion thread from the PR.

## PRs

### Where to open pull requests

Please open pull requests against `dev` (not `main`).

- `dev` is the integration branch where changes land first.
- `preview` is the release candidate branch used for preview builds/deploys.
- `main` is the stable/release branch.

If you’re running from source and want a more stable base than `dev`, check out `preview`:

```bash
git clone --branch preview https://github.com/happier-dev/happier.git
```

### What helps your PR get merged

- Keep PRs small and focused (one change per PR; avoid drive-by refactors).
- Explain **why** (problem + context), **what** changed, and **how to test**.
- For behavior changes and bug fixes, tests are strongly preferred when feasible.
- If you want feedback on approach early, open a **Draft PR**.

### PRs reviews and feedback

- We'll try to be responsive, but review time depends on maintainers bandwidth.
- We may request changes to match project patterns/constraints.
- Sometimes we'll close/decline a PR even if it's high quality, usually because it's out of scope, not aligned with direction, or would create maintenance burden. If that happens, we'll try to explain why.

## AI-assisted contributions

Happier is built with AI agents and we have no issue with AI-assisted contributions. What we care about is the human reasoning behind it. If you used AI to write, debug, or substantially shape your contribution:
- Say which tool you used
- Explain what *you* were trying to solve and why you approached it this way
- Explain *your* reasoning and the instructions you gave the AI
- Confirm what you personally tested and verified

A contribution where we can see your thinking, even if the code was mostly AI-generated, is far more useful than one where we're guessing at intent. Think of it less as a PR and more as a "here's the problem, here's how I reasoned about it, here's what an agent produced."

Thank you for taking the time to contribute, we deeply appreciate it!
