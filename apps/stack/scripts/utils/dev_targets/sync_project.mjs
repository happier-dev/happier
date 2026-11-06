import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcessHostIdentitySync } from '@happier-dev/cli-common/processInstance';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { runDevTargetSshProcess } from './ssh_transport.mjs';
import { loadDevTargetsConfig } from './config.mjs';
import {
  buildMutagenProjectArgs,
  DEV_TARGET_SYNC_EXECUTOR_REPO,
  hasCurrentMutagenProjectTarget,
  resolveMutagenProjectTargets,
  isEquivalentMutagenProject,
  isExecutionHostCandidateSyncOwner,
  isMutagenProjectOwnedBy,
  renderMutagenProject,
  resolveMutagenSessionName,
  resolvePrimaryStandbySessionName,
  resolvePrimaryStandbySessionNames,
  withoutMutagenProjectOwner,
} from './mutagen_project.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
  resolveDevTargetSshConfigFile,
} from './mutagen_runtime.mjs';

export const INDEPENDENT_DEV_TARGET_SYNC_OWNER = 'dev-target-sync-service';

function projectSessionNames(contents) {
  return [...String(contents ?? '').matchAll(/^  (happier-[A-Za-z0-9-]+):$/gm)].map(match => match[1]);
}

// Mutagen's SSH endpoint model stores the configured user separately.
function mutagenSshHost(sshTarget) {
  return sshTarget.split('@').at(-1);
}

export async function resolveOwnedDevTargetSyncProjectSources({ stackBaseDir, ownerId, env = process.env }) {
  if (!isExecutionHostCandidateSyncOwner(ownerId)) {
    throw new Error('[dev-targets] candidate project recovery requires a candidate owner');
  }
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, ownerId, env });
  const projectName = basename(runtime.projectFile);
  const repositoriesDir = join(runtime.mutagenDir, 'repositories');
  const repositories = await readdir(repositoriesDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const projectFiles = [join(runtime.mutagenDir, projectName), ...repositories
    .filter(entry => entry.isDirectory()).map(entry => join(repositoriesDir, entry.name, projectName))];
  const sources = [];
  for (const projectFile of projectFiles) {
    const contents = await readFile(projectFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (contents === null) continue;
    if (!isMutagenProjectOwnedBy(contents, ownerId)) throw new Error('[dev-targets] candidate project owner mismatch');
    // The canonical generator writes local alpha paths as JSON strings. Read
    // only that producer's evidence, rather than interpreting arbitrary YAML.
    let sourceDir;
    try {
      const alpha = [...contents.matchAll(/^    alpha: (.+)$/gm)];
      if (alpha.length !== 1) throw new Error('expected one source');
      sourceDir = JSON.parse(alpha[0][1]);
      if (typeof sourceDir !== 'string' || !isAbsolute(sourceDir) || /[\0\r\n]/.test(sourceDir)) throw new Error('invalid source');
    } catch {
      throw new Error('[dev-targets] invalid candidate project source evidence');
    }
    const expected = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, ownerId, env });
    const names = projectSessionNames(contents);
    if (resolve(expected.projectFile) !== resolve(projectFile) || names.length !== 1
      || names[0] !== resolveMutagenSessionName(ownerId, sourceDir)) {
      throw new Error('[dev-targets] candidate project does not match its source scope');
    }
    sources.push(sourceDir);
  }
  return [...new Set(sources)];
}
const DEV_TARGET_SYNC_PROJECT_LIFECYCLE_LOCK_STALE_AFTER_MS = 60_000;
const DEV_TARGET_CONTROL_EXECUTABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'bin',
  'hstack-dev-target-control',
);

export function buildDevTargetControlLaunch({ command, args, syncFlushSession = null }) {
  if (process.platform === 'win32') return { command, args };
  return {
    command: DEV_TARGET_CONTROL_EXECUTABLE,
    args: [
      ...(syncFlushSession ? ['--sync-flush', syncFlushSession] : []),
      '--',
      command,
      ...args,
    ],
  };
}

