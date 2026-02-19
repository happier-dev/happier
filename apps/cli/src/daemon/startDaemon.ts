import fs from 'fs/promises';
import os from 'os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { buildHappyCliSubprocessInvocation, spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { AGENTS, getVendorResumeSupport, resolveAgentCliSubcommand, resolveCatalogAgentId } from '@/backends/catalog';
import {
  writeDaemonState,
  DaemonLocallyPersistedState,
  acquireDaemonLock,
  releaseDaemonLock,
  readCredentials,
} from '@/persistence';
import { createSessionAttachFile } from './sessionAttachFile';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';
import { findRunningTrackedSessionById } from './findRunningTrackedSessionById';
import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createOnChildExited } from './sessions/onChildExited';
import { waitForVisibleConsoleSessionWebhook } from './sessions/visibleConsoleSpawnWaiter';
import { createStopSession } from './sessions/stopSession';
import { resolveSpawnWebhookResult } from './sessions/resolveSpawnWebhookResult';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { createSessionRunnerRespawnManager } from './processSupervision/sessionRunnerRespawn';
import { publishShutdownStateBestEffort } from './lifecycle/publishShutdownState';
import { projectPath } from '@/projectPath';
import { selectPreferredTmuxSessionName, TmuxUtilities, isTmuxAvailable } from '@/integrations/tmux';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';

