import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runCaptureResult } from '../proc/proc.mjs';
import {
  buildMutagenProjectArgs,
  isEquivalentMutagenProject,
  isMutagenProjectOwnedBy,
  renderMutagenProject,
  resolveMutagenSessionName,
  withoutMutagenProjectOwner,
} from './mutagen_project.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';

export const INDEPENDENT_DEV_TARGET_SYNC_OWNER = 'dev-target-sync-service';
// The managed guest provisioner owns this unit and its MemoryLow=4G contract.
// Stack only verifies that published contract before placing a future control
// process in the existing slice.
const HAPPIER_CRITICAL_SLICE_NAME = 'happier-critical.slice';
const HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES = 4 * 1024 * 1024 * 1024;
const SYSTEMD_USER_CRITICAL_SCOPE_PROBE_TIMEOUT_MS = 1_000;

function hasSystemdUserBus(env) {
  return process.platform === 'linux'
    && String(env?.DBUS_SESSION_BUS_ADDRESS ?? '').trim().length > 0;
}

function parseSystemdProperties(raw) {
  const properties = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter <= 0) continue;
    properties.set(line.slice(0, delimiter).trim(), line.slice(delimiter + 1).trim());
  }
  return properties;
}

async function resolveDevTargetControlLaunch({ command, args, env }) {
  if (!hasSystemdUserBus(env)) return { command, args };

  try {
    const probe = await runCaptureResult('systemctl', [
      '--user',
      'show',
      HAPPIER_CRITICAL_SLICE_NAME,
      '--property=LoadState',
      '--property=MemoryLow',
    ], {
      env,
      timeoutMs: SYSTEMD_USER_CRITICAL_SCOPE_PROBE_TIMEOUT_MS,
    });
    const properties = parseSystemdProperties(probe.out);
    if (
      probe.exitCode !== 0
      || properties.get('LoadState') !== 'loaded'
      || properties.get('MemoryLow') !== String(HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES)
    ) {
      return { command, args };
    }
  } catch {
    return { command, args };
  }

  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      `--slice=${HAPPIER_CRITICAL_SLICE_NAME}`,
      '--',
      command,
      ...args,
    ],
  };
}

