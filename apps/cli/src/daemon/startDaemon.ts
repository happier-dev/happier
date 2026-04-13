import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata } from '@/api/types';
import type { DaemonState } from '@/api/types';
import {
  resolveCanonicalCodexBackendMode,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { getVendorResumeSupport, requireCatalogEntry } from '@/backends/catalog';
import { projectPath } from '@/projectPath';
import {
  writeDaemonState,
  acquireDaemonLock,
  releaseDaemonLock,
  readCredentials,
  readSettings,
} from '@/persistence';
import { createSessionAttachFile } from './sessionAttachFile';

import { isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createDaemonSessionHandoffMetadataBridge } from './sessions/createDaemonSessionHandoffMetadataBridge';
import { createOnChildExited } from './sessions/onChildExited';
import { createStopSession } from './sessions/stopSession';
import { isSessionRunnerActive as isSessionRunnerActiveInDaemon } from './sessions/isSessionRunnerActive';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { createSessionRunnerRespawnManager } from './processSupervision/sessionRunnerRespawn';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';

import { getPreferredHostName, initialMachineMetadata } from './machine/metadata';
export { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { cleanupAndShutdown as runCleanupAndShutdown } from './lifecycle/cleanupAndShutdown';
import { createBeforeShutdownDrain } from './lifecycle/createBeforeShutdownDrain';
import { startDaemonMachineRegistration } from './machine/startDaemonMachineRegistration';
import { startDaemonRuntimeBootstrap } from './startup/startDaemonRuntimeBootstrap';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionProcessesOutOfDaemonServiceCgroup';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { ensureSessionDirectory } from './startup/ensureSessionDirectory';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { resolveDaemonDiagnosticSubsystemGates } from './startup/diagnosticSubsystemGates';
import { resolveSpawnChildEnvironment } from './spawn/resolveSpawnChildEnvironment';
import { resolveStackProcessKindOverrideForSessionSpawn } from './spawn/resolveStackProcessKindOverrideForSessionSpawn';
import { createSpawnConcurrencyGate } from './spawn/createSpawnConcurrencyGate';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from './spawn/spawnRequestCoalescer';
import { createSpawnLifecycleCallbacks } from './spawn/createSpawnLifecycleCallbacks';
import { resolveSpawnBackendIdentity } from './spawn/resolveSpawnBackendIdentity';
import { resolveExistingSessionSpawnPreGate } from './spawn/resolveExistingSessionSpawnPreGate';
import { routeSpawnModeAndWaitForWebhook } from './spawn/routeSpawnModeAndWaitForWebhook';
import { startAutomationWorker, type AutomationWorkerHandle } from './automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from './memory/memoryWorker';
import { createDaemonConnectivityCoordinator } from './connection/createDaemonConnectivityCoordinator';
import { resolveConnectedServiceAuthForSpawn } from './connectedServices/resolveConnectedServiceAuthForSpawn';
import { shouldResolveConnectedServiceAuthForSpawn } from './connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import type { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import {
  HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
  normalizeDaemonInitialPrompt,
} from '@/agent/runtime/daemonInitialPrompt';
import { parseBooleanEnv } from '@happier-dev/protocol';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { resolveDaemonServiceLabelFromEnv, resolveDaemonTakeoverRequestedFromEnv, resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import {
  evaluateDaemonStartupServiceConflict,
  renderDaemonInstalledServiceConflict,
} from '@/daemon/ownership/daemonServiceInventory';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import { setRespawnDescriptorEncryptionMaterialForRestore } from './reattach';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function resolveDaemonRuntimeId(processEnv: NodeJS.ProcessEnv = process.env): string {
  const inheritedRuntimeId = String(processEnv.HAPPIER_DAEMON_RUNTIME_ID ?? '').trim();
  return inheritedRuntimeId || randomUUID();
}

export async function startDaemon(options: Readonly<{ takeover?: boolean }> = {}): Promise<void> {
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
  const diagnosticSubsystemGates = resolveDaemonDiagnosticSubsystemGates(process.env);

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  const runtimeId = resolveDaemonRuntimeId(process.env);
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);
  const publicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing)
    .publicLabel as NonNullable<DaemonState['publicReleaseChannel']>;

  try {
    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
    });
    if (takeoverDecision.kind === 'conflict') {
      const error = new DaemonOwnershipConflictError({
        intent: 'daemon-start',
        owner: takeoverDecision.owner,
      });
      logger.warn('[DAEMON RUN] Relay ownership conflict prevented daemon startup', {
        title: error.title,
        lines: error.lines,
      });
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource));
      return;
    }
    const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
      startupSource,
      runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
    });
    if (startupServiceConflict.kind === 'installed-background-service-conflict') {
      const message = renderDaemonInstalledServiceConflict({
        action: 'daemon-start-sync',
        services: startupServiceConflict.services,
      });
      logger.warn('[DAEMON RUN] Installed background service prevented manual daemon startup', {
        title: message.title,
        lines: message.lines,
        services: startupServiceConflict.services,
      });
      process.stderr.write(`${message.title}\n`);
      process.stderr.write(`${message.lines.map((line) => `  ${line.trimStart()}`).join('\n')}\n`);
      process.exit(1);
    }

    if (takeoverDecision.kind === 'manual-owner-takeover') {
      const takeoverNotice = buildDaemonTakeoverNotice({ action: 'start-sync' });
      logger.warn('[DAEMON RUN] Relay takeover requested; replacing the current manual relay runtime', {
        runtimeId,
        ownerCliVersion: takeoverDecision.owner.state.startedWithCliVersion,
        ownerReleaseChannel: takeoverDecision.owner.state.startedWithPublicReleaseChannel,
        title: takeoverNotice.title,
        lines: takeoverNotice.lines,
      });
      await stopDaemon();
    }

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
    setRespawnDescriptorEncryptionMaterialForRestore(credentials?.encryption ?? null);

    const api = await ApiClient.create(credentials);
    const preferredHost = await getPreferredHostName();
    const metadataForRegistration: MachineMetadata = { ...initialMachineMetadata, host: preferredHost };
    let preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null = null;

    const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion({
      expectedMachineId: machineId,
    });
    if (!runningDaemonVersionMatches) {
      logger.debug('[DAEMON RUN] Daemon version or machine identity mismatch detected, restarting daemon with current CLI version');
      await stopDaemon();
    } else {
      preflightMachineRegistration = await ensureMachineRegistered({
        api,
        machineId,
        metadata: metadataForRegistration,
        caller: 'startDaemon preflight',
      });
      machineId = preflightMachineRegistration.machineId;
      if (preflightMachineRegistration.didRotateMachineId) {
        logger.debug('[DAEMON RUN] Same-version daemon matched a stale machine id, restarting daemon with recovered machine identity');
        await stopDaemon();
      } else {
        logger.debug('[DAEMON RUN] Daemon version and machine identity match, keeping existing daemon');
        console.log('Daemon already running with matching version');
        process.exit(0);
      }
    }

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
      let connectedServiceRefreshLoopHandle: Readonly<{
        stop: () => void;
        pause: () => void;
        resume: () => void;
      }> | null = null;
      let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
      let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
      let apiMachineForSessions: ApiMachineClient | null = null;
      let automationWorker: AutomationWorkerHandle | null = null;
      let memoryWorker: MemoryWorkerHandle | null = null;
      let apiMachine: ApiMachineClient | null = null;
      let machineConnectionStateCleanup: (() => void) | null = null;
      let shutdownInitiated = false;
      let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;

        // Session spawning awaiter system
            const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
            const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
            const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
            const spawnConcurrencyGate = createSpawnConcurrencyGate(
              resolvePositiveIntEnv(process.env.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
            );

        const spawnRecentSuccessTtlMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
          2000,
          { min: 0, max: 60_000 },
        );
        const spawnRequestCoalescer = createSpawnRequestCoalescer({
          recentSuccessTtlMs: spawnRecentSuccessTtlMs,
        });

        const shutdownSpawnDrainGraceMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS,
          10_000,
          { min: 0, max: 120_000 },
        );
        const shutdownSpawnDrainPollMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_POLL_MS,
          100,
          { min: 10, max: 5_000 },
        );

        const beforeShutdown = createBeforeShutdownDrain({
          pidToAwaiter,
          pidToSpawnResultResolver,
          pidToSpawnWebhookTimeout,
          shutdownSpawnDrainGraceMs,
          shutdownSpawnDrainPollMs,
          getApiMachineForSessions: () => apiMachineForSessions,
          buildUnexpectedSpawnResult: (errorMessage) => ({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage,
          }),
        });

        const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> => {
          return await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: pidToTrackedSession.values(),
          });
        };
        const {
          loadLocalSessionMetadataForHandoff,
          loadLocalHandoffMetadataByVendorResumeId,
          savePreparedTargetLocalMetadata,
        } = createDaemonSessionHandoffMetadataBridge({
          pidToTrackedSession,
          getMachineId: () => machineId,
          activeServerDir: configuration.activeServerDir,
        });

        // Helper functions
        const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

        try {
          await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });
          if (process.platform === 'linux' && startupSource === 'background-service') {
            const migratedTrackedSessionProcesses = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
              trackedSessions: pidToTrackedSession.values(),
              daemonPid: process.pid,
            });
            if (migratedTrackedSessionProcesses.length > 0) {
              logger.debug('[DAEMON RUN] Moved reattached session runner process(es) out of the daemon service cgroup', {
                migrations: migratedTrackedSessionProcesses,
              });
            }
          }
        } finally {
          setRespawnDescriptorEncryptionMaterialForRestore(null);
        }

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
            try {
              const key = computeDaemonSpawnRequestKey(options);
              return await spawnRequestCoalescer.run(key, async () => {
            // Idempotency: a resume/attach request must never spawn a duplicate process.
            // This covers both:
            // - sessions we are tracking (including in-flight attaches), and
            // - runners started outside this daemon (lock file check).
            const existingSessionPreGate = await resolveExistingSessionSpawnPreGate({
              existingSessionId: options.existingSessionId,
              pidToTrackedSession,
              isSessionRunnerActive,
              waitForExitTimeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
              waitForExitPollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
              logDebug: (message, payload) => logger.debug(message, payload),
            });
            if (existingSessionPreGate.shortCircuitResult) {
              return existingSessionPreGate.shortCircuitResult;
            }

            return await spawnConcurrencyGate.run(async () => {
              // Do NOT log raw options: it may include secrets (env vars).
              const envKeysPreview = options.environmentVariables && typeof options.environmentVariables === 'object'
                ? Object.keys(options.environmentVariables as Record<string, unknown>)
                : [];
          const environmentVariablesValidation = validateEnvVarRecordStrict(options.environmentVariables);
              logger.debugLargeJson('[DAEMON RUN] Spawning session', {
                directory: options.directory,
                sessionId: options.sessionId,
                machineId: options.machineId,
                approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
                backendTarget: options.backendTarget,
                profileId: options.profileId,
                hasInitialPrompt: typeof options.initialPrompt === 'string' && options.initialPrompt.trim().length > 0,
                hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
                windowsRemoteSessionLaunchMode: options.windowsRemoteSessionLaunchMode,
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
                    agentModeId,
                    agentModeUpdatedAt,
                    modelId,
                    modelUpdatedAt,
                    initialPrompt,
                    experimentalCodexAcp,
                    codexBackendMode,
                    agentRuntimeDescriptorV1,
                    backendTarget,
                  } = options;
              const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
              const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
                codexBackendMode,
                experimentalCodexAcp,
                agentRuntimeDescriptorV1,
              });

              const normalizedInitialPrompt = normalizeDaemonInitialPrompt(initialPrompt);

              // NOTE: existing-session idempotency is handled before entering the spawn concurrency gate.
              const backendIdentityResolution = await resolveSpawnBackendIdentity({
                existingSessionId: typeof existingSessionId === 'string' ? existingSessionId : '',
                resume: normalizedResume,
                backendTarget,
                credentials,
                loadLocalHandoffMetadataByVendorResumeId,
              });
              if (!backendIdentityResolution.ok) {
                return backendIdentityResolution.error;
              }
              const {
                normalizedExistingSessionId,
                effectiveResume,
                effectiveBackendTarget,
                effectiveBackendTargetV2,
                sessionAttachPayload,
                catalogAgentId,
              } = backendIdentityResolution;

              // Only gate vendor resume. Happy-session reconnect (existingSessionId) is supported for all agents.
              if (effectiveResume) {
                if (effectiveBackendTarget?.kind === 'configuredAcpBackend') {
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for configured ACP backend '${effectiveBackendTarget.backendId}'.`,
                  };
                }
                const vendorResumeSupport = await getVendorResumeSupport(
                  catalogAgentId,
                );
                const ok = vendorResumeSupport(
                  canonicalCodexBackendMode
                    ? { codexBackendMode: canonicalCodexBackendMode }
                    : { experimentalCodexAcp },
                );
                if (!ok) {
                  const supportLevel = requireCatalogEntry(catalogAgentId).vendorResumeSupport;
                  const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
                  };
                }
              }
              let directoryCreated = false;

          const catalogEntry = requireCatalogEntry(catalogAgentId);
          const daemonSpawnHooks = catalogEntry.getDaemonSpawnHooks
            ? await catalogEntry.getDaemonSpawnHooks()
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
              activeServerDir: configuration.activeServerDir,
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
              if (!sessionAttachPayload) {
                throw new Error('Missing session attach payload for existing session');
              }
              const attach = await createSessionAttachFile({
                happySessionId: normalizedExistingSessionId,
                payload: sessionAttachPayload,
              });
              sessionAttachFilePath = attach.filePath;
              sessionAttachCleanup = attach.cleanup;
            }

            const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(process.env);
	            const extraEnvForChildWithMessage = {
	              ...extraEnvForChild,
	              ...(sessionAttachFilePath
	                ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
	                : {}),
	              ...(normalizedInitialPrompt
	                ? { [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: normalizedInitialPrompt }
	                : {}),
	              ...stackProcessKindOverride,
	            };
	            const spawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
	              connectedServicesBindingsRaw: options.connectedServices,
	              catalogAgentId,
	              materializationKey,
	              hasConnectedServiceAuth: () => connectedServiceAuth !== null,
	              registerConnectedServiceRefreshTarget: (target) =>
	                connectedServiceRefreshCoordinator?.registerSpawnTarget(target),
	              registerConnectedServiceQuotaTarget: (target) =>
	                connectedServiceQuotasCoordinator?.registerSpawnTarget({
	                  pid: target.pid,
	                  connectedServicesBindingsRaw: target.connectedServicesBindingsRaw as Readonly<{
	                    v?: unknown;
	                    bindingsByServiceId?: Record<string, unknown>;
	                  }>,
	                }),
	              getSpawnResourceCleanupOnExit: () => spawnResourceCleanupOnExit,
	              onSpawnResourceCleanupArmed: () => {
	                spawnResourceCleanupArmed = true;
	              },
	              spawnResourceCleanupByPid,
	              getSessionAttachCleanup: () => sessionAttachCleanup,
	              setSessionAttachCleanup: (cleanup) => {
	                sessionAttachCleanup = cleanup;
	              },
	              sessionAttachCleanupByPid,
	            });

	            return await routeSpawnModeAndWaitForWebhook({
	              terminalRequest,
              directory,
              options,
              normalizedExistingSessionId,
              effectiveResume,
              effectiveBackendTarget,
              effectiveBackendTargetV2,
              reservedSessionId: typeof sessionId === 'string' ? sessionId : undefined,
              permissionMode,
              permissionModeUpdatedAt,
              agentModeId,
              agentModeUpdatedAt,
              modelId,
              modelUpdatedAt,
              directoryCreated,
              extraEnvForChildWithMessage,
              happyHomeDir: configuration.happyHomeDir,
              pidToTrackedSession,
              pidToAwaiter,
              pidToSpawnResultResolver,
	              pidToSpawnWebhookTimeout,
	              resolveCanonicalTrackedSessionId,
	              onChildExited,
	              spawnLifecycleCallbacks,
	              cleanupSpawnResources,
	              logDebug: (message, payload) => logger.debug(message, payload),
	              warn: (message) => logger.warn(message),
            });

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
            });
            } catch (error) {
              logger.warn('[DAEMON RUN] Failed before spawn session work started', {
                error,
                hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
                hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
                backendTargetKind: options.backendTarget?.kind ?? null,
              });
              throw error;
            }
                };

            const stopSessionCore = createStopSession({ pidToTrackedSession });
        const sessionRespawnEnabled = parseBooleanEnv(process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, true);
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

                const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> => {
              return await isSessionRunnerActive(sessionId);
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
      machineId,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happier-cli'),
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
    });
    const runtimeBootstrap = await startDaemonRuntimeBootstrap({
      api,
      credentials,
      logger,
      processEnv: process.env,
      controlPort,
      machineId,
      machineIdProvider: () => machineId,
      runtimeId,
      cliVersion: packageJson.version,
      startupSource,
      serviceLabel,
      daemonLogPath: logger.logFilePath,
      controlToken,
      happyHomeDir: configuration.happyHomeDir,
      activeServerDir: configuration.activeServerDir,
      publicReleaseChannel,
      connectedServicesRestartRequestedPids,
      pidToTrackedSession,
    });
    const {
      fileState,
      initialDaemonState,
      directPeerServerLifecycle,
      directTransferPromptAssetAdapterRegistry,
      directTransferPromptRegistryRegistry,
      transferRuntimeStatePublisher,
      stopDirectPeerServer,
      stopTailscaleTransferServeLifecycle,
    } = runtimeBootstrap;
    connectedServiceRefreshCoordinator = runtimeBootstrap.connectedServiceRefreshCoordinator;
    connectedServiceRefreshLoopHandle = runtimeBootstrap.connectedServiceRefreshLoopHandle;
    connectedServiceQuotasCoordinator = runtimeBootstrap.connectedServiceQuotasCoordinator;
    connectedServiceQuotasLoopHandle = runtimeBootstrap.connectedServiceQuotasLoopHandle;

      const machineRegistrationTimeoutMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
        10_000,
        { min: 250, max: 120_000 },
      );
      const machineRegistrationRetryDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS,
        10_000,
        { min: 0, max: 5 * 60_000 },
      );
      const machineRegistrationMaxAttempts = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_MAX_ATTEMPTS,
        0,
        { min: 0, max: 10_000 },
      );

      // Do machine registration in the background so shutdown requests are not blocked by /v1/machines latency.
      startDaemonMachineRegistration({
        api,
        metadataForRegistration,
        initialDaemonState,
        machineRegistrationTimeoutMs,
        machineRegistrationRetryDelayMs,
        machineRegistrationMaxAttempts,
        initialPreflightMachineRegistration: preflightMachineRegistration,
        resolveMachineId: () => machineId,
        setMachineId: (resolvedMachineId) => {
          machineId = resolvedMachineId;
          if (fileState.machineId !== resolvedMachineId) {
            fileState.machineId = resolvedMachineId;
            writeDaemonState(fileState);
          }
        },
        isShuttingDown: () => shutdownInitiated,
        bootstrapRuntime: {
          cliVersion: packageJson.version,
          preferredHost,
          happyHomeDir: configuration.happyHomeDir,
          happyLibDir: projectPath(),
          takeoverRequested,
          isShuttingDown: () => shutdownInitiated,
          createConnectedApiMachine: (registeredMachine) =>
            diagnosticSubsystemGates.disableMachineSync
              ? null
              : api.machineSyncClient(registeredMachine, {
                  runtimeId,
                  cliVersion: packageJson.version,
                  publicReleaseChannel,
                  startupSource,
                  serviceManaged: startupSource === 'background-service',
                  ...(serviceLabel ? { serviceLabel } : null),
                }),
          attachTransferRuntimeStatePublisher: async (connectedApiMachine) => {
            if (!transferRuntimeStatePublisher) return;
            await transferRuntimeStatePublisher.attachApiMachine(connectedApiMachine);
          },
          startAutomationWorkerForMachine: (runtimeMachineId) => {
            if (diagnosticSubsystemGates.disableAutomationWorker) {
              logger.warn('[DAEMON RUN] Diagnostic gate enabled: automation worker disabled');
              return null;
            }
            return startAutomationWorker({
              token: credentials.token,
              machineId: runtimeMachineId,
              encryption: credentials.encryption,
              spawnSession,
            });
          },
          startMemoryWorkerForMachine: async (runtimeMachineId) => {
            try {
              return await startMemoryWorker({
                credentials,
                machineId: runtimeMachineId,
              });
            } catch (error) {
              logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
              return null;
            }
          },
          spawnSession,
          stopSession,
          isSessionAlreadyRunning,
          loadLocalSessionMetadataForHandoff,
          savePreparedTargetLocalMetadata,
          beforeShutdown,
          requestShutdown,
          directPeerServerLifecycle,
          directTransferPromptAssetAdapterRegistry,
          directTransferPromptRegistryRegistry,
          connectedServiceRefreshLoopHandle,
          connectedServiceQuotasLoopHandle,
        },
        onMachineSyncRuntime: (machineSyncRuntime) => {
          apiMachine = machineSyncRuntime.apiMachine;
          apiMachineForSessions = machineSyncRuntime.apiMachineForSessions;
          automationWorker = machineSyncRuntime.automationWorker;
          memoryWorker = machineSyncRuntime.memoryWorker;
          daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
          machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
        },
      });

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
      isShuttingDown: () => shutdownInitiated,
    });

    // Setup signal handlers
    const cleanupAndShutdown = async (
      source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception',
      errorMessage?: string,
    ) => {
      shutdownInitiated = true;
      await runCleanupAndShutdown({
        source,
        errorMessage,
        processEnv: process.env,
        resolvePositiveIntEnv,
        restartOnStaleVersionAndHeartbeat,
        connectedServiceRefreshLoopHandle,
        connectedServiceQuotasLoopHandle,
        apiMachine,
        machineConnectionStateCleanup,
        automationWorker,
        memoryWorker,
        trackedSessionCount: pidToTrackedSession.size,
        stopDirectPeerServer,
        stopTailscaleTransferServeLifecycle,
        stopControlServer,
        stopCaffeinate,
        daemonLockHandle,
        releaseDaemonLock,
      });
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
    if (error instanceof DaemonOwnershipConflictError) {
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource));
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    process.exit(1);
  }
}
