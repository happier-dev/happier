---
name: happier-plugin-authoring
description: Create, edit, diagnose, test, package, and install a Happier plugin through public authoring contracts.
---

# Happier plugin authoring

This workspace uses `@happier-dev/plugin-sdk@0.0.0`, derived from the public toolchain compatibility packet.

## Public API source of truth

Before choosing an SDK import, read `node_modules/@happier-dev/plugin-sdk/API.md`. That generated inventory is the current public API contract; do not guess names or copy a versioned export list into this skill.
Before adopting a contribution or service family, read `node_modules/@happier-dev/plugin-sdk/capability-matrix.json`. It is the sole product-availability authority: a `deferred` row is conformance-only reference material, not a supported product lifecycle. Its source API and consumer fields do not by themselves establish loaded-platform or release availability.
Use only the package entrypoints documented there. Do not reach into host source, private aliases, or another installed plugin artifact.

## Cross-plugin integrations

For the supported beginner cross-plugin shape, read `node_modules/@happier-dev/plugin-sdk/examples/operation-only-channel-provider/`. It consumes the public `@happier-dev/channels-protocol/v1` contract by binding this plugin's Actions to the target-owned `happier.channels/providers` point; it does not declare a target, descriptor, or surface. Its `external-author-supported` classification and the relevant capability-matrix rows remain the availability authority. For a first-party Preview product that also owns a descriptor and embedded surface, use the advanced `action-contract-producer` and `action-contract-consumer` pair instead. The examples resolve from this workspace once dependencies are prepared; a documentation-site path does not. This beginner scaffold does not declare a feature integration.

## Normal author loop

Work in a normal Happier Agent Session rooted at this source directory. Use the same public lifecycle as a human author:

1. Start or continue live development with `happier plugins dev`. It prepares declared dependencies automatically; do not run `happier plugins dev install .` first. It prompts once to trust this source root, so when no present user can answer that prompt use the headless route below instead.
2. The generated prepublication SDK version resolves automatically through the running Happier CLI during managed author commands; do not add a workspace alias, file dependency, author-owned `pnpm-workspace.yaml`, or ad hoc local registry.
When deliberately preparing from an approved registry origin, pass `--sdk-registry <origin>` to `happier plugins dev`, `happier plugins dev install .`, or `happier plugins pack .`.
3. Make the smallest source change, then use `happier plugins dev typecheck .`, `happier plugins dev build .`, and `happier plugins test .` for focused checks. Validate through the managed source-development lifecycle; do not create or install a local release archive as an additional feature-QA gate.
4. Use `happier plugins doctor .` to diagnose an import or top-level evaluation issue; it evaluates once and does not prove repeated evaluation is pure.
5. Use the installed `node_modules/@happier-dev/plugin-sdk/examples/` as copyable public patterns, then adapt the smallest matching example through documented SDK exports. For a custom persistent Session Agent, start from `node_modules/@happier-dev/plugin-sdk/examples/session-agent/` after the generic scaffold; its package-root entry and import-safe Session runner leaf are the maintained executable reference. Use `node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/` only when the same package also needs an External Sessions companion, a managed Provider, Connected Accounts, Resources, or daemon-generation background work.

The daemon owns prepared-change custody, activation, and the retained last-known-good generation. If dependency preparation, evaluation, or a UI build fails, fix the source and let the normal development cycle retry; do not start another watcher or loader.

## Headless first install

`happier plugins install . --dev --trust --json` carries one explicit non-interactive authorization for that exact local development source, so the first install of a source root needs no terminal prompt. It decides source-root trust and package trust for that one path, selects no optional host resources, and cancels the pending change with `plugin_explicit_trust_target_mismatch` if the daemon review names any other source. `--trust` is valid only together with `--dev` on a local path.
Later iterations need nothing further: a trusted development source root short-circuits review, so `happier plugins reload --json` applies subsequent edits. `happier plugins dev` has no `--trust` equivalent, so use this route when no present user can answer its source-root prompt.

## Reviews and reconnecting

`--trust` above is the only non-interactive approval. Without it, a `--json` or noninteractive request never auto-approves: it returns a daemon-issued pending ID for a present user to decide. Preserve that ID and rejoin the same change with `happier plugins change status <pendingChangeId> --json`; a present user decides it with `happier plugins change approve <pendingChangeId> --json` or `happier plugins change reject <pendingChangeId> --json`, or from Settings -> Plugins on that machine. Do not submit a second change request while a review or apply is pending. Consequential updates, optional host resources, and secrets always stay with a present user.
A pending ID can be rejoined only during the same daemon lifetime. If status reports `expired` after a daemon restart, rerun the original development or install request and review its newly prepared facts; do not reuse the old pending ID. `outcome_unknown` is different: inspect installed state before replaying a mutation.
