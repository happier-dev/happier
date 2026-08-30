import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { fetchHappierHealth } from '../server/server.mjs';
import {
  buildMutagenProjectArgs,
  isEquivalentMutagenProject,
  isMutagenProjectOwnedBy,
  renderMutagenProject,
  resolveMutagenSessionName,
} from './mutagen_project.mjs';
import {
  buildRemoteBootstrapCommand,
  buildRemoteStackCommand,
  buildRemoteStackStopCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteForwardProbeCommand,
  buildRemoteInstallCredentialCommand,
  buildSshForwardArgs,
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

export function resolveDefaultRemoteExpoPort({
  localExpoPort,
  targetIndex,
  instanceId = process.pid,
} = {}) {
  const local = Math.abs(Math.trunc(Number(localExpoPort) || 0));
  const instance = Math.abs(Math.trunc(Number(instanceId) || 0));
  const index = Math.abs(Math.trunc(Number(targetIndex) || 0));
  return 20_000 + ((local + instance + (index * 577)) % 20_000);
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

async function defaultWaitForServerReady({ url, env = process.env, signal } = {}) {
  const configured = Number.parseInt(String(env.HAPPIER_STACK_SERVER_READY_TIMEOUT_MS ?? ''), 10);
  const timeoutMs = Number.isFinite(configured) && configured >= 1_000 ? configured : 120_000;
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    if ((await fetchHappierHealth(url)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (signal?.aborted) throw new Error('[dev-targets] remote server readiness cancelled');
  throw new Error(`[dev-targets] remote server did not become ready at ${url}`);
}

function resolveRetryDelayMs(attempt) {
  return Math.min(60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

async function defaultWaitForRetry({ delayMs }) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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

function planDefersRemoteCompanionPreparation(plan) {
  return plan?.services?.server === true
    && (plan.services.expo === true || plan.services.daemon === true);
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
    localExpoPort = null,
    activeServerId,
    credentialPath,
    targets = [],
    targetPlans = null,
    syncTargets = null,
    publicServerUrl = '',
    expoPublicUrl = '',
    resolveMobilePublicUrlsOnTarget = false,
    expoListenHost = '127.0.0.1',
    startMobile = false,
    remoteServerRuntimeConfig = null,
    onTargetStateChange = null,
    env = process.env,
    instanceId = process.pid,
  },
  {
    runProcess = defaultRunProcess,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    waitForProcess = defaultWaitForProcess,
    waitForServerReady = defaultWaitForServerReady,
    waitForRetry = defaultWaitForRetry,
    logger = console,
  } = {},
) {
  const plans = Array.isArray(targetPlans)
    ? targetPlans
    : (Array.isArray(targets) ? targets : []).map((target) => ({
        target,
        services: { server: false, expo: false, daemon: true },
      }));
  const synchronizedTargets = Array.isArray(syncTargets) && syncTargets.length > 0
    ? syncTargets
    : (Array.isArray(targets) && targets.length > 0 ? targets : plans.map((plan) => plan.target));
  if (plans.length === 0) {
    return { workers: [], close: async () => {} };
  }
  if (plans.some((plan) => plan.services.daemon) && !credentialPath) {
    throw new Error(
      '[dev-targets] the local stack has no daemon credential to seed remotely; authenticate the local daemon first',
    );
  }

  const infraEnv = {
    ...env,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const mutagenDir = join(stackBaseDir, 'mutagen');
  const mutagenDataDir = join(mutagenDir, 'data');
  const projectFile = join(mutagenDir, 'mutagen.yml');
  const openSsh = await prepareOpenSsh({ targets: synchronizedTargets, mutagenDir, env });
  const {
    HAPPIER_STACK_PROCESS_KIND: _inheritedStackProcessKind,
    ...mutagenServiceBaseEnv
  } = openSsh.mutagenEnv;
  const mutagenEnv = {
    ...mutagenServiceBaseEnv,
    MUTAGEN_DATA_DIRECTORY: mutagenDataDir,
    MUTAGEN_SSH_CONNECT_TIMEOUT: String(env.MUTAGEN_SSH_CONNECT_TIMEOUT ?? '10'),
  };
  const mutagenMonitorEnv = {
    ...mutagenEnv,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  await mkdir(mutagenDataDir, { recursive: true });

    const workersByTarget = new Map();
    const tunnelsByTarget = new Map();
    const servicePortsByTarget = new Map();
  const provisionedTargets = new Set();
  const deferredCompanionPreparationsByTarget = new Map();
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

    const desiredProject = renderMutagenProject({ sourceDir, targets: synchronizedTargets, ownerId: instanceId });
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
        ...synchronizedTargets.map((target) => resolveMutagenSessionName(target.name)),
      ],
      env: mutagenMonitorEnv,
    });

    const publishTargetState = (plan, status, detail = {}) => {
      const servicePorts = servicePortsByTarget.get(plan.target.name);
      const serviceStatus = Object.fromEntries(
        Object.entries(plan.services)
          .filter(([, enabled]) => enabled)
          .map(([service]) => [service, status === 'running' ? 'running' : 'starting']),
      );
      onTargetStateChange?.({
        name: plan.target.name,
        status,
        services: plan.services,
        ...(servicePorts && Object.keys(servicePorts).length > 0
          ? { repoDir: plan.target.repoDir, servicePorts }
          : {}),
        serviceStatus,
        ...(status === 'running' ? { phase: null, error: null } : {}),
        ...detail,
      });
    };

    const startTarget = async (plan, index, existingTunnel = null) => {
      const { target, services } = plan;
      const deferCompanionPreparation = planDefersRemoteCompanionPreparation(plan);
      let phase = 'prepare';
      let tunnel = existingTunnel;
      let worker = null;
      let createdTunnel = false;
      deferredCompanionPreparationsByTarget.delete(target.name);
      const beginPhase = (nextPhase) => {
        phase = nextPhase;
        publishTargetState(plan, 'starting', { phase });
      };
      const prepareRemoteServices = async () => {
        beginPhase('bootstrap');
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
            env: infraEnv,
          }),
          `${target.name} dependency bootstrap`,
        );

        if (services.daemon) {
          beginPhase('credentials');
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
              env: infraEnv,
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
              env: infraEnv,
            }),
            `${target.name} credential installation`,
          );
        }
        provisionedTargets.add(target.name);
      };
      try {
        beginPhase('prepare');
        if (!provisionedTargets.has(target.name)) {
          if (target.limaInstance) {
            requireSuccessful(
              await runProcess({
                label: `remote:${target.name}`,
                command: 'limactl',
                args: ['start', target.limaInstance],
                env: { ...infraEnv, LIMA_HOME: target.limaHome },
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
              env: infraEnv,
            }),
            `${target.name} directory bootstrap`,
          );
          beginPhase('sync');
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
          if (!deferCompanionPreparation) {
            await prepareRemoteServices();
          }
        }

        if (closed) return null;
        const remoteServerPort =
          target.remoteServerPort ?? resolveDefaultRemoteServerPort({
            localServerPort,
            targetIndex: index,
            instanceId,
          });
        const remoteExpoPort = services.expo
          ? resolveDefaultRemoteExpoPort({
              localExpoPort,
              targetIndex: index,
              instanceId,
            })
          : null;
        servicePortsByTarget.set(target.name, {
          ...(services.server ? { server: remoteServerPort } : {}),
          ...(services.expo ? { expo: remoteExpoPort } : {}),
        });
        if (services.expo && (!Number.isInteger(Number(localExpoPort)) || Number(localExpoPort) < 1024)) {
          throw new Error('[dev-targets] remote Expo placement requires a guest Metro port');
        }
        const remoteOptions = {
          services,
          attended: env.HAPPIER_STACK_TUI === '1',
          serverUrl: `http://127.0.0.1:${remoteServerPort}`,
          publicServerUrl,
          activeServerId,
          stackName,
          remoteServerPort,
          remoteExpoPort,
          expoPublicUrl,
          resolveServerPublicUrlOnTarget: Boolean(resolveMobilePublicUrlsOnTarget && services.server),
          resolveExpoPublicUrlOnTarget: Boolean(resolveMobilePublicUrlsOnTarget && services.expo),
          startMobile,
          remoteServerRuntimeConfig,
          deferDaemonStartUntilCredentials: deferCompanionPreparation && services.daemon,
        };
        phase = 'stop';
        publishTargetState(plan, 'starting', { phase });
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              target.ssh,
              buildRemoteStackStopCommand(target, remoteOptions),
            ],
            env: infraEnv,
          }),
          `${target.name} prior Stack retirement`,
        );
        const remoteCommand = buildRemoteStackCommand(target, remoteOptions);
        const forwards = services.server
          ? [{
              direction: 'local',
              listenHost: '127.0.0.1',
              listenPort: localServerPort,
              targetHost: '127.0.0.1',
              targetPort: remoteServerPort,
            }]
          : [{
              direction: 'reverse',
              listenHost: '127.0.0.1',
              listenPort: remoteServerPort,
              targetHost: '127.0.0.1',
              targetPort: localServerPort,
            }];
        if (services.expo) {
          forwards.push({
            direction: 'local',
            listenHost: expoListenHost,
            listenPort: Number(localExpoPort),
            targetHost: 'localhost',
            targetPort: remoteExpoPort,
          });
        }
        phase = 'tunnel';
        publishTargetState(plan, 'starting', { phase });
        if (!tunnel) {
          tunnel = spawnProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: buildSshForwardArgs(target, {
              forwards,
              sshArgs: openSsh.sshArgs,
            }),
            env: infraEnv,
          });
          createdTunnel = true;
          tunnelsByTarget.set(target.name, tunnel);
        }
        if (!services.server) {
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
              env: infraEnv,
            }),
            `${target.name} reverse tunnel readiness`,
          );
        }
        phase = 'worker';
        publishTargetState(plan, 'starting', { phase });
        worker = spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshWorkerArgs(target, {
            remoteCommand,
            sshArgs: openSsh.sshArgs,
          }),
          env: infraEnv,
        });
        workersByTarget.set(target.name, worker);
        if (deferCompanionPreparation && !provisionedTargets.has(target.name)) {
          deferredCompanionPreparationsByTarget.set(target.name, {
            run: prepareRemoteServices,
            phase: () => phase,
          });
        }
        if (services.server) {
          beginPhase('server-readiness');
          const readinessController = new AbortController();
          const outcome = await Promise.race([
            waitForServerReady({
              url: `http://127.0.0.1:${localServerPort}`,
              target,
              env,
              signal: readinessController.signal,
            }).then(
              () => ({ kind: 'ready' }),
              (error) => ({ kind: 'readiness-failed', error }),
            ),
            waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result })),
            waitForProcess(tunnel).then((result) => ({ kind: 'tunnel-exit', result })),
            closeRequested.then(() => ({ kind: 'close' })),
          ]);
          readinessController.abort();
          if (outcome.kind === 'close' || closed) return null;
          if (outcome.kind !== 'ready') {
            throw outcome.error ?? new Error(`${target.name} remote ${outcome.kind} before server readiness`);
          }
        }
        if (deferCompanionPreparation && !provisionedTargets.has(target.name)) {
          publishTargetState(plan, 'starting', {
            phase: 'companion-preparation',
            serviceStatus: {
              server: 'running',
              ...(services.expo ? { expo: 'starting' } : {}),
              ...(services.daemon ? { daemon: 'starting' } : {}),
            },
          });
        } else {
          targetFailuresByTarget.delete(target.name);
          publishTargetState(plan, 'running');
        }
        return worker;
      } catch (error) {
        deferredCompanionPreparationsByTarget.delete(target.name);
        if (worker) {
          if (workersByTarget.get(target.name) === worker) workersByTarget.delete(target.name);
          await stopProcess(worker).catch(() => {});
        }
        if (tunnel && (createdTunnel || phase === 'tunnel')) {
          if (tunnelsByTarget.get(target.name) === tunnel) {
            tunnelsByTarget.delete(target.name);
          }
          await stopProcess(tunnel).catch(() => {});
        }
        targetFailuresByTarget.set(target.name, { name: target.name, phase, error });
        publishTargetState(plan, 'retrying', {
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error?.(
          `[dev-targets] ${target.name} ${phase} failed; continuing with other targets: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }
    };

    const startTargetLifecycle = (plan, index, initialWorker, initialTunnel) => {
      const { target, services } = plan;
      lifecycleTasks.push((async () => {
        let worker = initialWorker;
        let tunnel = initialTunnel;
        let retryAttempt = 0;
        let companionPreparationReady = !planDefersRemoteCompanionPreparation(plan)
          || provisionedTargets.has(target.name);
        while (!closed) {
          if (worker && tunnel) {
            if (!companionPreparationReady) {
              const deferredPreparation = deferredCompanionPreparationsByTarget.get(target.name);
              try {
                if (!deferredPreparation) {
                  throw new Error(`[dev-targets] ${target.name} deferred companion preparation is unavailable`);
                }
                await deferredPreparation.run();
                companionPreparationReady = true;
                targetFailuresByTarget.delete(target.name);
                publishTargetState(plan, 'running');
                continue;
              } catch (error) {
                const preparationPhase = deferredPreparation?.phase?.() ?? 'bootstrap';
                const failureMessage = `${target.name} remote companion preparation failed: ${
                  error instanceof Error ? error.message : String(error)
                }`;
                targetFailuresByTarget.set(target.name, {
                  name: target.name,
                  phase: preparationPhase,
                  error: new Error(failureMessage),
                });
                publishTargetState(plan, 'degraded', {
                  phase: preparationPhase,
                  error: failureMessage,
                  serviceStatus: {
                    ...(services.server ? { server: 'running' } : {}),
                    ...(services.expo ? { expo: 'degraded' } : {}),
                    ...(services.daemon ? { daemon: 'degraded' } : {}),
                  },
                });
                const preparationRetry = await Promise.race([
                  waitForRetry({ attempt: 1, delayMs: 5_000, target }).then(() => 'retry'),
                  closeRequested.then(() => 'close'),
                ]);
                if (preparationRetry === 'close' || closed) return;
                continue;
              }
            }
            const outcome = await Promise.race([
              waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result })),
              waitForProcess(tunnel).then((result) => ({ kind: 'tunnel-exit', result })),
              closeRequested.then(() => ({ kind: 'close' })),
            ]);
            if (outcome.kind === 'close' || closed) return;

            if (workersByTarget.get(target.name) === worker) {
              workersByTarget.delete(target.name);
            }
            const tunnelExited = outcome.kind === 'tunnel-exit';
            if (tunnelExited && tunnelsByTarget.get(target.name) === tunnel) {
              tunnelsByTarget.delete(target.name);
            }
            await stopProcess(worker);
            if (tunnelExited) {
              await stopProcess(tunnel);
            }
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
            if (tunnelExited) {
              tunnel = null;
            }
          }

          while (!closed) {
            retryAttempt += 1;
            const retryDelayMs = resolveRetryDelayMs(retryAttempt);
            const retryOutcome = await Promise.race([
              waitForRetry({
                attempt: retryAttempt,
                delayMs: retryDelayMs,
                target,
              }).then(() => 'retry'),
              closeRequested.then(() => 'close'),
            ]);
            if (retryOutcome === 'close' || closed) return;
            worker = await startTarget(plan, index, tunnel);
            tunnel = tunnelsByTarget.get(target.name) ?? null;
            if (worker && tunnel) {
              companionPreparationReady = !planDefersRemoteCompanionPreparation(plan)
                || provisionedTargets.has(target.name);
              break;
            }
          }
        }
      })());
    };

    const syncFailedTargets = [];
    await Promise.all(plans.map(async (plan, index) => {
      const target = plan.target;
      const initialWorker = await startTarget(plan, index);
      const initialTunnel = tunnelsByTarget.get(target.name) ?? null;
      const initialFailure = targetFailuresByTarget.get(target.name);
      if (!initialWorker && initialFailure?.phase === 'sync') {
        syncFailedTargets.push({ target, index, initialWorker, initialTunnel });
        return;
      }
      startTargetLifecycle(plan, index, initialWorker, initialTunnel);
    }));
    const unavailableAuthoritativeServer = plans.find((plan) => (
      plan.services.server && !workersByTarget.has(plan.target.name)
    ));
    if (unavailableAuthoritativeServer) {
      throw targetFailuresByTarget.get(unavailableAuthoritativeServer.target.name)?.error
        ?? new Error(
          `[dev-targets] authoritative server target ${unavailableAuthoritativeServer.target.name} failed to become ready`,
        );
    }
    if (
      workersByTarget.size === 0
      && targetFailuresByTarget.size > 0
      && [...targetFailuresByTarget.values()].every(({ phase }) => phase === 'sync')
    ) {
      throw [...targetFailuresByTarget.values()].at(-1).error;
    }
    for (const { target, index, initialWorker, initialTunnel } of syncFailedTargets) {
      const plan = plans.find((candidate) => candidate.target.name === target.name);
      startTargetLifecycle(plan, index, initialWorker, initialTunnel);
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
