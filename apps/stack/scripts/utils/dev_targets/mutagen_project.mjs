import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevTargetExecutionPolicy } from './config.mjs';
import { isExecutionHostWorkspaceId } from '../execution_host/workspace_config.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS } from './mutagen_ignore_paths.mjs';

export const EXECUTION_HOST_CANDIDATE_SYNC_OWNER = 'execution-host-candidate';

export function isExecutionHostCandidateSyncOwner(ownerId) {
  if (ownerId === EXECUTION_HOST_CANDIDATE_SYNC_OWNER) return true;
  const prefix = `${EXECUTION_HOST_CANDIDATE_SYNC_OWNER}-`;
  if (typeof ownerId !== 'string' || !ownerId.startsWith(prefix)) return false;
  if (!isExecutionHostWorkspaceId(ownerId.slice(prefix.length))) {
    throw new Error('[dev-targets] invalid execution-host candidate sync owner');
  }
  return true;
}

export const DEV_TARGET_SYNC_EXECUTOR_REPO = fileURLToPath(new URL('../../../../../', import.meta.url));

export function resolveMutagenRepositoryKey(sourceDir = DEV_TARGET_SYNC_EXECUTOR_REPO) {
  const source = resolve(sourceDir);
  // The routing producer keeps its existing session identities and causal
  // barriers. Other source roots need distinct identities in the same daemon.
  return source === resolve(DEV_TARGET_SYNC_EXECUTOR_REPO)
    ? ''
    : createHash('sha256').update(source).digest('hex').slice(0, 20);
}

export { DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS, DEV_TARGET_MUTAGEN_IGNORE_PATHS } from './mutagen_ignore_paths.mjs';

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function resolveMutagenSessionName(targetName, sourceDir = DEV_TARGET_SYNC_EXECUTOR_REPO) {
  const encoded = [...String(targetName)].map((character) => {
    if (/^[A-Za-z0-9]$/.test(character)) return character;
    if (character === '-') return '--';
    if (character === '.') return '-d-';
    if (character === '_') return '-u-';
    return `-x${character.codePointAt(0).toString(16)}-`;
  }).join('');
  const repository = resolveMutagenRepositoryKey(sourceDir);
  return `happier-${repository ? `${repository}-` : ''}${encoded}`;
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

function primaryStandbyRuntimeIgnores(root) {
  return ['settings.json', 'settings.json.tmp', 'installation-identity.json', 'installation-identity.json.*.tmp',
    ...['daemon.state.json', 'daemon.preview.state.json', 'daemon.dev.state.json', 'connected-service-broker.state.json']
      .flatMap(name => [name, `${name}.tmp`, `${name}.tmp-*`]), '*.pid', '*.lock', 'stack.runtime.json',
  ].flatMap(name => [`${root}/${name}`, `${root}/**/${name}`]);
}

export const PRIMARY_STANDBY_IGNORE_PATHS = Object.freeze([
  'node_modules', 'dist', 'coverage', '.turbo', '.next', '.expo', '.cache',
  '**/.project/tmp', '**/.project/cache', '**/.project/logs',
  // Reuse the worker owner's generated CLI snapshot/tool-output policy at
  // every checkout depth; these are rebuilt on the standby, not source.
  ...DEV_TARGET_MUTAGEN_IGNORE_PATHS.filter(entry =>
    entry === '.runner-snapshots' || entry === 'package-dist'
    || entry === 'apps/cli/tools/unpacked').map(entry => `**/${entry}`),
  '*.tsbuildinfo', '.DS_Store', '*.log', '*.trace',
  // Basenames like build, tmp and *.lock also name authored source and the
  // dependency lockfile. Exclude actual outputs, not every matching basename.
  '**/apps/ui/ios/build', '**/apps/ui/android/app/build', '**/apps/ui/android/build',
  '**/packages/*/android/build', '.gradle', '.cxx', 'Pods',
  // Retain the worker owner's existing authored coverage/dist exceptions at
  // any checkout depth inside HOME, plus authored external plugin fixtures.
  ...DEV_TARGET_MUTAGEN_IGNORE_PATHS.filter(entry => entry.startsWith('!')
    && (entry.includes('/coverage') || entry.includes('/dist'))).map(entry => `!**/${entry.slice(1)}`),
  '!**/fixtures/**/dist', '!**/fixtures/**/dist/**',
  ...['.codex', '.claude', '.happier'].flatMap(root => [
    ...['tmp', '.tmp', 'cache', 'caches', 'materialized', 'isolation', 'server-light']
      .flatMap(name => [`${root}/${name}`, `${root}/**/${name}`]),
    // Capture recognizes extensions case-insensitively; raw-file exclusion
    // must match that admission rather than also copying an uppercase DB.
    ...['sqlite', 'sqlite3', 'db'].flatMap(extension => {
      const pattern = extension.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`);
      return ['', '-wal', '-shm'].flatMap(suffix =>
        [`${root}/*.${pattern}${suffix}`, `${root}/**/*.${pattern}${suffix}`]);
    }),
  ]),
  // These are host-local daemon identities/runtime facts, never transferable
  // session authority. Session movement belongs to canonical Happier handoff.
  ...primaryStandbyRuntimeIgnores('.happier'),
  '.ssh/authorized_keys', '.ssh/authorized_keys2',
  '.happier-stack/execution-host.json', '.happier-stack/lima',
  // The generated snapshot tree has its own replica session below; it is not
  // portable user state and must not have two synchronization writers.
  '.happier-stack/standby-sqlite',
]);

export function resolvePrimaryStandbySessionName(sourceDir) {
  return resolveMutagenSessionName('primary-standby', sourceDir);
}

export function resolvePrimaryStandbySessionNames(sourceDir) {
  return [resolvePrimaryStandbySessionName(sourceDir), resolveMutagenSessionName('primary-standby-sqlite', sourceDir)];
}

export function renderMutagenProject({ sourceDir, targets, config = null, ownerId = null, standby = null }) {
  if (standby) {
    const destination = standby.standby;
    if (standby.scopeDir) {
      const scope = standby.scopeDir;
      if (!standby.localSource || !destination?.ssh || scope !== sourceDir || scope !== destination.scopeDir
        || !standby.homeDir || standby.homeDir !== destination.homeDir
        || !scope.startsWith(`${standby.homeDir}/`) || resolve(scope) !== scope || /[\0\r\n]/.test(scope)) {
        throw new Error('[dev-targets] standby scope requires identical absolute paths inside the declared home');
      }
      // HOME-relative exclusions must also protect a directly scoped tree:
      // `.ssh/authorized_keys` becomes `authorized_keys` when alpha is `.ssh`.
      const scopePrefix = `${scope.slice(standby.homeDir.length + 1)}/`;
      const scopeIgnores = [...PRIMARY_STANDBY_IGNORE_PATHS,
        ...PRIMARY_STANDBY_IGNORE_PATHS.filter(entry => entry.startsWith(scopePrefix))
          .map(entry => entry.slice(scopePrefix.length)),
      ];
      return [
        ...(ownerId ? [mutagenProjectOwnerHeader(ownerId)] : []),
        '# Generated by the dev-target synchronization owner; explicitly scoped standby.',
        'sync:', '  defaults:', '    mode: "one-way-safe"', '    ignore:', '      vcs: false', '      paths:',
        ...scopeIgnores.map(entry => `        - ${yamlString(entry)}`),
        `  ${resolvePrimaryStandbySessionName(sourceDir)}:`,
        `    alpha: ${yamlString(scope)}`, `    beta: ${yamlString(`${destination.ssh}:${scope}`)}`,
        '    configurationAlpha:', '      watch:', '        mode: "no-watch"',
        '    configurationBeta:', '      watch:', '        mode: "no-watch"', '',
      ].join('\n');
    }
    if (!destination || standby.homeDir !== destination.homeDir || !standby.homeDir?.startsWith('/')
      || standby.homeDir === '/' || !standby.ssh || !destination.ssh || standby.ssh === destination.ssh) {
      throw new Error('[dev-targets] standby requires distinct declared SSH endpoints at the same absolute home');
    }
    const cliHomeRelative = standby.cliHomeDir?.startsWith(`${standby.homeDir}/`)
      ? standby.cliHomeDir.slice(standby.homeDir.length + 1) : null;
    return [
      ...(ownerId ? [mutagenProjectOwnerHeader(ownerId)] : []),
      '# Generated by the dev-target synchronization owner; retain both daemon identities.',
      'sync:', '  defaults:', '    mode: "one-way-safe"', '    ignore:', '      vcs: false', '      paths:',
      ...PRIMARY_STANDBY_IGNORE_PATHS.map(entry => `        - ${yamlString(entry)}`),
      ...(cliHomeRelative ? primaryStandbyRuntimeIgnores(cliHomeRelative).map(entry => `        - ${yamlString(entry)}`) : []),
      `  ${resolvePrimaryStandbySessionName(sourceDir)}:`,
      `    alpha: ${yamlString(`${standby.ssh}:${standby.homeDir}`)}`,
      `    beta: ${yamlString(`${destination.ssh}:${destination.homeDir}`)}`,
      '    configurationAlpha:', '      watch:', '        mode: "portable"', '        pollingInterval: 10',
      '    configurationBeta:', '      watch:', '        mode: "no-watch"', '',
      // Only online-backup output lives here. Replacement is intentional and
      // never installs over the standby's live provider databases.
      `  ${resolveMutagenSessionName('primary-standby-sqlite', sourceDir)}:`,
      '    mode: "one-way-replica"',
      `    alpha: ${yamlString(`${standby.ssh}:${standby.homeDir}/.happier-stack/standby-sqlite`)}`,
      `    beta: ${yamlString(`${destination.ssh}:${destination.homeDir}/.happier-stack/standby-sqlite`)}`,
      '    configurationAlpha:', '      watch:', '        mode: "portable"', '        pollingInterval: 10',
      '    configurationBeta:', '      watch:', '        mode: "no-watch"', '',
    ].join('\n');
  }
  const { commands: _commands, build: _build, ...runtimePlacements } = config
    ? resolveDevTargetExecutionPolicy(config)
    : { commands: { mode: 'local' } };
  const serviceTargets = new Set(Object.values(runtimePlacements).flatMap((placement) => (
    placement.mode === 'prefer-target' ? [placement.target] : placement.targets ?? []
  )));
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
    const watchSource = config == null || serviceTargets.has(target.name);
    lines.push(
      `  ${resolveMutagenSessionName(target.name, sourceDir)}:`,
      `    alpha: ${yamlString(sourceDir)}`,
      `    beta: ${yamlString(`${target.ssh}:${target.repoDir}`)}`,
      '    configurationAlpha:',
      '      watch:',
      // Command admission forces a fresh cycle. Captured builds also cross that
      // barrier before reading their mirror entry point; their actual inputs
      // arrive separately by tar. Only services need spontaneous propagation;
      // unused targets stay idle until explicitly synchronized or placed.
      `        mode: ${yamlString(watchSource ? 'portable' : 'no-watch')}`,
      ...(watchSource ? ['        pollingInterval: 10'] : []),
      '    configurationBeta:',
      '      watch:',
      '        mode: "no-watch"',
    );
  }
  return `${lines.join('\n')}\n`;
}


export function hasCurrentMutagenProjectTarget(contents, { sourceDir, target, config, ownerId }) {
  if (!isMutagenProjectOwnedBy(contents, ownerId)) return false;
  const rendered = renderMutagenProject({ sourceDir, targets: [target], config, ownerId });
  const entry = rendered.slice(rendered.indexOf(`  ${resolveMutagenSessionName(target.name, sourceDir)}:\n`));
  return contents.includes(entry);
}

export function resolveMutagenProjectTargets(contents, { sourceDir, targets, config, ownerId }) {
  const requested = new Set(targets.map(target => target.name));
  const candidates = new Map(config.targets.map(target => [target.name, target]));
  for (const target of targets) candidates.set(target.name, target);
  return [...candidates.values()].filter(target => requested.has(target.name) || (
    hasCurrentMutagenProjectTarget(contents, { sourceDir, target, config, ownerId })
  ));
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