export async function runDevTargetControlProcess(input, { capture = runCaptureResult } = {}) {
  return await runDevTargetSshProcess(input, async ({ label, command, args, env, input: stdin, silent = false, syncFlushSession = null }) => {
    const launch = buildDevTargetControlLaunch({ command, args, syncFlushSession });
    const result = await capture(launch.command, launch.args, {
      env, input: stdin, streamLabel: silent ? undefined : label, stdoutDiagnosticStream: process.stderr,
    });
    return { ...result, code: result.exitCode };
  });
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

async function withDevTargetSyncProjectLifecycleLock(
  { stackBaseDir, sourceDir, env = process.env },
  fn,
) {
  const { mutagenDir } = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  return await withJsonOwnerFileLock(fn, {
    // The live lifecycle owner, not a competing acquisition deadline, decides
    // when the project may be mutated. Only ownerless stale locks are reclaimed.
    lockPath: join(mutagenDir, 'hstack-lifecycle.lock'),
    timeoutMs: Infinity,
    pollIntervalMs: 125,
    staleAfterMs: DEV_TARGET_SYNC_PROJECT_LIFECYCLE_LOCK_STALE_AFTER_MS,
    errorLabel: 'dev-target synchronization project lifecycle lock',
  });
}

async function inspectBorrowedIndependentDevTargetSyncProject(
  { requiredTargets, mutagenRuntime },
  { runProcess },
) {
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
    env: mutagenRuntime.env,
  }), 'independent Mutagen project status');
  const unhealthyTargets = new Map();
  for (const target of requiredTargets) {
    const sessionName = resolveMutagenSessionName(target.name, mutagenRuntime.sourceDir);
    const result = await runProcess({
      label: `sync:${target.name}`,
      command: 'mutagen',
      args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
      env: mutagenRuntime.env,
    });
    // The borrowed project's owner keeps synchronizing while a target is
    // unavailable. Let its consumer supervisor recover that target alongside
    // healthy services instead of failing the entire project admission.
    if (result?.code !== 0) {
      unhealthyTargets.set(target.name, 'unavailable');
      continue;
    }
    const status = parseMutagenSyncList(result.out, sessionName);
    if (status.state !== 'ready' && status.state !== 'synchronizing' && status.state !== 'needs-flush') {
      unhealthyTargets.set(target.name, status.state);
    }
  }
  return unhealthyTargets;
}

