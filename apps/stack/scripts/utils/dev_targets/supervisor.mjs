import { join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import {
  buildMutagenMonitorArgs,
  createMutagenMonitorLineFilter,
} from './mutagen_monitor.mjs';
import {
  ensureDevTargetSyncProject,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { runDevTargetDependencyBootstrap } from './executor.mjs';
import { startDevTargetRuntime } from './managed_runtime.mjs';
import { waitForExpoMetroRunning } from '../expo/expo.mjs';
import {
  buildRemoteStackCommand,
  buildRemoteStackStopCommand,
  buildRemoteDaemonReadinessProbeCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteForwardProbeCommand,
  buildRemoteInstallCredentialCommand,
  buildSshForwardArgs,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

const TARGET_SYNC_READY = Symbol('TARGET_SYNC_READY');

function planRunsRuntimeServices(plan) {
  return Object.values(plan?.services ?? {}).some(Boolean);
}

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

export function resolveDefaultRemoteExpoPort({ localExpoPort, targetIndex, instanceId = process.pid } = {}) {
  const local = Math.abs(Math.trunc(Number(localExpoPort) || 0));
  const instance = Math.abs(Math.trunc(Number(instanceId) || 0));
  const index = Math.abs(Math.trunc(Number(targetIndex) || 0));
  return 20_000 + ((local + instance + (index * 577)) % 20_000);
}

function defaultSpawnProcess({
  label,
  command,
  args,
  env,
  silent = false,
  persistOutput = true,
  lineFilter,
}) {
  return spawnProc(label, command, args, env, { silent, persistOutput, lineFilter });
}

async function defaultStopProcess(child) {
  if (!child || child.exitCode != null) return;
  await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
}

async function defaultWaitForProcess(child) {
  if (child?.completion) return await child.completion;
  return await new Promise(() => {});
}

function resolveRetryDelayMs(attempt) {
  return Math.min(60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

async function defaultWaitForRetry({ delayMs }) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveExpoReadinessTimeoutMs(env = process.env) {
  const configured = Number(env.HAPPIER_DEV_TARGET_EXPO_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}

async function defaultWaitForExpoReady({ port, env = process.env, signal } = {}) {
  const timeoutMs = resolveExpoReadinessTimeoutMs(env);
  const result = await waitForExpoMetroRunning({
    port,
    timeoutMs,
    intervalMs: 500,
    env,
    signal,
  });
  if (result.ok) return;
  if (result.reason === 'aborted' || signal?.aborted) {
    throw signal.reason ?? new Error('remote Expo readiness was cancelled');
  }
  throw new Error(`timed out waiting for tunneled Expo on localhost:${String(port)} after ${timeoutMs}ms`);
}

function resolveDaemonReadinessTimeoutMs(env = process.env) {
  const configured = Number(env.HAPPIER_DEV_TARGET_DAEMON_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}

async function waitForAbortableDelay(delayMs, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('remote daemon readiness was cancelled');
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('remote daemon readiness was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

async function defaultWaitForDaemonReady({
  target,
  activeServerId,
  sshArgs,
  runProcess,
  env = process.env,
  signal,
} = {}) {
  const timeoutMs = resolveDaemonReadinessTimeoutMs(env);
  const startedAt = Date.now();
  const command = buildRemoteDaemonReadinessProbeCommand(target, { activeServerId });
  while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
    const result = await runProcess({
      label: `remote:${target.name}`,
      command: 'ssh',
      args: [
        ...sshArgs,
        '-o',
        'BatchMode=yes',
        target.ssh,
        command,
      ],
      env,
    });
    if (result?.code === 0) return;
    await waitForAbortableDelay(5_000, signal);
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error('remote daemon readiness was cancelled');
  }
  throw new Error(
    `timed out waiting for ${target.name} daemon readiness after ${timeoutMs}ms`,
  );
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

export async function startStackDevTargets(
  {
    stackName,
    stackBaseDir,
    sourceDir,
    localServerPort,
    localExpoPort = null,
    publicServerUrl = '',
    expoPublicUrl = '',
    expoListenHost = '127.0.0.1',
    startMobile = false,
    activeServerId,
    credentialPath,
    targets,
    syncTargets = null,
    targetPlans = null,
    onTargetStateChange = null,
    env = process.env,
    instanceId = process.pid,
  },
  {
    runProcess = runDevTargetControlProcess,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    waitForProcess = defaultWaitForProcess,
    waitForRetry = defaultWaitForRetry,
    waitForExpoReady = defaultWaitForExpoReady,
    waitForDaemonReady = defaultWaitForDaemonReady,
    runDependencyBootstrap = runDevTargetDependencyBootstrap,
    startManagedRuntime = startDevTargetRuntime,
    logger = console,
  } = {},
) {
  const plans = Array.isArray(targetPlans)
    ? targetPlans
    : (Array.isArray(targets) ? targets : []).map((target) => ({
      target,
      services: { server: false, expo: false, daemon: true },
    }));
  if (plans.length === 0) {
    return { workers: [], close: async () => {} };
  }
  const configuredTargets = Array.isArray(syncTargets)
    ? syncTargets
    : plans.map((plan) => plan.target);
  const servicePlans = plans.filter(planRunsRuntimeServices);
  // When this supervisor owns runtime services, only their synchronization may
  // gate service startup. Command-only targets are routed and freshness-checked
  // by the command executor; an unrelated target must not keep Expo/daemon down.
  // Preserve the original command-only behavior when no runtime service exists.
  const requiredSyncPlans = servicePlans.length > 0 ? servicePlans : plans;
  if (plans.some((plan) => plan.services.daemon) && !credentialPath) {
    throw new Error(
      '[dev-targets] the local stack has no daemon credential to seed remotely; authenticate the local daemon first',
    );
  }

  const infraEnv = {
    ...env,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
    HAPPIER_STACK_LOG_TEE_DIR:
      String(env.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim() || join(stackBaseDir, 'logs'),
    HAPPIER_STACK_LOG_TEE_TIMESTAMPS:
      String(env.HAPPIER_STACK_LOG_TEE_TIMESTAMPS ?? '').trim() || '1',
  };
  const workersByTarget = new Map();
  const tunnelsByTarget = new Map();
  const targetFailuresByTarget = new Map();
  const provisionedTargets = new Set();
  const lifecycleTasks = [];
  let monitorWorker = null;
  let syncProject = null;
  let closed = false;
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  const publishTargetState = (plan, status, details = {}) => {
    if (typeof onTargetStateChange !== 'function') return;
    const serviceStatus = Object.fromEntries(
      Object.entries(plan.services)
        .filter(([, enabled]) => enabled === true)
        .map(([service]) => [service, details.serviceStatus?.[service] ?? status]),
    );
    const state = {
      name: plan.target.name,
      commands: plan.commands === true,
      services: { ...plan.services },
      serviceStatus,
      status,
      ...(status === 'running' ? { phase: null, error: null } : {}),
      ...details,
    };
    try {
      const pending = onTargetStateChange(state);
      pending?.catch?.((error) => {
        logger.error?.(
          `[dev-targets] ${plan.target.name} runtime state projection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } catch (error) {
      logger.error?.(
        `[dev-targets] ${plan.target.name} runtime state projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  try {
    syncProject = await ensureDevTargetSyncProject({
      stackBaseDir,
      sourceDir,
      targets: configuredTargets,
      requiredTargets: requiredSyncPlans.map((plan) => plan.target),
      ownerId: instanceId,
      allowIndependentBorrow: true,
      env: infraEnv,
    }, { runProcess });
    const { openSsh, projectFile } = syncProject;
    const mutagenEnv = syncProject.env;
    const mutagenMonitorEnv = {
      ...mutagenEnv,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    };
    monitorWorker = spawnProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenMonitorArgs(
        configuredTargets.map((target) => resolveMutagenSessionName(target.name)),
      ),
      lineFilter: createMutagenMonitorLineFilter(),
      env: mutagenMonitorEnv,
    });

    const startTarget = async (plan, index, existingTunnel = null) => {
      const { target, services } = plan;
      const hasServices = Object.values(services).some(Boolean);
      let phase = 'prepare';
      let tunnel = existingTunnel;
      let createdTunnel = false;
      const beginPhase = (nextPhase) => {
        phase = nextPhase;
        publishTargetState(plan, 'starting', { phase });
      };
      try {
        beginPhase('prepare');
        if (!provisionedTargets.has(target.name)) {
          if (target.managedRuntime || target.limaInstance) {
            await startManagedRuntime({ target, env: infraEnv });
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
          if (syncProject.ownership === 'owned') {
            requireSuccessful(
              await runProcess({
                label: `remote:${target.name}`,
                command: 'mutagen',
                args: ['sync', 'resume', resolveMutagenSessionName(target.name)],
                env: mutagenEnv,
              }),
              `${target.name} Mutagen resume`,
            );
          }
          if (hasServices) {
            beginPhase('bootstrap');
            requireSuccessful(
              await runDependencyBootstrap({
                target,
                stackBaseDir,
                // Local generated inputs are published immediately before the
                // supervisor starts. Use the existing explicit Mutagen barrier
                // once before executing component bootstrap on the replica.
                syncAlreadyVerified: false,
                flush: true,
                env: infraEnv,
              }),
              `${target.name} dependency bootstrap`,
            );
          }

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
        }

        if (closed) return null;
        if (!hasServices) {
          targetFailuresByTarget.delete(target.name);
          publishTargetState(plan, 'running');
          return TARGET_SYNC_READY;
        }
        const remoteServerPort =
          target.remoteServerPort ?? resolveDefaultRemoteServerPort({
            localServerPort,
            targetIndex: index,
            instanceId,
          });
        const remoteExpoPort = services.expo
          ? resolveDefaultRemoteExpoPort({ localExpoPort, targetIndex: index, instanceId })
          : null;
        const forwards = [];
        if (services.server) {
          forwards.push({
            direction: 'local',
            listenHost: '127.0.0.1',
            listenPort: localServerPort,
            targetHost: '127.0.0.1',
            targetPort: remoteServerPort,
          });
        } else if (services.daemon || services.expo) {
          forwards.push({
            direction: 'reverse',
            listenHost: '127.0.0.1',
            listenPort: remoteServerPort,
            targetHost: '127.0.0.1',
            targetPort: localServerPort,
          });
        }
        if (services.expo) {
          forwards.push({
            direction: 'local',
            listenHost: expoListenHost,
            listenPort: localExpoPort,
            targetHost: 'localhost',
            targetPort: remoteExpoPort,
          });
        }
        const remoteStackOptions = {
          services,
          serverUrl: `http://127.0.0.1:${remoteServerPort}`,
          publicServerUrl,
          activeServerId,
          stackName,
          remoteServerPort,
          remoteExpoPort,
          expoPublicUrl,
          startMobile,
        };
        beginPhase('stop');
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              target.ssh,
              buildRemoteStackStopCommand(target, remoteStackOptions),
            ],
            env: infraEnv,
          }),
          `${target.name} prior Stack retirement`,
        );
        const remoteCommand = buildRemoteStackCommand(target, remoteStackOptions);
        beginPhase('tunnel');
        if (!tunnel) {
          tunnel = spawnProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: buildSshForwardArgs(target, {
              forwards,
              sshArgs: openSsh.sshArgs,
            }),
            env: infraEnv,
            // The readiness probe intentionally reaches this tunnel before the
            // remote Expo listener exists. Keep those expected SSH channel
            // refusals out of the target pane; lifecycle failures remain
            // visible through the supervisor's status/error projection.
            silent: true,
            persistOutput: false,
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
        beginPhase('worker');
        const worker = spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshWorkerArgs(target, {
            remoteCommand,
            sshArgs: openSsh.sshArgs,
          }),
          env: infraEnv,
        });
        workersByTarget.set(target.name, worker);
        if (!services.expo && !services.daemon) {
          targetFailuresByTarget.delete(target.name);
          publishTargetState(plan, 'running');
        } else if (services.expo) {
          beginPhase('expo-readiness');
        } else {
          beginPhase('daemon-readiness');
        }
        return worker;
      } catch (error) {
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
        let expoReady = !services.expo;
        let daemonReady = !services.daemon;
        while (!closed) {
          if (worker && tunnel) {
            const readinessController = (!expoReady || !daemonReady) ? new AbortController() : null;
            const outcomePromises = [
              waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result })),
              waitForProcess(tunnel).then((result) => ({ kind: 'tunnel-exit', result })),
              closeRequested.then(() => ({ kind: 'close' })),
            ];
            if (readinessController) {
              if (!expoReady) outcomePromises.push(
                waitForExpoReady({
                  port: localExpoPort,
                  target,
                  env,
                  signal: readinessController.signal,
                }).then(
                  () => ({ kind: 'expo-ready' }),
                  (error) => ({ kind: 'expo-readiness-failed', error }),
                ),
              );
              if (!daemonReady) outcomePromises.push(
                waitForDaemonReady({
                  target,
                  activeServerId,
                  sshArgs: openSsh.sshArgs,
                  runProcess,
                  env: infraEnv,
                  signal: readinessController.signal,
                }).then(
                  () => ({ kind: 'daemon-ready' }),
                  (error) => ({ kind: 'daemon-readiness-failed', error }),
                ),
              );
            }
            const outcome = await Promise.race(outcomePromises);
            readinessController?.abort();
            if (outcome.kind === 'close' || closed) return;
            if (outcome.kind === 'expo-ready') {
              expoReady = true;
              retryAttempt = 0;
              if (daemonReady) {
                targetFailuresByTarget.delete(target.name);
                publishTargetState(plan, 'running');
              } else {
                publishTargetState(plan, 'starting', {
                  phase: 'daemon-readiness',
                  serviceStatus: { expo: 'running', daemon: 'starting' },
                });
              }
              continue;
            }
            if (outcome.kind === 'daemon-ready') {
              daemonReady = true;
              retryAttempt = 0;
              if (expoReady) {
                targetFailuresByTarget.delete(target.name);
                publishTargetState(plan, 'running');
              } else {
                publishTargetState(plan, 'starting', {
                  phase: 'expo-readiness',
                  serviceStatus: { daemon: 'running', expo: 'starting' },
                });
              }
              continue;
            }
            if (outcome.kind === 'daemon-readiness-failed') {
              const failureMessage = `${target.name} remote daemon readiness failed: ${
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              }`;
              targetFailuresByTarget.set(target.name, {
                name: target.name,
                phase: 'daemon-readiness',
                error: new Error(failureMessage),
              });
              publishTargetState(plan, 'degraded', {
                phase: 'daemon-readiness',
                error: failureMessage,
                serviceStatus: {
                  ...(services.expo ? { expo: expoReady ? 'running' : 'starting' } : {}),
                  daemon: 'degraded',
                },
              });
              const retryOutcome = await Promise.race([
                waitForRetry({ attempt: 1, delayMs: 5_000, target }).then(() => 'retry'),
                closeRequested.then(() => 'close'),
              ]);
              if (retryOutcome === 'close' || closed) return;
              continue;
            }
            if (outcome.kind === 'expo-readiness-failed') {
              const failureMessage = `${target.name} remote Expo readiness failed: ${
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              }`;
              targetFailuresByTarget.set(target.name, {
                name: target.name,
                phase: 'expo-readiness',
                error: new Error(failureMessage),
              });
              publishTargetState(plan, 'degraded', {
                phase: 'expo-readiness',
                error: failureMessage,
                serviceStatus: {
                  expo: 'degraded',
                  ...(services.daemon ? { daemon: daemonReady ? 'running' : 'starting' } : {}),
                },
              });
              const retryOutcome = await Promise.race([
                waitForRetry({ attempt: 1, delayMs: 5_000, target }).then(() => 'retry'),
                closeRequested.then(() => 'close'),
              ]);
              if (retryOutcome === 'close' || closed) return;
              continue;
            }

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
            const failurePhase = tunnelExited ? 'tunnel' : 'worker';
            const code = String(outcome.result?.code ?? 'unknown');
            const failureMessage = `${target.name} remote ${outcome.kind} (code=${code})`;
            targetFailuresByTarget.set(target.name, {
              name: target.name,
              phase: failurePhase,
              error: new Error(failureMessage),
            });
            publishTargetState(plan, 'retrying', {
              phase: failurePhase,
              error: failureMessage,
            });
            logger.error?.(
              `[dev-targets] ${failureMessage}; retrying target lifecycle`,
            );
            worker = null;
            expoReady = !services.expo;
            daemonReady = !services.daemon;
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
            if (worker === TARGET_SYNC_READY) return;
            tunnel = tunnelsByTarget.get(target.name) ?? null;
            if (worker && tunnel) {
              expoReady = !services.expo;
              break;
            }
          }
        }
      })());
    };

    const syncFailedTargets = [];
    await Promise.all(plans.map(async (plan, index) => {
      const { target } = plan;
      const initialWorker = await startTarget(plan, index);
      const initialTunnel = tunnelsByTarget.get(target.name) ?? null;
      const initialFailure = targetFailuresByTarget.get(target.name);
      if (initialWorker === TARGET_SYNC_READY) return;
      if (!initialWorker && initialFailure?.phase === 'sync') {
        syncFailedTargets.push({ plan, index, initialWorker, initialTunnel });
        return;
      }
      startTargetLifecycle(plan, index, initialWorker, initialTunnel);
    }));
    if (
      workersByTarget.size === 0
      && targetFailuresByTarget.size > 0
      && [...targetFailuresByTarget.values()].every(({ phase }) => phase === 'sync')
    ) {
      throw [...targetFailuresByTarget.values()].at(-1).error;
    }
    for (const { plan, index, initialWorker, initialTunnel } of syncFailedTargets) {
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
        await syncProject.release('pause');
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
    await syncProject?.release(syncProject.projectCreated ? 'terminate' : 'pause').catch(() => {});
    throw error;
  }
}

export function startStackDevTargetsInBackground(
  options,
  {
    startStackDevTargetsImpl = startStackDevTargets,
    waitForRetry = defaultWaitForRetry,
    logger = console,
  } = {},
) {
  let activeController = null;
  let closing = false;
  let closedByReady = false;
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  const ready = (async () => {
    let attempt = 0;
    while (!closing) {
      try {
        const controller = await startStackDevTargetsImpl(options);
        activeController = controller;
        if (closing) {
          await activeController?.close?.();
          closedByReady = true;
        }
        return controller;
      } catch (error) {
        attempt += 1;
        const delayMs = resolveRetryDelayMs(attempt);
      for (const plan of options?.targetPlans ?? []) {
        try {
          const pending = options?.onTargetStateChange?.({
            name: plan.target.name,
            commands: plan.commands === true,
            services: { ...plan.services },
            status: 'retrying',
            phase: 'startup',
            error: error instanceof Error ? error.message : String(error),
          });
          pending?.catch?.(() => {});
        } catch {}
      }
      logger.error?.(
          `[dev-targets] startup failed; retrying while the local Stack remains available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
        const retryOutcome = await Promise.race([
          waitForRetry({ attempt, delayMs }).then(() => 'retry'),
          closeRequested.then(() => 'close'),
        ]);
        if (retryOutcome === 'close' || closing) return null;
      }
    }
    return null;
  })();

  return {
    ready,
    async close() {
      if (closing) return;
      closing = true;
      resolveCloseRequested();
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
