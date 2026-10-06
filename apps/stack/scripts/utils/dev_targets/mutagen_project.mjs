import { resolveDevTargetExecutionPolicy } from './config.mjs';

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
  // First-party installed plugin artifacts and their generated inventory are
  // derived from each replica's ignored plugin `dist` trees. Remote daemon/Expo
  // preparation publishes them atomically through the same canonical generator
  // after rebuilding those trees; syncing a local last-green artifact or
  // inventory over them can split the target registry from its executable bytes.
  // Keep this install exclusion narrow so authored SDK examples and test fixtures
  // with checked-in `.happier-plugin` manifests continue to reach the replica.
  'packages/plugins/*/.happier-plugin',
  'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js',
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
  'apps/ui/ios/build',
  // Desktop preparation owns these generated sidecars and their JS runtime companions.
  // Replicating a local build would replace the target-native executable after Cargo builds it.
  'apps/ui/src-tauri/binaries',
  'apps/ui/src-tauri/systemTasks',
  'apps/ui/src-tauri/ssh',
  'apps/ui/src-tauri/integrations',
  // Native preparation generates these resources from the target's resolved Cargo graph.
  // A source flush must neither delete them nor overwrite them with another host's output.
  'packages/iroh-native/release-evidence',
  'apps/ui/android/app/build',
  'apps/ui/android/build',
  'apps/ui/android/.gradle',
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
  '!/.project/plans',
  '!/.project/plans/**',
  '!/.project/tasks',
  '!/.project/tasks/**',
  '!/.project/scripts',
  '!/.project/scripts/**',
  '!/.project/*.md',
  '/.project/plans/runtime-unification-v2/_validation/source-reality-review/qa/lane-A/repo-importers-map.json',
  '/.project/plans/plugin-sdk-author-surface-convergence/CLAUDE-AUDIT-JOURNAL.md',
  '/.project/plans/**/*.har',
  '/.project/plans/**/*.png',
  '/.project/plans/**/*.webm',
  '/.project/plans/**/*.pyc',
  '/.project/plans/**/*.log',
  '/.project/plans/**/*.trace',
  '/.project/plans/**/.DS_Store',
];

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function resolveMutagenSessionName(targetName) {
  const encoded = [...String(targetName)].map((character) => {
    if (/^[A-Za-z0-9]$/.test(character)) return character;
    if (character === '-') return '--';
    if (character === '.') return '-d-';
    if (character === '_') return '-u-';
    return `-x${character.codePointAt(0).toString(16)}-`;
  }).join('');
  return `happier-${encoded}`;
}

export function mutagenProjectOwnerHeader(ownerId) {
  return `# hstack-owner: ${yamlString(ownerId)}`;
}

export function isMutagenProjectOwnedBy(contents, ownerId) {
  return String(contents ?? '').split(/\r?\n/, 2)[0] === mutagenProjectOwnerHeader(ownerId);
}

export function withoutMutagenProjectOwner(contents) {
  return String(contents ?? '').replace(/^# hstack-owner: [^\r\n]*(?:\r?\n|$)/, '');
}

export function isEquivalentMutagenProject(existingContents, desiredContents) {
  return withoutMutagenProjectOwner(existingContents) === withoutMutagenProjectOwner(desiredContents);
}

export function renderMutagenProject({ sourceDir, targets, config = null, ownerId = null }) {
  const { commands, build, ...runtimePlacements } = config
    ? resolveDevTargetExecutionPolicy(config)
    : { commands: { mode: 'local' } };
  const serviceTargets = new Set(Object.values(runtimePlacements).flatMap((placement) => (
    placement.mode === 'prefer-target' ? [placement.target] : placement.targets ?? []
  )));
  const commandTargets = new Set(
    commands.mode === 'prefer-target' ? [commands.target] : commands.targets ?? [],
  );
  for (const name of build?.targets ?? (build?.target ? [build.target] : [])) commandTargets.add(name);
  const lines = [
    ...(ownerId == null
      ? ['# Generated by hstack. User configuration lives in dev-targets.json.']
      : [
          mutagenProjectOwnerHeader(ownerId),
          '# Generated by hstack. User configuration lives in dev-targets.json.',
        ]),
    'sync:',
    '  defaults:',
    '    mode: "one-way-replica"',
    '    ignore:',
    '      vcs: true',
    '      paths:',
    // New root and package inputs synchronize without regenerating membership.
    ...DEV_TARGET_MUTAGEN_IGNORE_PATHS.map((entry) => `        - ${yamlString(entry)}`),
  ];
  for (const target of targets) {
    const commandOnly = commandTargets.has(target.name) && !serviceTargets.has(target.name);
    lines.push(
      `  ${resolveMutagenSessionName(target.name)}:`,
      `    alpha: ${yamlString(sourceDir)}`,
      `    beta: ${yamlString(`${target.ssh}:${target.repoDir}`)}`,
      '    configurationAlpha:',
      '      watch:',
      // Command admission forces a fresh cycle. Captured builds also cross that
      // barrier before reading their mirror entry point; their actual inputs
      // arrive separately by tar. Only services need spontaneous propagation.
      `        mode: ${yamlString(commandOnly ? 'no-watch' : 'portable')}`,
      ...(commandOnly ? [] : ['        pollingInterval: 10']),
      '    configurationBeta:',
      '      watch:',
      '        mode: "no-watch"',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function buildMutagenProjectArgs(action, projectFile) {
  const normalized = String(action ?? '').trim();
  const supported = new Set(['start', 'list', 'flush', 'pause', 'resume', 'reset', 'terminate']);
  if (!supported.has(normalized)) {
    throw new Error(`[dev-targets] unsupported Mutagen project action: ${normalized}`);
  }
  return [
    'project',
    normalized,
    ...(normalized === 'start' ? ['--paused', '--no-global-configuration'] : []),
    '--project-file',
    String(projectFile),
  ];
}