export async function resumeDevTargetSync(
  { target, env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const result = await runProcess({
    label: `sync:${target.name}`,
    command: 'mutagen',
    args: ['sync', 'resume', resolveMutagenSessionName(target.name, env?.HAPPIER_STACK_SYNC_SOURCE_DIR)],
    env,
  });
  requireSuccessful(result, `${target.name} Mutagen resume`);
}

export async function flushDevTargetSync(
  { target, env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const result = await runProcess({
    label: `sync:${target.name}`,
    command: 'mutagen',
    args: ['sync', 'flush', resolveMutagenSessionName(target.name, env?.HAPPIER_STACK_SYNC_SOURCE_DIR)],
    syncFlushSession: resolveMutagenSessionName(target.name, env?.HAPPIER_STACK_SYNC_SOURCE_DIR),
    env,
  });
  requireSuccessful(result, `${target.name} Mutagen initial flush`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function canonicalReplicaPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalReplicaPath(parent), basename(path));
  }
}

/** SSH aliases and user-private temporary directories are not host identity.
 * Reuse canonical native OS observations without creating an identity/session. */
async function assertDevTargetReplicaSafety({ sourceDir, targets, sshArgs = [], env = process.env },
  { runProcess = runDevTargetControlProcess } = {}) {
  const source = await canonicalReplicaPath(resolve(sourceDir || env.HAPPIER_STACK_SYNC_SOURCE_DIR || DEV_TARGET_SYNC_EXECUTOR_REPO));
  const hostIdentity = readProcessHostIdentitySync();
  const bootId = process.platform === 'linux' ? hostIdentity?.bootId : null;
  if (!hostIdentity || (process.platform === 'linux' && !bootId)) throw new Error('[dev-targets] source host identity unavailable; refusing one-way mirror admission');
  const contains = (parent, child) => {
    const suffix = relative(parent, child);
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix));
  };
  for (const target of targets) {
    if ((target.platform === 'windows') !== (process.platform === 'win32')) continue;
    const observe = async command => {
      const result = await runProcess({ label: '', command: 'ssh',
        args: [...(sshArgs.length ? sshArgs : target.sshConfigFile ? ['-F', target.sshConfigFile] : []), '-o', 'BatchMode=yes', target.ssh, command], env });
      requireSuccessful(result, `${target.name} replica safety observation`);
      return String(result.out ?? '');
    };
    if (!bootId) {
      const nativeCommand = process.platform === 'win32'
        ? 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(
          '& reg.exe query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; [System.Net.Dns]::GetHostName()', 'utf16le').toString('base64')
        : 'if [ "$(uname -s)" = Darwin ]; then /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice; else printf "%s\\n" HSTACK_OTHER_PLATFORM; fi';
      const output = await observe(nativeCommand);
      if (process.platform === 'darwin' && output.trim() === 'HSTACK_OTHER_PLATFORM') continue;
      // Feed the raw remote OS response through the same canonical reader as
      // the local response; do not create another platform identity parser.
      const remoteIdentity = readProcessHostIdentitySync({ platform: process.platform,
        spawnSyncImpl: () => ({ status: 0, stdout: output }),
        hostnameImpl: () => output.trim().split(/\r?\n/).at(-1),
      });
      if (!remoteIdentity) {
        throw new Error(`[dev-targets] ${target.name} replica host identity unavailable`);
      }
      if (remoteIdentity.machineId !== hostIdentity.machineId) continue;
    }
    const witness = 'HSTACK_CONTROLLER_SOURCE';
    const command = target.platform === 'windows'
      ? 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(
        `Write-Output '${witness}'`, 'utf16le').toString('base64')
      : [
        ...(bootId ? [
          "hstack_boot=''",
          'hstack_platform=$(uname -s) || exit',
          'if [ "$hstack_platform" = Linux ]; then',
          '  [ -r /proc/sys/kernel/random/boot_id ] || exit 1',
          '  IFS= read -r hstack_boot < /proc/sys/kernel/random/boot_id || exit 1',
          'fi',
          `if [ "$hstack_boot" = ${shellQuote(bootId)} ]; then`,
        ] : ['if true; then']),
        `  hstack_path=${shellQuote(target.repoDir)}`,
        '  case "$hstack_path" in /*) ;; *) hstack_path="$PWD/$hstack_path";; esac',
        "  hstack_suffix=''",
        '  while [ ! -d "$hstack_path" ]; do',
        '    hstack_suffix="/${hstack_path##*/}$hstack_suffix"',
        '    hstack_path=${hstack_path%/*}',
        '    [ -n "$hstack_path" ] || hstack_path=/',
        '  done',
        '  cd -P "$hstack_path" || exit',
        `  printf '%s\\n%s%s\\n' ${shellQuote(witness)} "$PWD" "$hstack_suffix"`,
        'fi',
      ].join('\n');
    const [observed, remotePath] = (await observe(command)).trim().split(/\r?\n/);
    if (observed !== witness) continue;
    if (target.platform === 'posix' && !isAbsolute(remotePath ?? '')) {
      throw new Error(`[dev-targets] self-target ${target.name} replica path could not be resolved`);
    }
    const destination = target.platform === 'windows'
      ? await canonicalReplicaPath(resolve(target.repoDir)) : resolve(remotePath);
    if (contains(source, destination) || contains(destination, source)) {
      throw new Error(`[dev-targets] self-target ${target.name} replica overlaps authoritative source ${source}; use local placement or a separate synchronized mirror`);
    }
  }
}