import { getPreferredHostName, initialMachineMetadata } from './machine/metadata';
export { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { resolveWindowsRemoteSessionConsoleMode } from './platform/windows/windowsSessionConsoleMode';
import { startHappySessionInVisibleWindowsConsole } from './platform/windows/spawnHappyCliVisibleConsole';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { buildHappySessionControlArgs } from './sessionSpawnArgs';
import { resolveExistingSessionEncryptionKeyBase64 } from './sessionEncryption/resolveExistingSessionEncryptionKeyBase64';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { ensureSessionDirectory } from './startup/ensureSessionDirectory';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';
import { resolveSpawnChildEnvironment } from './spawn/resolveSpawnChildEnvironment';
import { createSpawnConcurrencyGate } from './spawn/createSpawnConcurrencyGate';
import { startAutomationWorker, type AutomationWorkerHandle } from './automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from './memory/memoryWorker';
import { resolveConnectedServiceAuthForSpawn } from './connectedServices/resolveConnectedServiceAuthForSpawn';
import { shouldResolveConnectedServiceAuthForSpawn } from './connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { createConnectedServicesAuthUpdatedRestartHandler } from './connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import { ConnectedServiceQuotasCoordinator } from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createConnectedServiceQuotaFetchers } from './connectedServices/quotas/createConnectedServiceQuotaFetchers';
import { resolveConnectedServiceQuotasDaemonOptions } from './connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from './connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop, type ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import {
  HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
  normalizeDaemonInitialPrompt,
} from '@/agent/runtime/daemonInitialPrompt';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const { requestShutdown, resolvesWhenShutdownRequested } = createDaemonShutdownController();

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;

  try {
    const credentialsGate = await waitForInitialCredentials({
      isInteractive,
      waitForAuthEnabled,
      waitForAuthTimeoutMs,
      credentialsPath: configuration.privateKeyFile,
      readCredentials,
      acquireDaemonLock: () => acquireDaemonLock(5, 200),
      releaseDaemonLock,
      resolvesWhenShutdownRequested,
      logger,
      daemonLockHandle,
    });
    if (credentialsGate.action === 'exit') {
      process.exit(credentialsGate.exitCode);
    }
    if (credentialsGate.action === 'shutdown') {
      return;
    }
    daemonLockHandle = credentialsGate.daemonLockHandle;

    // Ensure auth and machine registration BEFORE we take the daemon lock.
    // This prevents stuck lock files when auth is interrupted or cannot proceed.
    const auth = await authAndSetupMachineIfNeeded();
    const credentials = auth.credentials;
    let machineId = auth.machineId;
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Acquire exclusive lock (proves daemon is running)
    if (!daemonLockHandle) {
      daemonLockHandle = await acquireDaemonLock(5, 200);
    }
    if (!daemonLockHandle) {
      logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
      process.exit(0);
    }

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

	    // Setup state - key by PID
	    const pidToTrackedSession = new Map<number, TrackedSession>();
	    const spawnResourceCleanupByPid = new Map<number, () => void>();
	    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
      const connectedServicesMaterializationBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
      let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
      let connectedServiceRefreshInterval: NodeJS.Timeout | null = null;
      let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
      let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
		    let apiMachineForSessions: ApiMachineClient | null = null;
      let automationWorker: AutomationWorkerHandle | null = null;
      let memoryWorker: MemoryWorkerHandle | null = null;

	    // Session spawning awaiter system
	    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
	    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
	    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
	    const spawnConcurrencyGate = createSpawnConcurrencyGate(
	      resolvePositiveIntEnv(process.env.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 4, { min: 1, max: 64 }),
	    );

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

	    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

	    // Handle webhook from happy session reporting itself
	    const onHappySessionWebhook = createOnHappySessionWebhook({ pidToTrackedSession, pidToAwaiter });
	    const resolveCanonicalTrackedSessionId = (pid: number): string => {
	      const session = pidToTrackedSession.get(pid);
	      const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
	      if (!sessionId) return '';
	      if (/^PID-\d+$/.test(sessionId)) return '';
	      return sessionId;
	    };

	    // Spawn a new session (sessionId reserved for future Happy session resume; vendor resume uses options.resume).
		    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
	      return await spawnConcurrencyGate.run(async () => {
	      // Do NOT log raw options: it may include secrets (token / env vars).
	      const envKeysPreview = options.environmentVariables && typeof options.environmentVariables === 'object'
	        ? Object.keys(options.environmentVariables as Record<string, unknown>)
	        : [];
	      const environmentVariablesValidation = validateEnvVarRecordStrict(options.environmentVariables);
		      logger.debugLargeJson('[DAEMON RUN] Spawning session', {
		        directory: options.directory,
		        sessionId: options.sessionId,
		        machineId: options.machineId,
		        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
		        agent: options.agent,
		        profileId: options.profileId,
		        hasToken: !!options.token,
		        hasInitialPrompt: typeof options.initialPrompt === 'string' && options.initialPrompt.trim().length > 0,
		        hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
		        windowsRemoteSessionConsole: options.windowsRemoteSessionConsole,
		        environmentVariableCount: envKeysPreview.length,
		        environmentVariableKeys: envKeysPreview,
		        environmentVariablesValid: environmentVariablesValidation.ok,
		        environmentVariablesError: environmentVariablesValidation.ok ? null : environmentVariablesValidation.error,
		      });

	      if (!environmentVariablesValidation.ok) {
	        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
            errorMessage: environmentVariablesValidation.error,
          };
	      }

			      const {
			        directory,
			        sessionId,
			        machineId,
			        approvedNewDirectoryCreation = true,
			        resume,
			        existingSessionId,
			        permissionMode,
			        permissionModeUpdatedAt,
			        modelId,
			        modelUpdatedAt,
			        initialPrompt,
			        experimentalCodexResume,
			        experimentalCodexAcp
			      } = options;
		      const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
		      const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';

		      const normalizedInitialPrompt = normalizeDaemonInitialPrompt(initialPrompt);

		      // Idempotency: a resume request should not spawn a duplicate process when the session is already running.
	      // This is especially important for pending-queue wake-ups, where the UI may attempt a best-effort wake
	      // even if a session is already attached.
		      if (normalizedExistingSessionId) {
		        const existingTracked = await findRunningTrackedSessionById({
		          sessions: pidToTrackedSession.values(),
		          happySessionId: normalizedExistingSessionId,
	          isPidAlive: async (pid) => {
	            try {
	              process.kill(pid, 0);
	              return true;
	            } catch {
	              return false;
	            }
	          },
	          getProcessCommandHash: async (pid) => {
	            const proc = await findHappyProcessByPid(pid);
	            return proc?.command ? hashProcessCommand(proc.command) : null;
	          },
	        });
	        if (existingTracked) {
	          logger.debug(`[DAEMON RUN] Resume requested for ${normalizedExistingSessionId}, but session is already running (pid=${existingTracked.pid})`);
		          return { type: 'success', sessionId: normalizedExistingSessionId };
		        }
		      }
		      const effectiveResume = normalizedResume;
          const catalogAgentId = resolveCatalogAgentId(options.agent ?? null);

		      // Only gate vendor resume. Happy-session reconnect (existingSessionId) is supported for all agents.
		      if (effectiveResume) {
            const vendorResumeSupport = await getVendorResumeSupport(options.agent ?? null);
            const ok = vendorResumeSupport({ experimentalCodexResume, experimentalCodexAcp });
            if (!ok) {
              const supportLevel = AGENTS[catalogAgentId].vendorResumeSupport;
              const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
		        return {
		          type: 'error',
              errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
		          errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
		        };
            }
		      }

		      let normalizedSessionEncryptionKeyBase64 = '';
		      if (normalizedExistingSessionId) {
            const credentials = await readCredentials().catch(() => null);
            if (!credentials || credentials.encryption.type !== 'dataKey') {
              return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
                errorMessage: 'Missing dataKey credentials to open the session encryption key for resume.',
              };
            }

            const resolved = await resolveExistingSessionEncryptionKeyBase64({
              credentials,
              sessionId: normalizedExistingSessionId,
            }).catch(() => null);
            if (!resolved) {
              return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
                errorMessage: 'Failed to open session encryption key for resume.',
              };
            }

            normalizedSessionEncryptionKeyBase64 = resolved;
		      }
		      let directoryCreated = false;

          const daemonSpawnHooks = AGENTS[catalogAgentId].getDaemonSpawnHooks
            ? await AGENTS[catalogAgentId].getDaemonSpawnHooks!()
            : null;

		      let spawnResourceCleanupOnFailure: (() => void) | null = null;
		      let spawnResourceCleanupOnExit: (() => void) | null = null;
		      let spawnResourceCleanupArmed = false;
		      let sessionAttachCleanup: (() => Promise<void>) | null = null;

	      const ensuredDirectory = await ensureSessionDirectory({
	        directory,
	        approvedNewDirectoryCreation,
	      });
	      if (!ensuredDirectory.ok) {
	        logger.debug(`[DAEMON RUN] Directory setup failed for ${directory}`, ensuredDirectory.response);
	        return ensuredDirectory.response;
	      }
	      directoryCreated = ensuredDirectory.directoryCreated;

      try {

        const cleanupSpawnResources = () => {
          if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
            spawnResourceCleanupOnFailure();
            spawnResourceCleanupOnFailure = null;
            spawnResourceCleanupOnExit = null;
          }
        };

        let connectedServiceAuth: {
          env: Record<string, string>;
          cleanupOnFailure: (() => void) | null;
          cleanupOnExit: (() => void) | null;
        } | null = null;
        const materializationKey =
          normalizedExistingSessionId ||
          (typeof sessionId === 'string' ? sessionId.trim() : '') ||
          `spawn-${Date.now()}-${randomBytes(8).toString('hex')}`;

        if (shouldResolveConnectedServiceAuthForSpawn(options)) {
          try {
            connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
              agentId: catalogAgentId,
              connectedServicesBindingsRaw: options.connectedServices,
              materializationKey,
              baseDir: connectedServicesMaterializationBaseDir,
              credentials,
              api,
            });
          } catch (error) {
            logger.debug('[DAEMON RUN] Connected services resolution failed', error);
            return {
              type: 'error',
              errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
              errorMessage:
                error instanceof Error
                  ? `Connected services resolution failed: ${error.message}`
                  : 'Connected services resolution failed.',
            };
          }
        }

        const spawnEnvironment = await resolveSpawnChildEnvironment({
          options,
          profileEnvironmentVariables: environmentVariablesValidation.env,
          daemonSpawnHooks,
          processEnv: process.env,
          logDebug: (message) => logger.debug(message),
          logInfo: (message) => logger.info(message),
          logWarn: (message) => logger.warn(message),
          connectedServiceAuth,
        });
        spawnResourceCleanupOnFailure = spawnEnvironment.cleanupOnFailure;
        spawnResourceCleanupOnExit = spawnEnvironment.cleanupOnExit;
        if (!spawnEnvironment.ok) {
          cleanupSpawnResources();
          return {
            type: 'error',
            errorCode: spawnEnvironment.errorCode,
            errorMessage: spawnEnvironment.errorMessage,
          };
        }
        const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
        const extraEnvForChild = spawnEnvironment.extraEnvForChild;

	        const terminalRequest = resolveTerminalRequestFromSpawnOptions({
	          happyHomeDir: configuration.happyHomeDir,
	          terminal: options.terminal,
	          environmentVariables: extraEnv,
	        });
	        let sessionAttachFilePath: string | null = null;
	        if (normalizedExistingSessionId) {
	          const attach = await createSessionAttachFile({
	            happySessionId: normalizedExistingSessionId,
	            payload: {
	              encryptionKeyBase64: normalizedSessionEncryptionKeyBase64,
	              encryptionVariant: 'dataKey',
	            },
	          });
	          sessionAttachFilePath = attach.filePath;
	          sessionAttachCleanup = attach.cleanup;
	        }

	        const extraEnvForChildWithMessage = {
	          ...extraEnvForChild,
	          ...(sessionAttachFilePath
	            ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
	            : {}),
	          ...(normalizedInitialPrompt
	            ? { [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: normalizedInitialPrompt }
	            : {}),
	        };

	        // Check if tmux is available and should be used
	        const tmuxAvailable = await isTmuxAvailable();
	        const tmuxRequested = terminalRequest.requested === 'tmux';
	        let useTmux = tmuxAvailable && tmuxRequested;

	        const tmuxSessionName = tmuxRequested ? terminalRequest.tmux.sessionName : undefined;
	        const tmuxTmpDir = tmuxRequested ? terminalRequest.tmux.tmpDir : null;
	        const tmuxCommandEnv: Record<string, string> = {};
	        if (tmuxTmpDir) {
	          tmuxCommandEnv.TMUX_TMPDIR = tmuxTmpDir;
	        }

	        let tmuxFallbackReason: string | null = null;

	        if (!tmuxAvailable && tmuxRequested) {
	          tmuxFallbackReason = 'tmux is not available on this machine';
	          logger.debug('[DAEMON RUN] tmux requested but tmux is not available; falling back to regular spawning');
	        }

	        if (useTmux && tmuxSessionName !== undefined) {
	          // Resolve empty-string session name (legacy "current/most recent") deterministically.
	          let resolvedTmuxSessionName = tmuxSessionName;
	          if (tmuxSessionName === '') {
	            try {
	              const tmuxForDiscovery = new TmuxUtilities(undefined, tmuxCommandEnv);
	              const listResult = await tmuxForDiscovery.executeTmuxCommand([
	                'list-sessions',
	                '-F',
	                '#{session_name}\t#{session_attached}\t#{session_last_attached}',
	              ]);
	              resolvedTmuxSessionName =
	                selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
	            } catch (error) {
	              logger.debug('[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"', error);
	              resolvedTmuxSessionName = TmuxUtilities.DEFAULT_SESSION_NAME;
	            }
	          }

	          // Try to spawn in tmux session
	          const sessionDesc = resolvedTmuxSessionName || 'current/most recent session';
	          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

	          const agentSubcommand = resolveAgentCliSubcommand(options.agent);
	          const windowName = `happy-${Date.now()}-${agentSubcommand}`;
	          const tmuxTarget = `${resolvedTmuxSessionName}:${windowName}`;

	          const terminalRuntimeArgs = [
	            '--happy-terminal-mode',
	            'tmux',
	            '--happy-terminal-requested',
	            'tmux',
	            '--happy-tmux-target',
	            tmuxTarget,
	            ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
	          ];

		          const { commandTokens, tmuxEnv } = buildTmuxSpawnConfig({
		            agent: agentSubcommand,
		            directory,
		            extraEnv: extraEnvForChildWithMessage,
		            tmuxCommandEnv,
		            extraArgs: [
		              ...terminalRuntimeArgs,
                  ...buildHappySessionControlArgs({
                    resume: effectiveResume,
                    existingSessionId: normalizedExistingSessionId,
                    permissionMode,
                    permissionModeUpdatedAt,
                    modelId,
                    modelUpdatedAt,
                  }),
		            ],
		          });
	          const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

          // Spawn in tmux with environment variables
          // IMPORTANT: `spawnInTmux` uses `-e KEY=VALUE` flags for the window.
          // Use merged env so tmux mode matches regular process spawn behavior.
          // Note: this may add many `-e` flags; if it becomes a problem we can optimize
          // by diffing against `tmux show-environment` in a follow-up.
	          if (tmuxTmpDir) {
	            try {
	              await fs.mkdir(tmuxTmpDir, { recursive: true });
	            } catch (error) {
	              logger.debug('[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start', error);
	            }
	          }

	          const tmuxResult = await tmux.spawnInTmux(commandTokens, {
	            sessionName: resolvedTmuxSessionName,
	            windowName: windowName,
	            cwd: directory
	          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }
            const tmuxPid = tmuxResult.pid;

            // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
            const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

	            // Create a tracked session for tmux windows - now we have the real PID!
	            const trackedSession: TrackedSession = {
	              startedBy: 'daemon',
	              pid: tmuxPid, // Real PID from tmux -P flag
	              spawnOptions: options,
	              tmuxSessionId: tmuxResult.sessionId,
	              vendorResumeId: effectiveResume || undefined,
	              directoryCreated,
	              message: directoryCreated
	                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
	                : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
	            };

	            // Add to tracking map so webhook can find it later
	            pidToTrackedSession.set(tmuxPid, trackedSession);
              if (connectedServiceAuth && options.connectedServices) {
                connectedServiceRefreshCoordinator?.registerSpawnTarget({
                  pid: tmuxPid,
                  agentId: catalogAgentId,
                  connectedServicesBindingsRaw: options.connectedServices,
                  materializationKey,
                });
                connectedServiceQuotasCoordinator?.registerSpawnTarget({
                  pid: tmuxPid,
                  connectedServicesBindingsRaw: options.connectedServices,
                });
              }
	            if (spawnResourceCleanupOnExit) {
	              spawnResourceCleanupByPid.set(tmuxPid, spawnResourceCleanupOnExit);
	              spawnResourceCleanupArmed = true;
	            }
	            if (sessionAttachCleanup) {
	              sessionAttachCleanupByPid.set(tmuxPid, sessionAttachCleanup);
	              sessionAttachCleanup = null;
	            }

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxPid} (tmux)`);
            return waitForSessionWebhook({
              pid: tmuxPid,
              pidToAwaiter,
              pidToSpawnResultResolver,
              pidToSpawnWebhookTimeout,
              timeoutErrorMessage: `Session webhook timeout for PID ${tmuxPid} (tmux)`,
              resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(tmuxPid),
              onTimeout: () => {
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxPid} (tmux)`);
              },
              onSuccess: (completedSession) => {
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
              },
            }).then((result) =>
              resolveSpawnWebhookResult({
                pid: tmuxPid,
                result,
                pidToTrackedSession,
                warn: (message) => logger.warn(message),
              }),
            );
	          } else {
	            tmuxFallbackReason = tmuxResult.error ?? 'tmux spawn failed';
	            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
	            useTmux = false;
	          }
	        }
	
	        // Regular process spawning (fallback or if tmux not available)
	        if (!useTmux) {
	          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          const agentCommand = resolveAgentCliSubcommand(options.agent);
	          const args = [
	            agentCommand,
	            '--happy-starting-mode', 'remote',
	            '--started-by', 'daemon'
	          ];

	          if (tmuxRequested) {
	            const reason = tmuxFallbackReason ?? 'tmux was not used';
	            args.push(
	              '--happy-terminal-mode',
	              'plain',
              '--happy-terminal-requested',
              'tmux',
	              '--happy-terminal-fallback-reason',
	              reason,
	            );
	          }

              args.push(...buildHappySessionControlArgs({
                resume: effectiveResume,
                existingSessionId: normalizedExistingSessionId,
                permissionMode,
                permissionModeUpdatedAt,
                modelId,
                modelUpdatedAt,
              }));

		          const windowsConsoleMode = resolveWindowsRemoteSessionConsoleMode({
		            platform: process.platform,
		            requested: options.windowsRemoteSessionConsole,
		            env: process.env,
		          });

			          if (windowsConsoleMode === 'visible') {
			            const { runtime, argv, env } = buildHappyCliSubprocessInvocation(args);
			            const filePath = runtime === 'node' ? process.execPath : runtime;

			            const started = await startHappySessionInVisibleWindowsConsole({
			              filePath,
			              args: argv,
			              workingDirectory: directory,
			              env: {
			                ...process.env,
			                ...extraEnvForChildWithMessage,
			                ...(env ?? {}),
			              },
			            });

		            if (!started.ok) {
		              logger.debug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: started.errorMessage });
		              if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
		                spawnResourceCleanupOnFailure();
		                spawnResourceCleanupOnFailure = null;
		                spawnResourceCleanupOnExit = null;
		              }
		              if (sessionAttachCleanup) {
		                await sessionAttachCleanup();
		                sessionAttachCleanup = null;
		              }
		              return {
		                type: 'error',
		                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
		                errorMessage: started.errorMessage,
		              };
		            }

		            const pid = started.pid;
		            logger.debug(`[DAEMON RUN] Spawned visible-console session with PID ${pid}`);

		            if (sessionAttachCleanup) {
		              sessionAttachCleanupByPid.set(pid, sessionAttachCleanup);
		              sessionAttachCleanup = null;
		            }

		            const trackedSession: TrackedSession = {
		              startedBy: 'daemon',
		              pid,
		              spawnOptions: options,
		              vendorResumeId: effectiveResume || undefined,
		              directoryCreated,
		              message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
		            };
		            pidToTrackedSession.set(pid, trackedSession);
                if (connectedServiceAuth && options.connectedServices) {
                  connectedServiceRefreshCoordinator?.registerSpawnTarget({
                    pid,
                    agentId: catalogAgentId,
                    connectedServicesBindingsRaw: options.connectedServices,
                    materializationKey,
                  });
                  connectedServiceQuotasCoordinator?.registerSpawnTarget({
                    pid,
                    connectedServicesBindingsRaw: options.connectedServices,
                  });
                }

		            if (spawnResourceCleanupOnExit) {
		              spawnResourceCleanupByPid.set(pid, spawnResourceCleanupOnExit);
		              spawnResourceCleanupArmed = true;
		            }

		            // Best-effort: poll for exit so we can run cleanup hooks (e.g. Codex tmp CODEX_HOME).
		            const pollMsRaw = typeof process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS === 'string'
		              ? process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS.trim()
		              : '';
		            const pollMsParsed = pollMsRaw ? Number(pollMsRaw) : NaN;
		            const pollMs = Number.isFinite(pollMsParsed) && pollMsParsed > 0 ? pollMsParsed : 5000;

			            // Wait for webhook to populate session with happySessionId
			            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${pid} (visible console)`);

				            return waitForVisibleConsoleSessionWebhook({
				              pid,
				              pollMs,
				              pidToAwaiter,
				              pidToSpawnResultResolver,
				              pidToSpawnWebhookTimeout,
				              onChildExited,
				              resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(pid),
				            }).then((result) => {
			              const resolved = resolveSpawnWebhookResult({
			                pid,
			                result,
			                pidToTrackedSession,
			                warn: (message) => logger.warn(message),
			              });
			              if (resolved.type === 'success') {
			                logger.debug(
			                  `[DAEMON RUN] Session ${resolved.sessionId} fully spawned with webhook (visible console)`,
			                );
			              } else if (
			                resolved.type === 'error' &&
			                resolved.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
			              ) {
			                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid} (visible console)`);
			              }
			              return resolved;
			            });
			          }

		          // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
		          const happyProcess = spawnHappyCLI(args, {
		            cwd: directory,
		            detached: true,  // Sessions stay alive when daemon stops
	            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
	            env: {
	              ...process.env,
	              ...extraEnvForChildWithMessage
	            }
	          });

	          // Log output for debugging
	          if (process.env.DEBUG) {
	            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

	          if (!happyProcess.pid) {
	            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
	            if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
	              spawnResourceCleanupOnFailure();
	              spawnResourceCleanupOnFailure = null;
	              spawnResourceCleanupOnExit = null;
	            }
	            if (sessionAttachCleanup) {
	              await sessionAttachCleanup();
	              sessionAttachCleanup = null;
	            }
	            return {
	              type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
	              errorMessage: 'Failed to spawn Happier process - no PID returned'
	            };
	          }

	          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);
	          if (sessionAttachCleanup) {
	            sessionAttachCleanupByPid.set(happyProcess.pid, sessionAttachCleanup);
	            sessionAttachCleanup = null;
	          }

		          const trackedSession: TrackedSession = {
		            startedBy: 'daemon',
		            pid: happyProcess.pid,
		            childProcess: happyProcess,
		            spawnOptions: options,
		            vendorResumeId: effectiveResume || undefined,
		            directoryCreated,
		            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
		          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);
          if (connectedServiceAuth && options.connectedServices) {
            connectedServiceRefreshCoordinator?.registerSpawnTarget({
              pid: happyProcess.pid,
              agentId: catalogAgentId,
              connectedServicesBindingsRaw: options.connectedServices,
              materializationKey,
            });
            connectedServiceQuotasCoordinator?.registerSpawnTarget({
              pid: happyProcess.pid,
              connectedServicesBindingsRaw: options.connectedServices,
            });
          }
          if (spawnResourceCleanupOnExit) {
            spawnResourceCleanupByPid.set(happyProcess.pid, spawnResourceCleanupOnExit);
            spawnResourceCleanupArmed = true;
          }

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process exited before session webhook (pid=${happyProcess.pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-exited', code, signal });
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process error before session webhook (pid=${happyProcess.pid})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-error', code: null, signal: null });
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);
	          return waitForSessionWebhook({
	            pid: happyProcess.pid!,
	            pidToAwaiter,
	            pidToSpawnResultResolver,
	            pidToSpawnWebhookTimeout,
	            timeoutErrorMessage: `Session webhook timeout for PID ${happyProcess.pid}`,
	            resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(happyProcess.pid!),
	            onTimeout: () => {
	              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
	            },
	            onSuccess: (completedSession) => {
	              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            },
          }).then((result) =>
            resolveSpawnWebhookResult({
              pid: happyProcess.pid!,
              result,
              pidToTrackedSession,
              warn: (message) => logger.warn(message),
            }),
          );
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: 'Unexpected error in session spawning'
        };
		      } catch (error) {
		        if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
		          spawnResourceCleanupOnFailure();
		          spawnResourceCleanupOnFailure = null;
	          spawnResourceCleanupOnExit = null;
	        }
	        if (sessionAttachCleanup) {
	          await sessionAttachCleanup();
	          sessionAttachCleanup = null;
	        }
		        const errorMessage = error instanceof Error ? error.message : String(error);
		        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
		        return {
		          type: 'error',
	            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
		          errorMessage: `Failed to spawn session: ${errorMessage}`
		        };
		      }
	      });
		    };
	
		    const stopSessionCore = createStopSession({ pidToTrackedSession });

        const resolveBoolEnv = (raw: string | undefined, fallback: boolean): boolean => {
          const value = (raw ?? '').trim().toLowerCase();
          if (!value) return fallback;
          if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
          if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
          return fallback;
        };

        const sessionRespawnEnabled = resolveBoolEnv(process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, true);
        const sessionRespawnMaxAttempts = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
          10,
          { min: 0, max: 100 },
        );
        const sessionRespawnBaseDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
          1_000,
          { min: 50, max: 5 * 60_000 },
        );
        const sessionRespawnMaxDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
          60_000,
          { min: 50, max: 30 * 60_000 },
        );
        const sessionRespawnJitterMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
          250,
          { min: 0, max: 10_000 },
        );

	        const isSessionAlreadyRunning = (sessionId: string): boolean => {
	          for (const tracked of pidToTrackedSession.values()) {
	            if (tracked.happySessionId === sessionId) return true;
	          }
	          return false;
	        };
        const sessionRespawnMaxRestarts = sessionRespawnMaxAttempts === 0 ? null : sessionRespawnMaxAttempts;
	        const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
          enabled: sessionRespawnEnabled,
          maxRestarts: sessionRespawnMaxRestarts,
          baseDelayMs: sessionRespawnBaseDelayMs,
          maxDelayMs: sessionRespawnMaxDelayMs,
          jitterMs: sessionRespawnJitterMs,
          isSessionAlreadyRunning,
          spawnSession,
          random: () => Math.random(),
          logDebug: (message, payload) => logger.debug(message, payload),
          logWarn: (message) => logger.warn(message),
        });

        const connectedServicesRestartRequestedPids = new Set<number>();

		    // Handle child process exit
		    const onChildExitedBase = createOnChildExited({
		      pidToTrackedSession,
		      spawnResourceCleanupByPid,
		      sessionAttachCleanupByPid,
		      getApiMachineForSessions: () => apiMachineForSessions,
          onUnexpectedExit: sessionRunnerRespawnManager.handleUnexpectedExit,
          isExitUnexpectedOverride: (tracked, _exit) => {
            if (!connectedServicesRestartRequestedPids.has(tracked.pid)) return null;
            connectedServicesRestartRequestedPids.delete(tracked.pid);
            return true;
          },
		    });
        const onChildExited = (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => {
          connectedServiceRefreshCoordinator?.unregisterPid(pid);
          connectedServiceQuotasCoordinator?.unregisterPid(pid);
          onChildExitedBase(pid, exit);
        };

        const stopSession = async (sessionId: string): Promise<boolean> => {
          sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
          return await stopSessionCore(sessionId);
        };

    const controlToken = randomBytes(32).toString('base64url');

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happier-cli'),
      onHappySessionWebhook
      ,
      controlToken,
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      controlToken,
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

	    // Prepare initial daemon state
	    const initialDaemonState: DaemonState = {
	      status: 'offline',
	      pid: process.pid,
	      httpPort: controlPort,
	      startedAt: Date.now()
	    };

	    // Create API client
	    const api = await ApiClient.create(credentials);
      const connectedServicesRefreshEnabled = resolveBoolEnv(process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED, true);
      if (connectedServicesRefreshEnabled) {
        const refreshTickMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS,
          30_000,
          { min: 5_000, max: 5 * 60_000 },
        );
        const refreshWindowMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
          10 * 60_000,
          { min: 10_000, max: 60 * 60_000 },
        );
        const refreshLeaseMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_MS,
          2 * 60_000,
          { min: 10_000, max: 30 * 60_000 },
        );

        const restartPiOnAuthUpdate = resolveBoolEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_PI_ENABLED,
          true,
        );
        const onAuthUpdated =
          restartPiOnAuthUpdate
            ? createConnectedServicesAuthUpdatedRestartHandler({
              restartRequestedPids: connectedServicesRestartRequestedPids,
              pidToTrackedSession,
              restartAgentIds: new Set(['pi']),
            })
            : undefined;

        connectedServiceRefreshCoordinator = new ConnectedServiceRefreshCoordinator({
          api,
          credentials,
          machineIdProvider: () => machineId,
          baseDir: connectedServicesMaterializationBaseDir,
          refreshWindowMs,
          refreshLeaseMs,
          now: () => Date.now(),
          ...(onAuthUpdated ? { onAuthUpdated } : {}),
        });

        connectedServiceRefreshInterval = setInterval(() => {
          void connectedServiceRefreshCoordinator?.tickOnce().catch((error) => {
            logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', error);
          });
        }, refreshTickMs) as unknown as NodeJS.Timeout;
        (connectedServiceRefreshInterval as unknown as { unref?: () => void })?.unref?.();
      }

      const connectedServicesQuotasEnabled = await resolveConnectedServicesQuotasDaemonEnabled({
        env: process.env,
        serverUrl: configuration.serverUrl,
        timeoutMs: 1500,
      });
      if (connectedServicesQuotasEnabled) {
	        const quotasTickMs = resolvePositiveIntEnv(
	          process.env.HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS,
	          60_000,
	          { min: 5_000, max: 30 * 60_000 },
	        );
	        const {
	          fetchTimeoutMs,
	          discoveryEnabled,
	          discoveryIntervalMs,
	          failureBackoffMinMs,
	          failureBackoffMaxMs,
	          failureBackoffJitterPct,
	        } = resolveConnectedServiceQuotasDaemonOptions(process.env);

	        connectedServiceQuotasCoordinator = new ConnectedServiceQuotasCoordinator({
	          api,
	          credentials,
	          quotaFetchers: createConnectedServiceQuotaFetchers(process.env),
	          fetchTimeoutMs,
	          discoveryEnabled,
	          discoveryIntervalMs,
	          failureBackoffMinMs,
	          failureBackoffMaxMs,
	          failureBackoffJitterPct,
	          now: () => Date.now(),
	          randomBytes: (length) => randomBytes(length),
	        });

        connectedServiceQuotasLoopHandle = startConnectedServiceQuotasLoop({
          enabled: true,
          tickMs: quotasTickMs,
          coordinator: connectedServiceQuotasCoordinator,
          onTickError: (error) => {
            logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', error);
          },
        });
      }

		    let apiMachine: ApiMachineClient | null = null;
      let shutdownInitiated = false;
		    const preferredHost = await getPreferredHostName();
	    const machineRegistrationTimeoutMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
        10_000,
        { min: 250, max: 120_000 },
      );

      // Do machine bootstrap in the background so shutdown requests are not blocked by /v1/machines latency.
      void (async () => {
	      try {
	        const metadataForRegistration: MachineMetadata = { ...initialMachineMetadata, host: preferredHost };
	        const ensured = await ensureMachineRegistered({
	          api,
	          machineId,
	          metadata: metadataForRegistration,
	          daemonState: initialDaemonState,
	          timeoutMs: machineRegistrationTimeoutMs,
	          caller: 'startDaemon',
	        });
	        machineId = ensured.machineId;
	        const machine = ensured.machine;
	        logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

          if (shutdownInitiated) {
            return;
          }

	        // Create realtime machine session
	        const connectedApiMachine = api.machineSyncClient(machine);
	        apiMachine = connectedApiMachine;
	        apiMachineForSessions = connectedApiMachine;

	        // Set RPC handlers
	          automationWorker = startAutomationWorker({
	            token: credentials.token,
	            machineId,
	            encryption: credentials.encryption,
	            spawnSession,
	          });

	          memoryWorker = (() => {
	            try {
	              return startMemoryWorker({
	                credentials,
	                machineId,
	              });
	            } catch (error) {
	              logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
	              return null;
	            }
	          })();

	        connectedApiMachine.setRPCHandlers({
	          spawnSession,
	          stopSession,
	          requestShutdown: () => requestShutdown('happier-app'),
            ...(memoryWorker ? { memory: memoryWorker } : {}),
	        });

	        let didRefreshMachineMetadata = false;
	        connectedApiMachine.connect({
	          onConnect: async () => {
	            if (shutdownInitiated) return;

              if (automationWorker) {
                await automationWorker.refreshAssignments().catch((error) => {
                  logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
                });
              }

	            if (didRefreshMachineMetadata) return;
	            didRefreshMachineMetadata = true;
	            // Keep machine metadata fresh without clobbering user-provided fields (e.g. displayName) that may exist.
	            await connectedApiMachine.updateMachineMetadata((metadata) => {
	              const base = (metadata ?? (machine.metadata as any) ?? {}) as any;
	              const next: MachineMetadata = {
	                ...base,
	                host: preferredHost,
	                platform: os.platform(),
	                happyCliVersion: packageJson.version,
	                homeDir: os.homedir(),
	                happyHomeDir: configuration.happyHomeDir,
	                happyLibDir: projectPath(),
	              } as MachineMetadata;

	              // If nothing changes, skip emitting an update entirely.
	              const current = base as Partial<MachineMetadata>;
	              const isSame =
	                current.host === next.host &&
	                current.platform === next.platform &&
	                current.happyCliVersion === next.happyCliVersion &&
	                current.homeDir === next.homeDir &&
	                current.happyHomeDir === next.happyHomeDir &&
	                current.happyLibDir === next.happyLibDir;

	              if (isSame) {
	                return base as MachineMetadata;
	              }

	              return next;
	            }).catch((error) => {
	              didRefreshMachineMetadata = false;
	              logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
	            });
	          },
	        });
	      } catch (error) {
	        // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
	        logger.warn(
	          '[DAEMON RUN] Machine registration unavailable at startup; continuing without machine sync until next restart',
	          serializeAxiosErrorForLog(error),
	        );
	      }
      })();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      onChildExited,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
    });

		    // Setup signal handlers
			    const cleanupAndShutdown = async (source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
          shutdownInitiated = true;
	      const exitCode = getDaemonShutdownExitCode(source);
	      const shutdownWatchdog = setTimeout(async () => {
	        logger.debug(`[DAEMON RUN] Shutdown timed out, forcing exit with code ${exitCode}`);
	        await new Promise((resolve) => setTimeout(resolve, 100));
	        process.exit(exitCode);
	      }, getDaemonShutdownWatchdogTimeoutMs());
	      shutdownWatchdog.unref?.();

	      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

	      // Clear health check interval
	      if (restartOnStaleVersionAndHeartbeat) {
	        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }
      if (connectedServiceRefreshInterval) {
        clearInterval(connectedServiceRefreshInterval);
        connectedServiceRefreshInterval = null;
      }
      if (connectedServiceQuotasLoopHandle) {
        connectedServiceQuotasLoopHandle.stop();
        connectedServiceQuotasLoopHandle = null;
      }

	      if (apiMachine) {
          const daemonStateUpdateTimeoutMs = resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_SHUTDOWN_STATE_UPDATE_TIMEOUT_MS,
            250,
            { min: 50, max: 30_000 },
          );

          await publishShutdownStateBestEffort({
            apiMachine,
            source,
            timeoutMs: daemonStateUpdateTimeoutMs,
            warn: (message, error) => {
              if (error !== undefined) {
                logger.warn(message, error);
                return;
              }
              logger.warn(message);
            },
          });
      }
      if (automationWorker) {
        automationWorker.stop();
      }
      if (memoryWorker) {
        memoryWorker.stop();
      }
      await stopControlServer();
	      await cleanupDaemonState();
	      await stopCaffeinate();
	      if (daemonLockHandle) {
	        await releaseDaemonLock(daemonLockHandle);
	      }

	      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
	      clearTimeout(shutdownWatchdog);
	      process.exit(exitCode);
	    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    try {
      if (daemonLockHandle) {
        await releaseDaemonLock(daemonLockHandle);
      }
    } catch {
      // ignore
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    process.exit(1);
  }
}
