import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { loadDevTargetsConfig } from './config.mjs';
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
const DEV_TARGET_SYNC_PROJECT_LIFECYCLE_LOCK_TIMEOUT_MS = 30_000;
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

export async function runDevTargetControlProcess({ label, command, args, env, syncFlushSession = null }) {
  const launch = buildDevTargetControlLaunch({ command, args, syncFlushSession });
  const result = await runCaptureResult(launch.command, launch.args, { env, streamLabel: label });
  return { ...result, code: result.exitCode };
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

async function withDevTargetSyncProjectLifecycleLock(
  { stackBaseDir, env = process.env },
  fn,
) {
  const { projectFile } = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  return await withJsonOwnerFileLock(fn, {
    // Use the same short, bounded mutation window as Stack runtime state. A
    // background supervisor can retry a busy project, but it must not race a
    // sync-service start, stop, or another project lifecycle operation.
    lockPath: `${projectFile}.hstack-lifecycle.lock`,
    timeoutMs: DEV_TARGET_SYNC_PROJECT_LIFECYCLE_LOCK_TIMEOUT_MS,
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
    const sessionName = resolveMutagenSessionName(target.name);
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
    syncFlushSession: resolveMutagenSessionName(target.name),
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
    withProjectLifecycleLock = withDevTargetSyncProjectLifecycleLock,
  } = {},
) {
  const {
    HAPPIER_STACK_PROCESS_KIND: _stackProcessKind,
    ...mutagenControlEnv
  } = env;
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env: mutagenControlEnv });
  if (borrowOnly) {
    const project = await readFile(runtime.projectFile, 'utf8').catch(() => null);
    if (!project) throw new Error('[dev-targets] controlled runtime requires the producer synchronization; run hstack dev-targets sync-service start --detached');
    const sshArgs = targets.some(target => target.sshConfigFile)
      ? ['-F', join(runtime.opensshDir, 'config')]
      : [];
    const unhealthyTargets = await inspectBorrowedIndependentDevTargetSyncProject({ requiredTargets, mutagenRuntime: runtime }, { runProcess });
    return { ...runtime, openSsh: { sshArgs, mutagenEnv: runtime.env }, ownership: 'borrowed',
      unhealthyTargets, projectCreated: false, release: async () => {} };
  }
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
    config: (await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json') })).config,
    ownerId: borrowingIndependentProject ? INDEPENDENT_DEV_TARGET_SYNC_OWNER : ownerId,
  });

  if (
    borrowingIndependentProject
    && isEquivalentMutagenProject(existingProject, desiredProject)
  ) {
    const unhealthyTargets = await inspectBorrowedIndependentDevTargetSyncProject(
      { requiredTargets, mutagenRuntime },
      { runProcess },
    );
    return {
      ...mutagenRuntime,
      openSsh,
      ownership: 'independent',
      unhealthyTargets,
      projectCreated: false,
      release: async () => {},
    };
  }
  if (borrowingIndependentProject) {
    const current = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
    if (!isMutagenProjectOwnedBy(current, INDEPENDENT_DEV_TARGET_SYNC_OWNER)) {
      throw new Error(
        '[dev-targets] independent synchronization ownership changed during Stack startup; '
          + 'refusing destructive project replacement',
      );
    }
    // Mutagen reports a non-running project as a terminate failure. Preserve
    // the existing best-effort teardown: start, resume, and status decide
    // whether the desired project can actually be recreated.
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    });
    const currentAfterTermination = await readFile(
      mutagenRuntime.projectFile,
      'utf8',
    ).catch(() => null);
    if (!isMutagenProjectOwnedBy(currentAfterTermination, INDEPENDENT_DEV_TARGET_SYNC_OWNER)) {
      throw new Error(
        '[dev-targets] independent synchronization ownership changed during Stack startup; '
          + 'refusing destructive project replacement',
      );
    }
    await writeFile(mutagenRuntime.projectFile, desiredProject, 'utf8');
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('start', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'Mutagen project start');
    requireSuccessful(await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('resume', mutagenRuntime.projectFile),
      env: mutagenRuntime.env,
    }), 'Mutagen project resume');
    const unhealthyTargets = await inspectBorrowedIndependentDevTargetSyncProject(
      { requiredTargets, mutagenRuntime },
      { runProcess },
    );
    return {
      ...mutagenRuntime,
      openSsh,
      ownership: 'independent',
      unhealthyTargets,
      projectCreated: true,
      release: async () => {},
    };
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
      return await withProjectLifecycleLock({ stackBaseDir, env: mutagenRuntime.env }, async () => {
        const current = await readFile(mutagenRuntime.projectFile, 'utf8').catch(() => null);
        if (!isMutagenProjectOwnedBy(current, ownerId)) return;
        await runProcess({
          label: 'mutagen',
          command: 'mutagen',
          args: buildMutagenProjectArgs(action, mutagenRuntime.projectFile),
          env: mutagenRuntime.env,
        });
      });
    },
  };
}

export async function ensureDevTargetSyncProject(input, dependencies = {}) {
  const withProjectLifecycleLock = dependencies.withProjectLifecycleLock
    ?? withDevTargetSyncProjectLifecycleLock;
  return await withProjectLifecycleLock({
    stackBaseDir: input.stackBaseDir,
    env: input.env ?? process.env,
  }, async () => await ensureDevTargetSyncProjectUnlocked(input, {
    ...dependencies,
    withProjectLifecycleLock,
  }));
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