export async function prepareDevTargetOpenSsh({ targets, mutagenDir, env }) {
  // Subset preparation must retain transports used by other repositories.
  const previousConfig = await readFile(join(mutagenDir, 'openssh', 'config'), 'utf8').catch(() => '');
  const previousIncludes = [...previousConfig.matchAll(/^Include (".*")$/gm)].map(match => JSON.parse(match[1]));
  const hosts = [...new Set([
    ...[...previousConfig.matchAll(/^Host ([^*\s]+)$/gm)].map(match => match[1]),
    ...targets.map(target => target.ssh),
  ])];
  const customConfigs = [
    ...new Set([...previousIncludes, ...targets.map((target) => target.sshConfigFile).filter(Boolean)]),
  ];
  if (process.platform === 'win32') {
    if (customConfigs.length === 0) return { sshArgs: [], mutagenEnv: env };
    throw new Error('[dev-targets] sshConfigFile is not yet supported on Windows Stack hosts');
  }

  const opensshDir = join(mutagenDir, 'openssh');
  const configPath = join(opensshDir, 'config');
  await mkdir(opensshDir, { recursive: true });
  await writeFile(
    configPath,
    [
      ...customConfigs.map((path) => `Host *\nInclude ${JSON.stringify(path)}`),
      'Host *',
      `Include ${JSON.stringify(join(homedir(), '.ssh', 'config'))}`,
      // Configured targets (including managed guests) keep their socket;
      // targets without a policy receive the same defaults as enrollment.
      ...hosts.map(host => `Host ${host}\n  ControlMaster auto\n  ControlPersist 600\n  ControlPath "~/.ssh/happier-dev-target-%C"`),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  for (const executable of ['ssh', 'scp']) {
    await writeFile(
      join(opensshDir, executable),
      `#!/bin/sh\nexec /usr/bin/${executable} -F ${shellQuote(configPath)} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    sshArgs: ['-F', configPath],
    mutagenEnv: { ...env, MUTAGEN_SSH_PATH: opensshDir },
  };
}

async function ensureDevTargetSyncProjectUnlocked(
  {
    stackBaseDir,
    sourceDir,
    targets,
    requiredTargets = targets,
    preserveExistingTargets = false,
    ownerId,
    allowIndependentBorrow,
    borrowOnly = false,
    env = process.env,
  },
  {
    runProcess = runDevTargetControlProcess,
  } = {},
) {
  const {
    HAPPIER_STACK_PROCESS_KIND: _stackProcessKind,
    ...mutagenControlEnv
  } = env;
  const candidateProducer = isExecutionHostCandidateSyncOwner(ownerId);
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, ownerId, env: mutagenControlEnv });
  sourceDir = runtime.sourceDir;
  // Routing and candidate producers own distinct projects in the shared daemon.
  // Ordinary Stack supervisors only borrow their existing producer mirrors.
  if (borrowOnly || allowIndependentBorrow || (ownerId !== INDEPENDENT_DEV_TARGET_SYNC_OWNER && !candidateProducer)) {
    const project = await readFile(runtime.projectFile, 'utf8').catch(() => null);
    if (!project) throw new Error('[dev-targets] controlled runtime requires the producer synchronization; run hstack dev-targets sync-service start --detached');
    const unhealthyTargets = await inspectBorrowedIndependentDevTargetSyncProject({ requiredTargets, mutagenRuntime: runtime }, { runProcess });
    return { ...runtime, openSsh: { sshArgs: ['-F', join(runtime.opensshDir, 'config')], mutagenEnv: runtime.env }, ownership: 'borrowed',
      unhealthyTargets, projectCreated: false, release: async () => {} };
  }
  const existingProject = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  const config = (await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json') })).config;
  // Membership is authoritative only under this existing lifecycle lock.
  // A command's pre-bootstrap snapshot can precede another pin's admission.
  if (preserveExistingTargets) targets = resolveMutagenProjectTargets(existingProject, {
    sourceDir, targets, config, ownerId,
  });
  const requiredNames = new Set(requiredTargets.map(target => target.name));
  const retainedTargets = targets.filter(target => !requiredNames.has(target.name));
  // Only this producer's unchanged source/endpoint/watch entries can bypass
  // new-destination safety. A caller cannot declare an unprepared peer safe.
  for (const target of retainedTargets) {
    if (!hasCurrentMutagenProjectTarget(existingProject, { sourceDir, target, config, ownerId })) {
      throw Object.assign(new Error(`[dev-targets] unprepared retained replica: ${target.name}`), {
        code: 'DEV_TARGET_REPLICA_NOT_PREPARED',
      });
    }
  }
  const openSsh = await prepareDevTargetOpenSsh({
    targets,
    mutagenDir: runtime.mutagenDir,
    env: mutagenControlEnv,
  });
  const mutagenRuntime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    sourceDir,
    ownerId,
    env: openSsh.mutagenEnv,
  });
  // Registration can describe an authoritative endpoint. Only this producer
  // may turn it into a one-way destination, so validate before any mutation.
  await assertDevTargetReplicaSafety({ sourceDir, targets: requiredTargets, sshArgs: openSsh.sshArgs, env: mutagenRuntime.env }, { runProcess });
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: mutagenRuntime.env,
  }), 'Mutagen preflight');
  const desiredProject = renderMutagenProject({
    sourceDir,
    targets,
    config,
    ownerId: candidateProducer ? ownerId : INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });

  // Mutagen selects projects by the id in .lock, not by their session names.
  // A lost/replaced lock leaves the previous project's writers in the daemon.
  // Reconcile exact repository-owned sessions before resuming or starting it.
  // Public model/label contract: Mutagen 0.18.1 project/start.go.
  const projectId = (await readFile(`${mutagenRuntime.projectFile}.lock`, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim();
  const listed = await runProcess({ label: '', command: 'mutagen',
    args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: mutagenRuntime.env });
  requireSuccessful(listed, 'Mutagen repository session inventory');
  const sessions = JSON.parse(listed.out || '[]');
  if (!Array.isArray(sessions)) throw new Error('[dev-targets] invalid Mutagen repository session inventory');
  // A project lock scopes its alpha, but the daemon can hold projects for
  // other alphas too. Never activate a second source writer at their endpoint.
  for (const target of targets) {
    const collision = sessions.some(session => session.beta?.protocol === 'ssh'
      && session.beta.host === mutagenSshHost(target.ssh)
      && posix.normalize(session.beta.path ?? '') === posix.normalize(target.repoDir)
      && (session.alpha?.protocol !== 'local' || resolve(session.alpha.path ?? '') !== resolve(sourceDir)));
    if (collision) throw Object.assign(new Error(`[dev-targets] ${target.name} replica destination belongs to another source`), {
      code: 'DEV_TARGET_REPLICA_COLLISION',
    });
  }
  const projectNames = new Set([...projectSessionNames(existingProject), ...projectSessionNames(desiredProject)]);
  const terminated = new Set();
  for (const session of sessions) {
    if (!projectNames.has(session.name) || session.alpha?.protocol !== 'local'
      || resolve(session.alpha.path ?? '') !== resolve(sourceDir)
      || session.mode !== 'one-way-replica' || !session.labels?.['io.mutagen.project']
      || session.labels['io.mutagen.project'] === projectId) continue;
    if (!session.identifier) throw new Error('[dev-targets] orphan Mutagen session has no identifier');
    requireSuccessful(await runProcess({ label: 'sync', command: 'mutagen',
      args: ['sync', 'terminate', session.identifier], env: mutagenRuntime.env }), 'orphan Mutagen session termination');
    terminated.add(session.identifier);
  }
  const currentSessions = JSON.stringify(sessions.filter(session => !terminated.has(session.identifier)));

  await mkdir(dirname(mutagenRuntime.projectFile), { recursive: true });
  const canResumeProject = isEquivalentMutagenProject(existingProject, desiredProject);
  let resumed = false;
  if (canResumeProject) {
    if (retainedTargets.length === 0) {
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
        env: mutagenRuntime.env,
      });
    }
    resumed = targets.every(target => (
      parseMutagenSyncList(currentSessions, resolveMutagenSessionName(target.name, sourceDir)).state !== 'missing'
    ));
  }
  let projectCreated = false;
  if (!resumed) {
    // These one-way source replicas can be reconstructed from the controller.
    // Mutagen terminates by the existing project id, without a remote flush;
    // requiring one would prevent policy repair for an offline replica.
    const termination = await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    if (projectId) requireSuccessful(termination, 'Mutagen project termination');
    await writeFile(mutagenRuntime.projectFile, desiredProject, 'utf8');
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('start', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'Mutagen project start');
    projectCreated = true;
  } else {
    await writeFile(mutagenRuntime.projectFile, desiredProject, 'utf8');
  }
  if (projectCreated) {
    const activePeers = retainedTargets.filter(target => sessions.some(session => (
      session.name === resolveMutagenSessionName(target.name, sourceDir) && session.paused === false
    )));
    const restored = await Promise.allSettled(activePeers.map(target => (
      resumeDevTargetSync({ target, env: mutagenRuntime.env }, { runProcess })
    )));
    restored.forEach((result, index) => {
      if (result.status === 'rejected') process.stderr.write(`[dev-targets] ${activePeers[index].name} existing mirror resume failed\n`);
    });
  }
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
    env: mutagenRuntime.env,
  }), 'Mutagen project status');

  return {
    ...mutagenRuntime,
    openSsh,
    ownership: candidateProducer ? 'owned' : 'independent',
    projectCreated,
    release: async () => {},
  };
}

export async function ensureDevTargetSyncProject(input, dependencies = {}) {
  const withProjectLifecycleLock = dependencies.withProjectLifecycleLock
    ?? withDevTargetSyncProjectLifecycleLock;
  return await withProjectLifecycleLock({
    stackBaseDir: input.stackBaseDir,
    sourceDir: input.sourceDir,
    env: input.env ?? process.env,
  }, async () => await ensureDevTargetSyncProjectUnlocked(input, {
    ...dependencies,
    withProjectLifecycleLock,
  }));
}

// Standby and worker replicas share the same daemon, lifecycle lock and SSH
// preparation. A distinct project declares the whole-home endpoint rather
// than changing ordinary worker exclusions or creating another sync owner.
export async function ensurePrimaryStandbySync(
  { stackBaseDir, sourceDir, profile, env = process.env },
  { runProcess: runBoundary = runDevTargetControlProcess } = {},
) {
  // Remote inventory/capture output is evidence, not user-visible output. Keep
  // --json pure and do not project unrelated transports or private home paths.
  const runProcess = input => runBoundary({ ...input, label: '' });
  const { HAPPIER_STACK_PROCESS_KIND: _stackProcessKind, ...mutagenControlEnv } = env;
  const source = sourceDir || profile.workspaces?.[0]?.guestDir;
  const desired = renderMutagenProject({ sourceDir: source, targets: [], standby: profile,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  return await withDevTargetSyncProjectLifecycleLock({ stackBaseDir, sourceDir: source, env }, async () => {
    const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir: source, env: mutagenControlEnv });
    const openSsh = await prepareDevTargetOpenSsh({ targets: profile.scopeDir ? [profile.standby] : [profile, profile.standby], mutagenDir: runtime.mutagenDir, env: mutagenControlEnv });
    const controlEnv = { ...runtime.env, ...openSsh.mutagenEnv,
      MUTAGEN_DATA_DIRECTORY: runtime.dataDir };
    const projectFile = join(dirname(runtime.projectFile), 'primary-standby.yml');
    const sessionName = resolvePrimaryStandbySessionName(source);
    const sessionNames = profile.scopeDir ? [sessionName] : resolvePrimaryStandbySessionNames(source);
    if (profile.scopeDir) {
      const listed = await runProcess({ command: 'mutagen', args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: controlEnv });
      requireSuccessful(listed, 'scoped standby inventory');
      for (const session of JSON.parse(listed.out || '[]')) {
        if (session.name === sessionName) continue;
        const writers = String(session.mode).startsWith('one-way-') ? [session.beta] : [session.alpha, session.beta];
        for (const endpoint of writers) {
          const url = endpoint?.url ?? endpoint;
          const path = String(url?.path ?? '').replace(/\/+$/u, '');
          if (url?.host === mutagenSshHost(profile.standby.ssh)
            && (path === source || path.startsWith(`${source}/`) || source.startsWith(`${path}/`))) {
            throw new Error('[dev-targets] STANDBY_SYNC_OVERLAP: scoped standby competes with an existing writer');
          }
        }
      }
      const existing = await readFile(projectFile, 'utf8').catch(() => null);
      if (existing && !isEquivalentMutagenProject(existing, desired)) {
        const endpoints = contents => String(contents).split('\n').filter(line => /^    (alpha|beta): /.test(line)).join('\n');
        if (endpoints(existing) !== endpoints(desired)) {
          throw new Error('[dev-targets] scoped standby endpoints changed; settle the existing project first');
        }
        requireSuccessful(await runProcess({ command: 'mutagen', args: buildMutagenProjectArgs('pause', projectFile), env: controlEnv }), 'scoped standby policy pause');
        requireSuccessful(await runProcess({ command: 'mutagen', args: buildMutagenProjectArgs('terminate', projectFile), env: controlEnv }), 'scoped standby policy replacement');
      }
      await mkdir(dirname(projectFile), { recursive: true });
      await writeFile(projectFile, desired, { mode: 0o600 });
      if (!isEquivalentMutagenProject(existing, desired) || parseMutagenSyncList(listed.out, sessionName).state === 'missing') {
        requireSuccessful(await runProcess({ command: 'mutagen', args: buildMutagenProjectArgs('start', projectFile), env: controlEnv }), 'scoped standby start');
      }
      requireSuccessful(await runProcess({ command: 'mutagen', args: buildMutagenProjectArgs('resume', projectFile), env: controlEnv }), 'scoped standby resume');
      requireSuccessful(await runProcess({ command: 'mutagen', args: ['sync', 'flush', sessionName], syncFlushSession: sessionName, env: controlEnv }), 'scoped standby flush');
      const final = await runProcess({ command: 'mutagen', args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: controlEnv });
      requireSuccessful(final, 'scoped standby final status');
      const state = parseMutagenSyncList(final.out, sessionName).state;
      if (state !== 'ready') throw new Error(`[dev-targets] STANDBY_NOT_READY: ${state}`);
      return { state, projectFile, sessionName, sourceDir: source, target: profile.standby.name,
        agentSqliteCapturedAt: null, database: { state: 'unverified', lastReplicaAt: null } };
    }
    const script = await readFile(new URL('../execution_host/guest_backup.py', import.meta.url), 'utf8');
    const peerHomes = await Promise.all([profile, profile.standby].map(async peer => {
      const checked = await runProcess({ label: 'standby preflight', command: 'ssh', env: controlEnv,
        args: [...openSsh.sshArgs, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-T', peer.ssh,
          `python3 -c ${shellQuote(script)} inspect-home`] });
      requireSuccessful(checked, 'standby fresh SSH/home preflight');
      const home = JSON.parse(checked.out);
      if (home.homeDir !== peer.homeDir || !home.user || !Number.isSafeInteger(home.requiredBytes)
        || !Number.isSafeInteger(home.availableBytes) || home.requiredBytes < 0 || home.availableBytes < 0) {
        throw new Error('[dev-targets] STANDBY_PATH_PARITY: declared home differs from fresh authenticated home');
      }
      return home;
    }));
    if (peerHomes[0].user !== peerHomes[1].user) throw new Error('[dev-targets] STANDBY_PATH_PARITY: different users');
    if (peerHomes[1].availableBytes < peerHomes[0].requiredBytes) {
      throw new Error('[dev-targets] STANDBY_CAPACITY: target cannot hold the declared home');
    }
    const listed = await runProcess({ label: 'standby', command: 'mutagen',
      args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: controlEnv });
    requireSuccessful(listed, 'standby session inventory');
    const sessions = JSON.parse(listed.out || '[]');
    for (const session of sessions) {
      if (sessionNames.includes(session.name)) continue;
      const writers = String(session.mode).startsWith('one-way-') ? [session.beta] : [session.alpha, session.beta];
      for (const endpoint of writers) {
        const url = endpoint?.url ?? endpoint;
        const endpointPath = String(url?.path ?? '').replace(/\/+$/u, '');
        const host = String(url?.host ?? '');
        // One-way standby must never compete with an ordinary worker writer.
        if (host && [profile, profile.standby].some(peer =>
          mutagenSshHost(peer.ssh) === host && (endpointPath === peer.homeDir
            || endpointPath.startsWith(`${peer.homeDir}/`)))) {
          throw new Error('[dev-targets] STANDBY_SYNC_OVERLAP: pause/remove the existing worker replica before declaring its home a standby');
        }
      }
    }
    const captured = await runProcess({ label: 'standby SQLite', command: 'ssh', env: controlEnv,
      args: [...openSsh.sshArgs, '-o', 'BatchMode=yes', '-T', profile.ssh,
        `python3 -c ${shellQuote(script)} capture-agents ${shellQuote(profile.homeDir)}`] });
    requireSuccessful(captured, 'consistent Agent SQLite capture');
    const capture = JSON.parse(captured.out);
    if (capture.format !== 1 || !Array.isArray(capture.paths) || !Number.isFinite(Date.parse(capture.capturedAt))) {
      throw new Error('[dev-targets] invalid Agent SQLite capture result');
    }
    const existing = await readFile(projectFile, 'utf8').catch(() => null);
    if (existing && !isEquivalentMutagenProject(existing, desired)) {
      // A direction change is not a merge: settle the old producer before
      // terminating exactly its project, never all worker sessions.
      const endpoints = contents => String(contents).split('\n').filter(line => /^    (alpha|beta): /.test(line)).slice(0, 2).join('\n');
      if (endpoints(existing) !== endpoints(desired)) {
        requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
          args: buildMutagenProjectArgs('flush', projectFile) }), 'old standby final flush');
      } else {
        // Policy correction retains the same source of truth. Pausing permits
        // an exclusion fix even when the old policy itself caused a conflict.
        requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
          args: buildMutagenProjectArgs('pause', projectFile) }), 'standby policy pause');
      }
      requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
        args: buildMutagenProjectArgs('terminate', projectFile) }), 'old standby project termination');
    }
    await mkdir(dirname(projectFile), { recursive: true });
    await writeFile(projectFile, desired, { mode: 0o600 });
    if (!existing || !isEquivalentMutagenProject(existing, desired)
      || sessionNames.some(name => parseMutagenSyncList(listed.out, name).state === 'missing')) {
      requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
        args: buildMutagenProjectArgs('start', projectFile) }), 'standby project start');
    }
    requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
      args: buildMutagenProjectArgs('resume', projectFile) }), 'standby resume');
    for (const name of sessionNames) {
      requireSuccessful(await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
        args: ['sync', 'flush', name], syncFlushSession: name }), 'standby flush');
      const final = await runProcess({ label: 'standby', command: 'mutagen', env: controlEnv,
        args: ['sync', 'list', name, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE] });
      requireSuccessful(final, 'standby final status');
      const readiness = parseMutagenSyncList(final.out, name);
      if (readiness.state !== 'ready') throw new Error(`[dev-targets] STANDBY_NOT_READY: ${readiness.state}`);
    }
    return { state: 'ready', projectFile, sessionName, source: profile.name ?? null, target: profile.standby.name ?? null,
      agentSqliteCapturedAt: capture.capturedAt, agentSqliteCount: capture.paths.length,
      database: { state: 'unverified', lastReplicaAt: null } };
  });
}

export async function inspectPrimaryStandbySync(
  { stackBaseDir, sourceDir, target, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  const result = await runProcess({ label: '', command: 'mutagen', env: runtime.env,
    args: ['sync', 'list', ...resolvePrimaryStandbySessionNames(sourceDir), '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE] });
  requireSuccessful(result, 'standby status');
  const states = resolvePrimaryStandbySessionNames(sourceDir).map(name => parseMutagenSyncList(result.out, name).state);
  const state = states.find(value => value !== 'ready') ?? 'ready';
  const script = await readFile(new URL('../execution_host/guest_backup.py', import.meta.url), 'utf8');
  const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir, env });
  const capture = await runProcess({ label: '', command: 'ssh', env: runtime.env,
    args: [...(sshConfigFile ? ['-F', sshConfigFile] : []), '-o', 'BatchMode=yes', '-T', target.ssh,
      `python3 -c ${shellQuote(script)} capture-status`] });
  requireSuccessful(capture, 'Agent capture freshness');
  const metadata = JSON.parse(capture.out);
  if (metadata.capturedAt !== null && !Number.isFinite(Date.parse(metadata.capturedAt))) {
    throw new Error('[dev-targets] invalid capture freshness');
  }
  return { state, syncLag: null, agentSqliteCapturedAt: metadata.capturedAt,
    agentSqliteCount: metadata.agentSqliteCount };
}

async function releaseIndependentDevTargetSyncProjectUnlocked(
  { stackBaseDir, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const contents = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  if (!isMutagenProjectOwnedBy(contents, INDEPENDENT_DEV_TARGET_SYNC_OWNER)) return false;
  const releasedContents = withoutMutagenProjectOwner(contents);
  await writeFile(runtime.projectFile, releasedContents, 'utf8');
  const result = await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('pause', runtime.projectFile),
    env: runtime.env,
  });
  try {
    requireSuccessful(result, 'independent Mutagen project pause');
  } catch (error) {
    const current = await readFile(runtime.projectFile, 'utf8').catch(() => null);
    if (current === releasedContents) await writeFile(runtime.projectFile, contents, 'utf8');
    throw error;
  }
  return true;
}

export async function releaseIndependentDevTargetSyncProject(input, dependencies = {}) {
  const env = input.env ?? process.env;
  // Readiness may default to the routing producer, but destructive release
  // must carry its source scope before even resolving the lifecycle lock.
  if (typeof env.HAPPIER_STACK_SYNC_SOURCE_DIR !== 'string'
    || !isAbsolute(env.HAPPIER_STACK_SYNC_SOURCE_DIR)) {
    throw new Error('[dev-targets] HAPPIER_STACK_SYNC_SOURCE_DIR must be an explicit absolute path to release synchronization');
  }
  const withProjectLifecycleLock = dependencies.withProjectLifecycleLock
    ?? withDevTargetSyncProjectLifecycleLock;
  return await withProjectLifecycleLock({
    stackBaseDir: input.stackBaseDir,
    env,
  }, async () => await releaseIndependentDevTargetSyncProjectUnlocked(input, dependencies));
}

async function pauseOwnedDevTargetSyncProjectUnlocked(
  { stackBaseDir, sourceDir, ownerId, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, ownerId, env });
  const contents = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  if (!isMutagenProjectOwnedBy(contents, ownerId)) return false;
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('pause', runtime.projectFile),
    env: runtime.env,
  }), 'owned Mutagen project pause');
  return true;
}

export async function pauseOwnedDevTargetSyncProject(input, dependencies = {}) {
  const withProjectLifecycleLock = dependencies.withProjectLifecycleLock
    ?? withDevTargetSyncProjectLifecycleLock;
  return await withProjectLifecycleLock({
    stackBaseDir: input.stackBaseDir,
    sourceDir: input.sourceDir,
    env: input.env ?? process.env,
  }, async () => await pauseOwnedDevTargetSyncProjectUnlocked(input, dependencies));
}
