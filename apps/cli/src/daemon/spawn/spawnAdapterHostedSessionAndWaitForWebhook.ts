import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import type { TerminalHostHandle } from '@happier-dev/agents';
import { classifySpawnFailure, spawnFailureMessage, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';

import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { resolveTerminalHostCreationFailure, resolveTerminalHostUnavailableSpawnErrorDetail } from '@/integrations/terminal/host/errors';
import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';
import {
  createTerminalAttachmentId,
  writeTerminalHostAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import type { RunnerAgentSessionBootstrapAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { ChildExit } from '../sessions/onChildExited';
import type { RunnerAgentInvocationContext, TrackedSession } from '../types';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import { waitForTerminalHostedSessionWebhook } from './waitForTerminalHostedSessionWebhook';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from '../platform/linux/systemdUserResourceGovernor';
import { PROCESS_OWNER_ENV_KEY, readHostProcessOwnerTag, withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import { cleanupUnstartedLaunch } from './cleanupUnstartedLaunch';

export async function spawnAdapterHostedSessionAndWaitForWebhook(params: Readonly<{
  terminalRequest: ResolvedTerminalRequest;
  startingMode?: 'terminal' | 'remote';
  directory: string;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
  effectiveResume: string;
  effectiveBackendTargetV2: BackendTargetRefV2;
  sessionControlArgs: readonly string[];
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  runnerAgentSessionBootstrapAuthorization?: RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
  processEnv: NodeJS.ProcessEnv;
  happyHomeDir: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void | Promise<void>;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
  sanitizeDiagnosticText?: (value: string) => string;
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  memoryHighBytes?: number | null;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
  onUntrackedHostedChild: () => void;
}>): Promise<SpawnSessionResult | null> {
  if (params.terminalRequest.requested !== 'zellij' && params.terminalRequest.requested !== 'herdr') return null;
  const hostKind = params.terminalRequest.requested;
  const displayName = hostKind === 'zellij' ? 'Zellij' : 'Herdr';
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const agentCommand = resolveDaemonCliSubcommandFromBackendTarget(params.effectiveBackendTargetV2);
  if (!agentCommand) {
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Unknown backend target' };
  }

  const inventory = await createDefaultTerminalHostAdapterInventory({
    happyHomeDir: params.happyHomeDir,
    preference: hostKind,
    ...(hostKind === 'herdr' ? { herdrSessionName: params.terminalRequest.herdr.sessionName,
      herdrSocketPath: params.terminalRequest.herdr.socketPath } : {}),
  });
  const adapter = inventory.adapters[hostKind];
  if (!adapter) {
    await cleanupUnstartedLaunch(params);
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: `${displayName} hosting requires a supported ${displayName} installation on this machine.`,
      errorDetail: { kind: 'terminal_host_unavailable', host: hostKind, reason: 'installation_unavailable' },
    };
  }

  const attachmentId = createTerminalAttachmentId();
  const terminalRuntimeArgs = [
    '--happy-terminal-mode', hostKind,
    '--happy-terminal-requested', hostKind,
    '--happy-terminal-attachment-id', attachmentId,
    ...(hostKind === 'herdr'
      ? ['--happy-herdr-session-name', params.terminalRequest.herdr.sessionName,
          ...(params.terminalRequest.herdr.socketPath ? ['--happy-herdr-socket-path', params.terminalRequest.herdr.socketPath] : [])]
      : []),
  ];
  const args = [
    agentCommand,
    '--happy-starting-mode', params.startingMode ?? 'terminal',
    '--started-by', 'daemon',
    ...terminalRuntimeArgs,
    ...params.sessionControlArgs,
  ];
  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true });
  const childEnv = buildSpawnChildProcessEnv({
    ...(params.normalizedExistingSessionId ? { processOwner: { kind: 'session' as const, sessionId: params.normalizedExistingSessionId } } : {}),
    happierHomeDir: params.happyHomeDir,
    processEnv: params.processEnv,
    extraEnv: {
      ...params.extraEnvForChildWithMessage,
      ...(launchSpec.env ?? {}),
      HAPPIER_TERMINAL_ATTACHMENT_ID: attachmentId,
    },
    unsetEnvKeys: params.unsetEnvKeys,
  });
  const spawnEnv = process.platform === 'linux' && !params.normalizedExistingSessionId
    ? withHostProcessOwnerEnvironment(childEnv, readHostProcessOwnerTag(params.processEnv))
    : childEnv;
  const scopedLaunchSpec = process.platform === 'linux'
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({ launchSpec: { ...launchSpec, env: spawnEnv }, environment: params.processEnv,
      unit: createHappierLinuxScopeName(spawnEnv.HAPPIER_PROCESS_OWNER), memoryHighBytes: params.memoryHighBytes })
    : null;
  const effectiveLaunchSpec = scopedLaunchSpec ?? launchSpec;
  const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
  if (commitRefusal) return commitRefusal;

  const sessionName = hostKind === 'herdr'
    ? params.terminalRequest.herdr.sessionName
    : `happier-${agentCommand}-${Date.now()}`;
  let handle: TerminalHostHandle | null = null;
  try {
    handle = await adapter.createOrAttachHost({
      sessionName,
      workingDirectory: params.directory,
      spawnArgv: [effectiveLaunchSpec.filePath, ...effectiveLaunchSpec.args],
      spawnEnv: { ...spawnEnv, ...effectiveLaunchSpec.env },
      unsetEnvKeys: params.unsetEnvKeys?.filter(key => key.toUpperCase() !== PROCESS_OWNER_ENV_KEY),
      isolatedEnv: true,
    });
    const createdHandle = handle;
    const liveness = await adapter.evaluateLiveness(createdHandle);
    if (!liveness.panePid) throw new Error(`${displayName} did not report the launched runner PID`);
    const terminal = buildTerminalMetadataFromHostHandle(createdHandle);
    const spawnResult = await waitForTerminalHostedSessionWebhook({
      pid: liveness.panePid,
      label: hostKind,
      normalizedExistingSessionId: params.normalizedExistingSessionId,
      trackedSpawnOptions: params.trackedSpawnOptions,
      ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
      effectiveResume: params.effectiveResume,
      directoryCreated: params.directoryCreated,
      message: params.directoryCreated
        ? `The path '${params.trackedSpawnOptions.directory}' did not exist. We created a new folder and spawned a new session in ${displayName}.`
        : `Spawned new session in ${displayName}.`,
      trackedSessionFields: { hostedTerminal: terminal,
        ...(scopedLaunchSpec?.linuxLaunchUnit ? { linuxLaunchUnit: scopedLaunchSpec.linuxLaunchUnit } : {}),
      },
      runnerAgentSessionBootstrapAuthorization: params.runnerAgentSessionBootstrapAuthorization,
      runnerAgentInvocationContext: params.runnerAgentInvocationContext,
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      pidToSpawnResultResolver: params.pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
      takeoverAdmission: params.takeoverAdmission,
      onChildExited: params.onChildExited,
      spawnLifecycleCallbacks: params.spawnLifecycleCallbacks,
      cleanupSpawnResources: params.cleanupSpawnResources,
      cancelOwnedHost: async () => {
        try {
          await adapter.dispose(createdHandle);
          return true;
        } catch {
          return false;
        }
      },
      bindCanonicalSession: async (canonicalSessionId) => {
        await writeTerminalHostAttachmentInfo({
          happyHomeDir: params.happyHomeDir,
          sessionId: canonicalSessionId,
          handle: { ...createdHandle, attachmentId },
        });
      },
      logDebug: params.logDebug,
      warn: params.warn,
      sanitizeDiagnosticText,
    });
    return spawnResult;
  } catch (error) {
    let failure = resolveTerminalHostCreationFailure(error);
    if (handle) {
      try {
        await adapter.dispose(handle);
        failure = { creationDisposition: 'created_and_absent', cleanupIncomplete: false };
      } catch {
        failure = { creationDisposition: 'created_or_uncertain', cleanupIncomplete: true };
      }
    }
    if (failure.creationDisposition !== 'created_or_uncertain') {
      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(() => params.cleanupSpawnResources()),
        Promise.resolve().then(() => params.spawnLifecycleCallbacks.cleanupPendingSessionAttach()),
      ]);
      if (cleanupResults.some((result) => result.status === 'rejected')) {
        failure = { ...failure, cleanupIncomplete: true };
      }
    }
    if (failure.creationDisposition === 'created_or_uncertain') params.onUntrackedHostedChild();
    if (failure.creationDisposition === 'created_or_uncertain' || failure.cleanupIncomplete) {
      params.warn(`[DAEMON RUN] ${displayName} launch cleanup could not be completed (terminal_host_launch_cleanup_incomplete, disposition=${failure.creationDisposition})`);
    }
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: params.readSpawnFailureLimits?.() });
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: spawnFailureMessage(spawnFailure, `${displayName} runner launch failed: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`),
      errorDetail: resolveTerminalHostUnavailableSpawnErrorDetail(error) ?? { kind: 'spawn_failure', ...spawnFailure },
    };
  }
}
