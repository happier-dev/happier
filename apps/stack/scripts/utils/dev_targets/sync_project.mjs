import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { runDevTargetSshProcess } from './ssh_transport.mjs';
import { loadDevTargetsConfig } from './config.mjs';
import {
  buildMutagenProjectArgs,
  isEquivalentMutagenProject,
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
  return await runDevTargetSshProcess(input, async ({ label, command, args, env, syncFlushSession = null }) => {
    const launch = buildDevTargetControlLaunch({ command, args, syncFlushSession });
    const result = await capture(launch.command, launch.args, { env, streamLabel: label });
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
    requireSuccessful(result, `${target.name} independent synchronization status`);
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
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env: mutagenControlEnv });
  // Only the routing/sync owner creates sessions. Stack supervisors consume
  // existing mirrors; their lifecycle must never own a daemon or project.
  if (borrowOnly || allowIndependentBorrow || ownerId !== INDEPENDENT_DEV_TARGET_SYNC_OWNER) {
    const project = await readFile(runtime.projectFile, 'utf8').catch(() => null);
    if (!project) throw new Error('[dev-targets] controlled runtime requires the producer synchronization; run hstack dev-targets sync-service start --detached');
    const unhealthyTargets = await inspectBorrowedIndependentDevTargetSyncProject({ requiredTargets, mutagenRuntime: runtime }, { runProcess });
    return { ...runtime, openSsh: { sshArgs: ['-F', join(runtime.opensshDir, 'config')], mutagenEnv: runtime.env }, ownership: 'borrowed',
      unhealthyTargets, projectCreated: false, release: async () => {} };
  }
  const openSsh = await prepareDevTargetOpenSsh({
    targets,
    mutagenDir: runtime.mutagenDir,
    env: mutagenControlEnv,
  });
  const mutagenRuntime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    sourceDir,
    env: openSsh.mutagenEnv,
  });
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: mutagenRuntime.env,
  }), 'Mutagen preflight');
  const existingProject = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
  const desiredProject = renderMutagenProject({
    sourceDir,
    targets,
    config: (await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json') })).config,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });

  await mkdir(dirname(mutagenRuntime.projectFile), { recursive: true });
  const canResumeProject = isEquivalentMutagenProject(existingProject, desiredProject);
  let resumed = false;
  if (canResumeProject) {
    const result = await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    resumed = result?.code === 0;
    if (ownerId === INDEPENDENT_DEV_TARGET_SYNC_OWNER) {
      const sessionResult = await runProcess({
        label: 'sync',
        command: 'mutagen',
        args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
        env: mutagenRuntime.env,
      });
      if (sessionResult?.code === 0) {
        resumed = targets.every((target) => (
          parseMutagenSyncList(
            sessionResult.out,
            resolveMutagenSessionName(target.name, sourceDir),
          ).state !== 'missing'
        ));
      }
    }
  }
  let projectCreated = false;
  if (!resumed) {
    if (existingProject && !canResumeProject) {
      // Flush the old membership before replacing its project file. Otherwise
      // terminate would select the new names and strand the old sessions.
      const names = [...existingProject.matchAll(/^  (happier-[A-Za-z0-9-]+):$/gm)].map(match => match[1]);
      const listed = await runProcess({ label: 'sync', command: 'mutagen',
        args: ['sync', 'list', '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env: mutagenRuntime.env });
      requireSuccessful(listed, 'existing Mutagen sessions before replacement');
      for (const name of names) {
        if (parseMutagenSyncList(listed.out, name).state === 'missing') continue;
        requireSuccessful(await runProcess({ label: 'sync', command: 'mutagen',
          args: ['sync', 'resume', name], env: mutagenRuntime.env }), 'existing Mutagen session resume');
        requireSuccessful(await runProcess({ label: 'sync', command: 'mutagen',
          args: ['sync', 'flush', name], syncFlushSession: name, env: mutagenRuntime.env }), 'existing Mutagen session flush');
      }
    }
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
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
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
    env: mutagenRuntime.env,
  }), 'Mutagen project status');

  return {
    ...mutagenRuntime,
    openSsh,
    ownership: 'independent',
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
          if (url?.host === profile.standby.ssh.split('@').at(-1)
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
          peer.ssh.split('@').at(-1) === host && (endpointPath === peer.homeDir
            || endpointPath.startsWith(`${peer.homeDir}/`)))) {
          throw new Error('[dev-targets] STANDBY_SYNC_OVERLAP: pause/remove the existing worker replica before declaring its home a standby');
        }
      }
    }
    const captured = await runProcess({ label: 'standby SQLite', command: 'ssh', env: controlEnv,
      args: [...openSsh.sshArgs, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-T', profile.ssh,
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
    args: [...(sshConfigFile ? ['-F', sshConfigFile] : []), '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-T', target.ssh,
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
  const withProjectLifecycleLock = dependencies.withProjectLifecycleLock
    ?? withDevTargetSyncProjectLifecycleLock;
  return await withProjectLifecycleLock({
    stackBaseDir: input.stackBaseDir,
    env: input.env ?? process.env,
  }, async () => await releaseIndependentDevTargetSyncProjectUnlocked(input, dependencies));
}

async function pauseOwnedDevTargetSyncProjectUnlocked(
  { stackBaseDir, ownerId, env = process.env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
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
    env: input.env ?? process.env,
  }, async () => await pauseOwnedDevTargetSyncProjectUnlocked(input, dependencies));
}