export async function runDevTargetControlProcess({ label, command, args, env }) {
  const launch = await resolveDevTargetControlLaunch({ command, args, env });
  const result = await runCaptureResult(launch.command, launch.args, { env, streamLabel: label });
  return { ...result, code: result.exitCode };
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

export async function resumeDevTargetSync(
  { target, env },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const result = await runProcess({
    label: `sync:${target.name}`,
    command: 'mutagen',
    args: ['sync', 'resume', resolveMutagenSessionName(target.name)],
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
    args: ['sync', 'flush', resolveMutagenSessionName(target.name)],
    env,
  });
  requireSuccessful(result, `${target.name} Mutagen initial flush`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export async function prepareDevTargetOpenSsh({ targets, mutagenDir, env }) {
  const customConfigs = [
    ...new Set(targets.map((target) => target.sshConfigFile).filter(Boolean)),
  ];
  if (customConfigs.length === 0) {
    return { sshArgs: [], mutagenEnv: env };
  }
  if (process.platform === 'win32') {
    throw new Error('[dev-targets] sshConfigFile is not yet supported on Windows Stack hosts');
  }

  const opensshDir = join(mutagenDir, 'openssh');
  const configPath = join(opensshDir, 'config');
  await mkdir(opensshDir, { recursive: true });
  await writeFile(
    configPath,
    [
      ...customConfigs.map((path) => `Include ${JSON.stringify(path)}`),
      `Include ${JSON.stringify(join(homedir(), '.ssh', 'config'))}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  for (const executable of ['ssh', 'scp']) {
    await writeFile(
      join(opensshDir, executable),
      `#!/bin/sh\nexec /usr/bin/${executable} -F ${shellQuote(configPath)} -o ControlMaster=no "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    sshArgs: ['-F', configPath, '-o', 'ControlMaster=no'],
    mutagenEnv: { ...env, MUTAGEN_SSH_PATH: opensshDir },
  };
}

export async function ensureDevTargetSyncProject(
  {
    stackBaseDir,
    sourceDir,
    targets,
    requiredTargets = targets,
    ownerId,
    allowIndependentBorrow,
    env = process.env,
  },
  { runProcess = runDevTargetControlProcess } = {},
) {
  const {
    HAPPIER_STACK_PROCESS_KIND: _stackProcessKind,
    ...mutagenControlEnv
  } = env;
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env: mutagenControlEnv });
  const openSsh = await prepareDevTargetOpenSsh({
    targets,
    mutagenDir: runtime.mutagenDir,
    env: mutagenControlEnv,
  });
  const mutagenRuntime = resolveDevTargetMutagenRuntime({
    stackBaseDir,
    env: openSsh.mutagenEnv,
  });
  requireSuccessful(await runProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: mutagenRuntime.env,
  }), 'Mutagen preflight');
  const existingProject = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
  const borrowingIndependentProject = Boolean(
    allowIndependentBorrow
    && isMutagenProjectOwnedBy(existingProject, INDEPENDENT_DEV_TARGET_SYNC_OWNER),
  );
  const desiredProject = renderMutagenProject({
    sourceDir,
    targets,
    ownerId: borrowingIndependentProject ? INDEPENDENT_DEV_TARGET_SYNC_OWNER : ownerId,
  });

  if (
    borrowingIndependentProject
    && isEquivalentMutagenProject(existingProject, desiredProject)
  ) {
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('list', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'independent Mutagen project status');
    for (const target of requiredTargets) {
      const sessionName = resolveMutagenSessionName(target.name);
      const result = await runProcess({
        label: `sync:${target.name}`,
        command: 'mutagen',
        args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
        env: mutagenRuntime.env,
      });
      requireSuccessful(result, `${target.name} independent synchronization status`);
      const status = parseMutagenSyncList(result.out, sessionName);
      if (status.state !== 'ready' && status.state !== 'synchronizing') {
        throw new Error(
          `[dev-targets] ${target.name} independent synchronization is ${status.state}`,
        );
      }
    }
    return {
      ...mutagenRuntime,
      openSsh,
      ownership: 'independent',
      projectCreated: false,
      release: async () => {},
    };
  }
  if (borrowingIndependentProject) {
    throw new Error(
      '[dev-targets] independent synchronization project configuration differs; '
        + 'the sync service must reconcile it before Stack startup can borrow it',
    );
  }

  await mkdir(mutagenRuntime.mutagenDir, { recursive: true });
  await writeFile(mutagenRuntime.projectFile, desiredProject, 'utf8');
  const canResumeProject = isEquivalentMutagenProject(existingProject, desiredProject);
  let resumed = false;
  if (canResumeProject) {
    let result = await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    resumed = result?.code === 0;
    if (!resumed && openSsh.sshArgs.length > 0) {
      requireSuccessful(await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: ['daemon', 'stop'],
        env: mutagenRuntime.env,
      }), 'Mutagen daemon restart');
      result = await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
        env: mutagenRuntime.env,
      });
      resumed = result?.code === 0;
    }
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
            resolveMutagenSessionName(target.name),
          ).state !== 'missing'
        ));
      }
    } else if (!resumed) {
      const sessionResults = await Promise.all(targets.map((target) => runProcess({
        label: `sync:${target.name}`,
        command: 'mutagen',
        args: [
          'sync',
          'list',
          resolveMutagenSessionName(target.name),
          '--template',
          MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
        ],
        env: mutagenRuntime.env,
      })));
      const sessionStates = sessionResults.map((sessionResult, index) => (
        sessionResult?.code === 0
          ? parseMutagenSyncList(
            sessionResult.out,
            resolveMutagenSessionName(targets[index].name),
          ).state
          : null
      ));
      resumed = !sessionStates.includes('missing')
        && sessionStates.every((state) => state !== null);
    }
  }
  let projectCreated = false;
  if (!resumed) {
    if (allowIndependentBorrow && ownerId !== INDEPENDENT_DEV_TARGET_SYNC_OWNER) {
      const current = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
      if (isMutagenProjectOwnedBy(current, INDEPENDENT_DEV_TARGET_SYNC_OWNER)) {
        throw new Error(
          '[dev-targets] independent synchronization ownership changed during Stack startup; '
            + 'refusing destructive project replacement',
        );
      }
    }
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('start', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'Mutagen project start');
    projectCreated = true;
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
    ownership: borrowingIndependentProject ? 'independent' : 'owned',
    projectCreated,
    async release(action) {
      if (borrowingIndependentProject) return;
      const current = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
      if (!isMutagenProjectOwnedBy(current, ownerId)) return;
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs(action, mutagenRuntime.projectFile),
        env: mutagenRuntime.env,
      });
    },
  };
}

export async function releaseIndependentDevTargetSyncProject(
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

export async function pauseOwnedDevTargetSyncProject(
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
