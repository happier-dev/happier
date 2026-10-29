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

## Named tools and CLI commands

In 0.3 development source, declare an operation once under `actions`. Add
`tool: { name, title?, description?, examples?, promptSnippet?, promptGuidelines? }`
for named Agent/MCP presentation and `cli: { path, aliases?, visibility?, tmux? }`
for a friendly CLI path. Include the corresponding `agent`, `mcp`, or `cli`
surface on that Action. Keep input/result schemas, input hints, danger level,
availability and approval on the Action; do not declare separate `tools` or
`commands` families. Check the installed API inventory and target toolchain
before using these development-source fields. See the
[Action author guide](https://docs.happier.dev/plugins/api/actions-tools-commands).

Actions participate in generic Agent/MCP discovery by default under the
canonical per-Action exposure policy. Optional named-tool or CLI metadata is
not a prerequisite for that discovery; use the existing per-Action override
`toolExposure: { agent: 'direct', mcp: 'direct' }` when a direct tool is wanted.
Each `agent`, `mcp`, or `cli` override accepts `direct` or `discoverable_only`;
keep it on the Action, outside `tool`. Generic discovery uses
`action.spec.search`/`action.spec.get` and invocation uses `action_execute`,
subject to declared surfaces, availability, settings and approval.

## Settings and configuration pages

A plugin settings or detail page uses the same anatomy as Happier's own settings (`DESIGN.md` → "Configuration surfaces"): a page header, sentence-case sections with their explanation above the rows, one control per row, visual tiles for choices that change what you see, and list + detail for collections of named things. Compose it from the public plugin UI components that render through Happier's own page owners — `PageHeader`, `ItemGroup` with a `title`/`description`/`action` (a page section), `Item` rows with one control in `accessory`, `Toggle`, `Select` (`presentation="segmented"` for 2–4 short options, `"field"` for longer sets), `TextField presentation="field"` for a value typed in place (`onCommit` saves on leaving), `SelectionTiles` (`variant="visual"` with real previews) and `EmptyState` (`layout="page"`/`"line"`) — checking exact names in the API inventory; do not rebuild headers, row dividers, dropdown triggers, switches or selection rings locally, and do not draw a back control or duplicate the page title (the host places both). See [Settings and detail pages](https://docs.happier.dev/plugins/ui/configuration-pages).

Load `.agents/skills/happier-ui-craft` for the method: hierarchy, control choice, copy, states and the side-by-side check.

In 0.3 development source, declare an app page's optional `description` beside
its `title` (`ui.views` with `container: 'appPage'`, or the surface helper with
`placement: 'appPage'`). It accepts a literal or `{ key, fallback }`. The host
localizes this declaration for its identity header while the executable surface
loads; use the same purpose in the loaded `PageHeader`. Other View containers do
not gain this field, and old declarations may omit it. Check the generated API
and toolchain compatibility facts before targeting a published host: an older
strict parser refuses unsupported declarations through existing compatibility
admission; do not add a field shim.

For a few operations, use public `SelectionTiles variant="action"` with `onPress`: the shared owner turns a narrow page section into rows of one sheet; footer-bearing actions retain their cards. Public `CountedDisclosureItem` folds quiet aggregate details behind a title and optional count or subtitle; use public `List` controlled expansion for a collection item's own details. Import author adapters from `@happier-dev/plugin-ui/components`; `presentation` is host-internal, not an author renderer/metrics API. Public `Collection presentation="grid"` already owns compact tiles: return `null` for absent descriptions and omit unused footer slots. Check these development-source exports in the package API inventory before using them from a published toolchain.

For a Collection toolbar, supply `refine.render()` for the wide controls and
`refine.sheet` for compact Filters from the same controlled model. The sheet
uses shared menu `groups`, optional `radioGroups`, `onSelect`, optional `clear`,
and `showResultsLabel`; choices apply immediately and the primary footer closes
the sheet. `render` takes no placement argument. Use public `SheetMenu` for a
standalone controlled menu with `sheet: { title, footer? }` and optional
`triggerCount`; keep portal/focus/dismissal with the host. For long path/name
rows, `Item.titleEllipsizeMode="middle"` retains the suffix and full accessible
name. These are 0.3 development-source contracts: check the generated plugin-ui
API declarations and the [maintained example](../../../packages/plugin-ui/README.md#collection-filters-and-long-titles-03-development-source).

## Cross-plugin integrations

For Machine-independent plugin Actions in 0.3 development source, declare the
explicit `execution.target: 'account'` artifact/export and export
`definePlugin(...).activateAccount` through the package's existing portable
artifact entry. Account scope alone does not select execution placement. These
handlers run in the invoking UI/CLI from the current enabled Account release or
trusted host-bundled declaration; they use Account storage, host Actions and
admitted targeted contributions, not Machine services. Keep provider-backed
Actions daemon-placed and preserve per-source Machine-required results. Use the
[maintained Account author reference](../../../packages/plugin-sdk/README.md#portable-account-actions-03-development)
and its public fixture; check the generated API and capability matrix before
targeting a published toolchain. Do not add an Account loader, registry or bypass
for policy/approval/currentness, and never replay an uncertain write.

For a PRs & Issues source's selectable repositories/projects/teams/environments
in 0.3 development source, use the optional `listScopeUnits` contribution role,
descriptor `scopeUnit`, and `createTriageSourceSettingsSurface({ scopeSelection })`.
The source owns authorization and its private token codec; the shared control owns
All/Selected, search, paging and submission. `mode: 'configured'` must project only
retained metadata without a provider read. See the canonical
[source author contract](../../../docs/triage-sources.md#shared-source-unit-selection-03-development-source)
for exact exported schemas, adapter shape and the separate snapshot unit join.

In 0.3 development source, Run-on auto-picks by default after the Home's Machine
list settles, preferring the rendered release, last use on this device, this
device's own Machine when known, then recent activity. Declare optional
`executionTarget: { autoPick: false }` in `definePlugin(...)` only when the work
depends on choosing a particular Machine; a sole eligible candidate still
auto-selects and several ask. The existing optional `default: 'installation'`
hint can share this object. Explicit pins never fall back, and
`plugins.execution_origin.list` reports `selectionSource: 'auto' | 'pinned' | null`.
This is a strict manifest routing declaration: use the existing engine/toolchain
compatibility admission for an older host, never a stripping shim.

For broader public composition patterns, use the maintained repository examples linked from the [public quickstart](https://docs.happier.dev/plugins/quickstart), including public-authoring and advanced-package-root. Installed copies at `node_modules/@happier-dev/plugin-sdk/examples/public-authoring/` and `node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/` are release-owned snapshots. Use only contribution and service families marked available in the capability matrix; an example demonstrates public package boundaries but does not create product availability. This beginner scaffold does not declare a feature integration.

## Normal author loop

A project folder uses `src/index.ts` or `index.ts` (not both). If neither exists,
set `package.json.main` to an exact `.ts`, `.mts`, `.js`, or `.mjs` module
exporting `manifest` and `activate`, for example `"main": "./src/index.mjs"`.
Conventional TypeScript source takes precedence over a built package main;
package `exports` do not select the development entry. Keep directory development
for package dependencies and UI-artifact preparation.

Work in a normal Happier Agent Session rooted at this source directory. Use the same public lifecycle as a human author:

1. Start or continue live development with `happier plugins dev`. It prepares declared dependencies automatically; do not run `happier plugins dev install .` first. Explicit registration trusts this exact source root without a separate code-trust prompt. Automatic workspace discovery still requires its remembered project-trust decision. Optional host resources and secrets require their separate authority decisions.
Exception — dependency refresh: that cold-start preparation materializes an author root exactly once, only when nothing resolvable is installed yet. After you change declared dependencies in `package.json`, or your `node_modules` is stale or wiped, run `happier plugins dev install .` once to refresh the tree; the watch loop does not reinstall on every start.
2. The generated prepublication SDK version resolves automatically through the running Happier CLI during managed author commands; do not add a workspace alias, file dependency, author-owned `pnpm-workspace.yaml`, or ad hoc local registry.
When deliberately preparing from an approved registry origin, pass `--sdk-registry <origin>` to `happier plugins dev`, `happier plugins dev install .`, or `happier plugins pack .`.
3. Make the smallest source change, then use `happier plugins dev typecheck .`, `happier plugins dev build .`, and `happier plugins test .` for focused checks. Validate through the managed source-development lifecycle; do not create or install a local release archive as an additional feature-QA gate.
4. Use `happier plugins doctor .` to diagnose an import or top-level evaluation issue; it evaluates once and does not prove repeated evaluation is pure.
5. Adapt the smallest maintained repository example through documented SDK exports. Installed copies in `node_modules/@happier-dev/plugin-sdk/examples/` are release snapshots. For a custom persistent Session Agent, start with `happier plugins create <name> --template session-agent`; the maintained session-agent example is the richer deterministic lifecycle reference. Use advanced-package-root only when the same package also needs External Sessions, a Provider, Connected Accounts, Resources, or background work.

The daemon owns prepared-change custody and activation. A failed in-process replacement keeps the incumbent plugin occurrence active only while that daemon lives. After a daemon restart, Happier rebuilds the current source; if it cannot build and activate, the development plugin is unavailable until corrected. Fix the source and let the normal development cycle retry; do not start another watcher or loader.

## Explicit development install

`happier plugins install . --dev --json` is the explicit code-trust action for that exact local development source, so the first install needs no redundant code-trust prompt. It selects no optional host resources, and cancels the pending change with `plugin_explicit_trust_target_mismatch` if the daemon review names any other source.
Later iterations need nothing further: a trusted development source root short-circuits code review, so `happier plugins reload --json` applies subsequent edits. This is an alternative explicit install command; the normal `plugins dev` loop already trusts its registered source root.

## Reviews and reconnecting

A retained development review is published as an ordinary `plugins.install` approval Artifact in the Happier Inbox. In current 0.3 development source, `happier plugins dev <exact-source> --json` hands a review-required registration to that same install owner and returns its approval Artifact ID. Decide it, then run `plugins dev` again to continue watching. The alternative `happier plugins install <exact-source> --dev --json` rejoins that source's daemon-retained candidate and the same Artifact. Review its daemon-evaluated manifest, permissions, and host access before deciding; an Artifact still awaiting daemon evaluation cannot be approved. Decide in the Inbox or through the public `approval.request.decide` Action, also available to agents and MCP callers under the user's approval policy. The CLI form is `happier actions invoke approval.request.decide --input-json '{"artifactId":"<approvalArtifactId>","decision":"approve"}' --json`; use `reject` to decline. Use the ordinary approval Artifact ID, not the daemon's pending change ID. Optional host resources and secrets always stay with their canonical authority owner.
Preserve any daemon-issued pending change ID for read-only inspection with `happier plugins change status <pendingChangeId> --json`. This status command does not decide or publish an approval. Rejoin the exact source flow instead of preparing an unrelated request while its review or apply is pending.
A pending ID can be rejoined only during the same daemon lifetime. If status reports `expired` after a daemon restart, rerun the original development or install request and review its newly prepared facts; do not reuse the old pending ID. `outcome_unknown` is different: inspect installed state before replaying a mutation.
