import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import {
  buildMutagenProjectArgs,
  isEquivalentMutagenProject,
  isMutagenProjectOwnedBy,
  renderMutagenProject,
  resolveMutagenSessionName,
} from './mutagen_project.mjs';
import {
  buildRemoteBootstrapCommand,
  buildRemoteDaemonCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteForwardProbeCommand,
  buildRemoteInstallCredentialCommand,
  buildSshTunnelArgs,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

export function resolveDefaultRemoteServerPort({
  localServerPort,
  targetIndex,
  instanceId = process.pid,
} = {}) {
  const local = Math.abs(Math.trunc(Number(localServerPort) || 0));
  const instance = Math.abs(Math.trunc(Number(instanceId) || 0));
  const index = Math.abs(Math.trunc(Number(targetIndex) || 0));
  return 40_000 + ((local + instance + (index * 997)) % 20_000);
}

async function defaultRunProcess({ label, command, args, env }) {
  const child = spawnProc(label, command, args, env);
  const result = await child.completion;
  return result;
}

function defaultSpawnProcess({ label, command, args, env }) {
  return spawnProc(label, command, args, env);
}

async function defaultStopProcess(child) {
  if (!child || child.exitCode != null) return;
  await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
}

async function defaultWaitForProcess(child) {
  if (child?.completion) return await child.completion;
  return await new Promise(() => {});
}

async function defaultWaitForRetry() {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  if (result?.error?.code === 'ENOENT') {
    throw new Error(
      `[dev-targets] ${description} failed because Mutagen was not found.\n` +
        'Install Mutagen locally and ensure `mutagen` is available on PATH, or remove this stack’s dev-targets.json.',
    );
  }
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

function remoteCredentialPaths(target, activeServerId, stackName) {
  const base = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  const stagedPath = `${base}/.access-key-${stackName}.tmp`;
  const finalPath = `${base}/servers/${activeServerId}/access.key`;
  return { stagedPath, finalPath };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function prepareOpenSsh({ targets, mutagenDir, env }) {
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
      `Include ${JSON.stringify(join(homedir(), '.ssh', 'config'))}`,
      ...customConfigs.map((path) => `Include ${JSON.stringify(path)}`),
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

export async function startStackDevTargets(
  {
    stackName,
    stackBaseDir,
    sourceDir,
    localServerPort,
    activeServerId,
    credentialPath,
    targets,
    env = process.env,
    instanceId = process.pid,
  },
  {
    runProcess = defaultRunProcess,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    waitForProcess = defaultWaitForProcess,
    waitForRetry = defaultWaitForRetry,
    logger = console,
  } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { workers: [], close: async () => {} };
  }
  if (!credentialPath) {
    throw new Error(
      '[dev-targets] the local stack has no daemon credential to seed remotely; authenticate the local daemon first',
    );
  }

  const mutagenDir = join(stackBaseDir, 'mutagen');
  const mutagenDataDir = join(mutagenDir, 'data');
  const projectFile = join(mutagenDir, 'mutagen.yml');
  const openSsh = await prepareOpenSsh({ targets, mutagenDir, env });
  const mutagenEnv = {
    ...openSsh.mutagenEnv,
    MUTAGEN_DATA_DIRECTORY: mutagenDataDir,
    MUTAGEN_SSH_CONNECT_TIMEOUT: String(env.MUTAGEN_SSH_CONNECT_TIMEOUT ?? '10'),
  };
  await mkdir(mutagenDataDir, { recursive: true });

  const workersByTarget = new Map();
  const tunnelsByTarget = new Map();
  const targetFailuresByTarget = new Map();
  const lifecycleTasks = [];
  let monitorWorker = null;
  let projectStarted = false;
  let projectCreated = false;
  let closed = false;
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  const releaseProjectIfOwned = async (action) => {
    const contents = await readFile(projectFile, 'utf8').catch(() => null);
    if (!isMutagenProjectOwnedBy(contents, instanceId)) return;
    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs(action, projectFile),
      env: mutagenEnv,
    });
  };
  try {
    requireSuccessful(
      await runProcess({ label: 'mutagen', command: 'mutagen', args: ['version'], env: mutagenEnv }),
      'Mutagen preflight',
    );

    const desiredProject = renderMutagenProject({ sourceDir, targets, ownerId: instanceId });
    const existingProject = await readFile(projectFile, 'utf8').catch(() => null);
    const canResumeProject = isEquivalentMutagenProject(existingProject, desiredProject);
    await writeFile(projectFile, desiredProject, 'utf8');

    let resumedProject = false;
    if (canResumeProject) {
      const resumeResult = await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('resume', projectFile),
        env: mutagenEnv,
      });
      resumedProject = resumeResult?.code === 0;
    }
    if (!resumedProject) {
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('terminate', projectFile),
        env: mutagenEnv,
      });
      requireSuccessful(
        await runProcess({
          label: 'mutagen',
          command: 'mutagen',
          args: buildMutagenProjectArgs('start', projectFile),
          env: mutagenEnv,
        }),
        'Mutagen project start',
      );
      projectCreated = true;
    }
    projectStarted = true;
    requireSuccessful(
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('list', projectFile),
        env: mutagenEnv,
      }),
      'Mutagen project status',
    );
    monitorWorker = spawnProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: [
        'sync',
        'monitor',
        '--long',
        ...targets.map((target) => resolveMutagenSessionName(target.name)),
      ],
      env: mutagenEnv,
    });

    const startTarget = async (target, index) => {
      let phase = 'prepare';
      let tunnel = null;
      try {
        if (target.limaInstance) {
          requireSuccessful(
            await runProcess({
              label: `remote:${target.name}`,
              command: 'limactl',
              args: ['start', target.limaInstance],
              env: { ...env, LIMA_HOME: target.limaHome },
            }),
            `${target.name} Lima startup`,
          );
        }
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              target.ssh,
              buildRemoteEnsureDirectoriesCommand(target),
            ],
            env,
          }),
          `${target.name} directory bootstrap`,
        );
        phase = 'sync';
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'mutagen',
            args: ['sync', 'resume', resolveMutagenSessionName(target.name)],
            env: mutagenEnv,
          }),
          `${target.name} Mutagen resume`,
        );
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'mutagen',
            args: ['sync', 'flush', resolveMutagenSessionName(target.name)],
            env: mutagenEnv,
          }),
          `${target.name} Mutagen initial flush`,
        );
        phase = 'bootstrap';
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              target.ssh,
              buildRemoteBootstrapCommand(target),
            ],
            env,
          }),
          `${target.name} dependency bootstrap`,
        );

        const { stagedPath, finalPath } = remoteCredentialPaths(target, activeServerId, stackName);
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'scp',
            args: [
              '-q',
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              credentialPath,
              `${target.ssh}:${stagedPath}`,
            ],
            env,
          }),
          `${target.name} credential transfer`,
        );
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              '-o',
              'BatchMode=yes',
              ...openSsh.sshArgs,
              target.ssh,
              buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }),
            ],
            env,
          }),
          `${target.name} credential installation`,
        );

        if (closed) return null;
        const remoteServerPort =
          target.remoteServerPort ?? resolveDefaultRemoteServerPort({
            localServerPort,
            targetIndex: index,
            instanceId,
          });
        const remoteCommand = buildRemoteDaemonCommand(target, {
          serverUrl: `http://127.0.0.1:${remoteServerPort}`,
          activeServerId,
          stackName,
        });
        phase = 'tunnel';
        tunnel = spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshTunnelArgs(target, {
            localServerPort,
            remoteServerPort,
            sshArgs: openSsh.sshArgs,
          }),
          env,
        });
        tunnelsByTarget.set(target.name, tunnel);
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              target.ssh,
              buildRemoteForwardProbeCommand(target, { remoteServerPort }),
            ],
            env,
          }),
          `${target.name} reverse tunnel readiness`,
        );
        phase = 'worker';
        const worker = spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshWorkerArgs(target, {
            remoteCommand,
            sshArgs: openSsh.sshArgs,
          }),
          env,
        });
        workersByTarget.set(target.name, worker);
        targetFailuresByTarget.delete(target.name);
        return worker;
      } catch (error) {
        if (tunnel) {
          if (tunnelsByTarget.get(target.name) === tunnel) {
            tunnelsByTarget.delete(target.name);
          }
          await stopProcess(tunnel).catch(() => {});
        }
        targetFailuresByTarget.set(target.name, { name: target.name, phase, error });
        logger.error?.(
          `[dev-targets] ${target.name} ${phase} failed; continuing with other targets: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    };

    const startTargetLifecycle = (target, index, initialWorker, initialTunnel) => {
      lifecycleTasks.push((async () => {
        let worker = initialWorker;
        let tunnel = initialTunnel;
        while (!closed) {
          if (worker && tunnel) {
            const outcome = await Promise.race([
              waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result })),
              waitForProcess(tunnel).then((result) => ({ kind: 'tunnel-exit', result })),
              closeRequested.then(() => ({ kind: 'close' })),
            ]);
            if (outcome.kind === 'close' || closed) return;

            if (workersByTarget.get(target.name) === worker) {
              workersByTarget.delete(target.name);
            }
            if (tunnelsByTarget.get(target.name) === tunnel) {
              tunnelsByTarget.delete(target.name);
            }
            await Promise.allSettled([
              stopProcess(worker),
              stopProcess(tunnel),
            ]);
            const code = String(outcome.result?.code ?? 'unknown');
            targetFailuresByTarget.set(target.name, {
              name: target.name,
              phase: outcome.kind === 'tunnel-exit' ? 'tunnel' : 'worker',
              error: new Error(`${target.name} remote ${outcome.kind} (code=${code})`),
            });
            logger.error?.(
              `[dev-targets] ${target.name} remote ${outcome.kind} (code=${code}); retrying target lifecycle`,
            );
            worker = null;
            tunnel = null;
          }

          while (!closed) {
            const retryOutcome = await Promise.race([
              waitForRetry().then(() => 'retry'),
              closeRequested.then(() => 'close'),
            ]);
            if (retryOutcome === 'close' || closed) return;
            worker = await startTarget(target, index);
            tunnel = tunnelsByTarget.get(target.name) ?? null;
            if (worker && tunnel) break;
          }
        }
      })());
    };

    const syncFailedTargets = [];
    await Promise.all(targets.map(async (target, index) => {
      const initialWorker = await startTarget(target, index);
      const initialTunnel = tunnelsByTarget.get(target.name) ?? null;
      const initialFailure = targetFailuresByTarget.get(target.name);
      if (!initialWorker && initialFailure?.phase === 'sync') {
        syncFailedTargets.push({ target, index, initialWorker, initialTunnel });
        return;
      }
      startTargetLifecycle(target, index, initialWorker, initialTunnel);
    }));
    if (
      workersByTarget.size === 0
      && targetFailuresByTarget.size > 0
      && [...targetFailuresByTarget.values()].every(({ phase }) => phase === 'sync')
    ) {
      throw [...targetFailuresByTarget.values()].at(-1).error;
    }
    for (const { target, index, initialWorker, initialTunnel } of syncFailedTargets) {
      startTargetLifecycle(target, index, initialWorker, initialTunnel);
    }

    return {
      get workers() {
        return [...workersByTarget.values()];
      },
      projectFile,
      get targetFailures() {
        return [...targetFailuresByTarget.values()];
      },
      async close() {
        if (closed) return;
        closed = true;
        resolveCloseRequested();
        for (const worker of workersByTarget.values()) {
          await stopProcess(worker);
        }
        for (const tunnel of tunnelsByTarget.values()) {
          await stopProcess(tunnel);
        }
        await Promise.allSettled(lifecycleTasks);
        await stopProcess(monitorWorker);
        await releaseProjectIfOwned('pause');
      },
    };
  } catch (error) {
    closed = true;
    resolveCloseRequested();
    for (const worker of workersByTarget.values()) {
      await stopProcess(worker).catch(() => {});
    }
    for (const tunnel of tunnelsByTarget.values()) {
      await stopProcess(tunnel).catch(() => {});
    }
    await stopProcess(monitorWorker).catch(() => {});
    if (projectStarted) {
      await releaseProjectIfOwned(projectCreated ? 'terminate' : 'pause').catch(() => {});
    }
    throw error;
  }
}

export function startStackDevTargetsInBackground(
  options,
  {
    startStackDevTargetsImpl = startStackDevTargets,
    logger = console,
  } = {},
) {
  let activeController = null;
  let closing = false;
  let closedByReady = false;
  const ready = Promise.resolve()
    .then(() => startStackDevTargetsImpl(options))
    .then(async (controller) => {
      activeController = controller;
      if (closing) {
        await activeController?.close?.();
        closedByReady = true;
      }
      return controller;
    })
    .catch((error) => {
      logger.error?.(
        `[dev-targets] startup failed; local Stack remains available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    });

  return {
    ready,
    async close() {
      if (closing) return;
      closing = true;
      const controller = activeController ?? await ready;
      if (controller && controller !== activeController) {
        activeController = controller;
      }
      if (!closedByReady) {
        await activeController?.close?.();
        closedByReady = true;
      }
    },
  };
}
