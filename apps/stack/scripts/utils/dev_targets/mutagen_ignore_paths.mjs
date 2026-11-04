export const DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS = Object.freeze([
  'node_modules',
  'dist',
  '.happier',
  '.tsbuildinfo',
  '.turbo',
  '.example-builds',
]);

const [NODE_MODULES, DIST, HAPPIER] = DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS;

export const DEV_TARGET_MUTAGEN_IGNORE_PATHS = [
  NODE_MODULES,
  DIST,
  'dist.staging.*',
  'dist.__finalize_backup__.*',
  'dist.__sync_tmp__.*',
  'dist.__sync_backup__.*',
  'package-dist.__sync_tmp__.*',
  'package-dist.__sync_backup__.*',
  '.*.__sync_tmp__.*',
  '.*.__sync_backup__.*',
  '.tmp.*',
  '.tmp',
  '.backup.*',
  '.happier-plugin-ui-staging',
  // Root-level first-party runtime matrices and lane reports are disposable
  // test outputs. They are Git-ignored and can exceed hundreds of MiB while a
  // test run is active; workers rebuild the exact fixture needed by the test.
  '.happier-first-party-runner-matrix-*',
  'packages/plugin-sdk/.example-builds',
  '.claude-lane-reports',
  // The Mac checkout's linked worktrees contain Git control files pointing at
  // Mac-local metadata and are not valid worker source. Agent worktrees are
  // created inside the authoritative Linux repository after cutover.
  '.worktrees',
  '.playwright-cli',
  // A nested checkout-local link can point back outside the synchronization
  // root and Mutagen cannot represent it. The real brand package beside this
  // redundant link remains synchronized normally.
  'packages/brand/brand',
  // Installed executable artifacts are built on each replica from its ignored
  // `dist` trees. Keep those outputs local, but replicate the tracked cold
  // manifests: the canonical generator checks every present plugin.json.
  // Ignore children rather than the parent so the manifest exception is reachable.
  'packages/plugins/*/.happier-plugin/*',
  '!packages/plugins/*/.happier-plugin/plugin.json',
  // Public-workflow QA scaffolds also emit their cold manifest on the worker.
  // Source replication must not delete it between daemon and UI compilation.
  'packages/plugin-sdk/fixtures/qa-plugin-authoring/created/qa-*/.happier-plugin',
  'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js',
  // The atmosphere worklet core is compiled by esbuild from installed
  // dependencies; UI source-test preparation is its one producer on a replica.
  'apps/ui/sources/components/atmosphere/backdropWorkletCore.generated.js',
  // Prisma clients and the docs static export are generated on each target.
  // Keep these package-owned outputs local without excluding authored generated sources.
  'apps/server/generated',
  'apps/docs/out',
  '.project',
  HAPPIER,
  '.happier-stack',
  'coverage',
  '!packages/triage-qa/src/coverage',
  '!packages/triage-qa/src/coverage/**',
  '/output',
  '.reviews',
  '.agent-contexts',
  '.dev',
  '.clawpatch',
  '.playwright-mcp',
  '.antigravitycli',
  'evidence',
  'graphify-out',
  '/workspace',
  '.expo',
  '.turbo',
  // Slopo's large SQLite similarity index is derived, machine-local state. It
  // is Git-ignored and must not consume continuous source-replica bandwidth.
  '.slopo',
  // `target` is the Rust build-output convention. Tracked repository directories
  // that happen to carry that name are source and must still reach a dev target;
  // without these exceptions they are silently absent there and every routed
  // typecheck reports phantom `TS2307`s for files that exist in the checkout.
  'target',
  '!packages/protocol/src/browser/target',
  '!packages/protocol/src/browser/target/**',
  '!packages/plugin-sdk/fixtures/external-targeted-packages/target',
  '!packages/plugin-sdk/fixtures/external-targeted-packages/target/**',
  '!packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/target',
  '!packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/target/**',
  'Pods',
  '.next',
  '.runner-snapshots',
  'package-dist',
  '.restore.*',
  '.dist.hstack-*',
  '.dist.build.*',
  '.dist.backup.*',
  '.tsbuildinfo.build.*',
  '*.tsbuildinfo',
  '.cxx',
  // Expo prebuild owns native identity, locks and project files on each target.
  // Preserve complete generated projects in root and nested source checkouts.
  '**/apps/ui/ios',
  '**/apps/ui/android',
  // Desktop preparation owns these generated sidecars and their JS runtime companions.
  // Replicating a local build would replace the target-native executable after Cargo builds it.
  'apps/ui/src-tauri/binaries',
  'apps/ui/src-tauri/systemTasks',
  'apps/ui/src-tauri/ssh',
  'apps/ui/src-tauri/integrations',
  // Native preparation generates these resources from the target's resolved Cargo graph.
  // A source flush must neither delete them nor overwrite them with another host's output.
  'packages/iroh-native/native',
  'packages/iroh-native/native-test',
  'packages/*/ios/vendor',
  'packages/iroh-native/release-evidence',
  // Local Expo module projects synchronize; their Gradle output stays target-local.
  '**/apps/ui/modules/*/android/build',
  'packages/*/android/build',
  // CLI runs write target-local logs. Ignoring only *.log leaves the parent
  // directory visible to Mutagen, causing a deletion conflict on replicas.
  'apps/cli/logs',
  'apps/cli/tmp',
  'apps/cli/tools/unpacked',
  'apps/cli/*:*',
  'subagents/dev-plugin-projection-runtime-closure',
  '.env.local',
  'env.local',
  '*.log',
  '*.trace',
  '.DS_Store',
  '!apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider/dist',
  '!apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider/dist/**',
  '!/.project',
  '/.project/*',
  // Re-open only the selected directories. Recursive negations would override
  // basename exclusions (node_modules, dist, env.local, etc.) in their children.
  '!/.project/plans',
  '!/.project/tasks',
  '!/.project/scripts',
  '!/.project/*.md',
  // These plan directories contain live operation output, including timelines
  // with non-log suffixes. Never stage them into the source flush barrier.
  // Keep authored worker inputs (baselines, ledgers, briefs, configs and script
  // overlays) in the existing allowlist above, outside artifact directories.
  '/.project/plans/**/logs',
  '/.project/plans/**/timelines',
  '/.project/plans/**/captures',
  '/.project/plans/**/tmp',
  // Reference checkouts are controller-only and may be absolute or out-of-tree
  // links. Exclude the link itself before portable symbolic-link scanning.
  '/.project/plans/**/refs',
  '/.project/plans/runtime-unification-v2/_validation/source-reality-review/qa/lane-A/repo-importers-map.json',
  '/.project/plans/plugin-sdk-author-surface-convergence/CLAUDE-AUDIT-JOURNAL.md',
  '/.project/plans/**/BOARD.md',
  '/.project/plans/**/*.har',
  // QA traces are append-only runtime output, not worker source. Including
  // them makes every source barrier race a continuously changing file.
  '/.project/plans/**/*.ndjson',
  '/.project/plans/**/*.jsonl',
  // QA evidence trees can contain case-colliding capture directories. They
  // are target-local output, not source for case-insensitive worker mirrors.
  '/.project/plans/**/qa-shots',
  '/.project/plans/**/*.png',
  '/.project/plans/**/*.webm',
  '/.project/plans/**/*.pyc',
  '/.project/plans/**/*.log',
  '/.project/plans/**/*.trace',
  // Heap and CPU profiles are large live captures written while sampling.
  '/.project/plans/**/*.heapsnapshot',
  '/.project/plans/**/*.cpuprofile',
  // Browser QA owners rewrite this diagnostics snapshot continuously; it races
  // every remote barrier exactly like the append-only traces above.
  '/.project/plans/**/browser-diagnostics.json',
  // Controller QA output, consumed only by its authored journey report.
  '/.project/plans/2026-08-23-ru2-surfaces-finalization/impl-2026-09-30/lanes/qa-login',
  '/.project/plans/**/.DS_Store',
];
