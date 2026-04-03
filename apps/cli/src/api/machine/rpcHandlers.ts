import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { logger } from '@/ui/logger';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';

import {
  SPAWN_SESSION_ERROR_CODES,
  resolveCanonicalCodexBackendMode,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  BackendTargetRefSchema,
  SessionContinueWithReplayRpcParamsSchema,
  SessionForkRpcParamsSchema,
  SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import psList from 'ps-list';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './rpcHandlers.sessionHandoff';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import { registerMachinePromptAssetTransferRpcHandlers } from './rpcHandlers.promptAssetTransfers';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import { registerMachinePromptRegistryTransferRpcHandlers } from './rpcHandlers.promptRegistryTransfers';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '@/backends/opencode/utils/opencodeSessionAffinity';
import { inferAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { getAcpForkContinuationHandler } from '@/backends/catalog';
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<boolean>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
};

export type MachineRpcHandlerDeps = Readonly<{
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  promptAssetsHomedir?: () => string;
  promptAssetsHappierHomeDir?: () => string;
  }>;

async function fetchForkChildSessionOrThrow(params: Readonly<{
  token: string;
  sessionId: string;
  attempts?: number;
  delayMs?: number;
}>): Promise<NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>> {
  const attempts = typeof params.attempts === 'number' && params.attempts >= 1 ? Math.floor(params.attempts) : 6;
  const delayMs = typeof params.delayMs === 'number' && params.delayMs >= 0 ? Math.floor(params.delayMs) : 250;
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const raw = await fetchSessionByIdCompat({ token: params.token, sessionId: params.sessionId });
      if (raw) return raw;
      lastError = new Error('Session fetch returned empty response');
    } catch (error) {
      lastError = error;
    }
    if (index < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
}

async function cleanupForkChildBestEffort(stopSession: (sessionId: string) => Promise<boolean>, sessionId: string): Promise<void> {
  try {
    await stopSession(sessionId);
  } catch {
    // Best-effort only: the important part is surfacing the original fork failure.
  }
}

async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
  await archiveSessionByIdBestEffort({ token, sessionId });
}

async function toCanonicalPath(path: string): Promise<string | null> {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  try {
    return await realpath(normalized);
  } catch {
    return null;
  }
}

function isKnownAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function isPathInside(targetPath: string, allowedDir: string): boolean {
  const rel = relative(allowedDir, targetPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function parseEnvBoundedInt(
  name: string,
  bounds: Readonly<{ min: number; max: number }>,
  fallback: number | null,
): number | null {
  const rawValue = process.env[name];
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): void {
  const { rpcHandlerManager, handlers } = params;
  const { spawnSession, stopSession, requestShutdown } = handlers;
  const memoryWorker = handlers.memory ?? null;

  // Register spawn session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (params: any) => {
    const {
      directory,
      spawnNonce,
      initialPrompt,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      backendTarget,
      environmentVariables,
      profileId,
      terminal,
      resume,
      connectedServices,
      transcriptStorage,
      attachMetadataIdentityPolicy,
      permissionMode,
      permissionModeUpdatedAt,
      agentModeId,
      agentModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      sessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      experimentalCodexAcp,
      codexBackendMode,
      agentRuntimeDescriptorV1,
      mcpSelection,
    } = params || {};

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    const normalizedAgentModeId =
      typeof agentModeId === 'string' && agentModeId.trim().length > 0 ? agentModeId.trim() : undefined;
    const normalizedAgentModeUpdatedAt =
      normalizedAgentModeId && typeof agentModeUpdatedAt === 'number' ? agentModeUpdatedAt : undefined;
    const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
      ? environmentVariables as Record<string, string>
      : undefined;
    const normalizedResume = typeof resume === 'string' ? resume : undefined;
    const normalizedInitialPrompt = typeof initialPrompt === 'string' ? initialPrompt : undefined;
    const normalizedSpawnNonce = typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? spawnNonce : undefined;
    const normalizedTranscriptStorage =
      transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? transcriptStorage : undefined;
    const normalizedAttachMetadataIdentityPolicy =
      attachMetadataIdentityPolicy === 'preserve_current_identity'
      || attachMetadataIdentityPolicy === 'replace_with_runtime_identity'
        ? attachMetadataIdentityPolicy
        : undefined;
    const normalizedBackendTarget = (() => {
      const parsed = BackendTargetRefSchema.safeParse(backendTarget);
      if (!parsed.success) return undefined;
      if (parsed.data.kind === 'builtInAgent') {
        const agentId = parsed.data.agentId.trim();
        if (!isKnownAgentId(agentId)) {
          return null;
        }
        return {
          kind: 'builtInAgent' as const,
          agentId,
        };
      }
      return {
        kind: 'configuredAcpBackend' as const,
        backendId: parsed.data.backendId.trim(),
      };
    })();
    if (normalizedBackendTarget === null) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      };
    }
    const normalizedMcpSelection = (() => {
      if (mcpSelection === undefined) return undefined;
      const parsed = SessionMcpSelectionV1Schema.safeParse(mcpSelection);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedSessionConfigOptionOverrides = (() => {
      if (sessionConfigOptionOverrides === undefined) return undefined;
      const parsed = AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedAgentRuntimeDescriptorV1 = (() => {
      if (agentRuntimeDescriptorV1 === undefined) return undefined;
      const parsed = AgentRuntimeDescriptorV1Schema.safeParse(agentRuntimeDescriptorV1);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedCodexBackendMode = resolveCanonicalCodexBackendMode({
      codexBackendMode,
      experimentalCodexAcp,
      agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1,
    });
    const envKeys = normalizedEnvironmentVariables ? Object.keys(normalizedEnvironmentVariables) : [];
    const maxEnvKeysToLog = 20;
    const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
    logger.debug('[API MACHINE] Spawning session', {
      directory,
      sessionId,
      machineId,
      backendTarget: normalizedBackendTarget,
      approvedNewDirectoryCreation,
      profileId,
      terminal,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasMcpSelection: normalizedMcpSelection !== undefined,
      mcpSelectionForceIncludeCount: normalizedMcpSelection?.forceIncludeServerIds.length ?? 0,
      mcpSelectionForceExcludeCount: normalizedMcpSelection?.forceExcludeServerIds.length ?? 0,
      hasResume: normalizedResume !== undefined,
      codexBackendMode: normalizedCodexBackendMode,
    });

    const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
      directory: resolvedDirectory,
      spawnNonce: normalizedSpawnNonce,
      initialPrompt: normalizedInitialPrompt,
      machineId,
      backendTarget: normalizedBackendTarget,
      environmentVariables: normalizedEnvironmentVariables,
      profileId,
      terminal,
      resume: normalizedResume,
      connectedServices,
      transcriptStorage: normalizedTranscriptStorage,
      attachMetadataIdentityPolicy: normalizedAttachMetadataIdentityPolicy,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      mcpSelection: normalizedMcpSelection,
      ...(normalizedAgentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1 } : {}),
      ...(normalizedCodexBackendMode ? { codexBackendMode: normalizedCodexBackendMode } : {}),
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const { sessionId: existingSessionId } = params;
      logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

      if (!directory) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Directory is required',
        };
      }
      if (!existingSessionId) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Session ID is required for resume',
        };
      }

      const baseSpawnOptions = buildBaseSpawnOptions(directory);
      const result = await spawnSession({
        ...baseSpawnOptions,
        existingSessionId,
        approvedNewDirectoryCreation: true,
      });

      if (result.type === 'error') {
        return result;
      }

      // For resume, we don't return a new session ID - we're reusing the existing one
      return { type: 'success' };
    }

    if (!directory) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
    }

    const baseSpawnOptions = buildBaseSpawnOptions(directory);
    const result = await spawnSession({
      ...baseSpawnOptions,
      sessionId,
      approvedNewDirectoryCreation,
    });

    switch (result.type) {
      case 'success':
        logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
        return { type: 'success', sessionId: result.sessionId };

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        return result;
    }
  });

  if (memoryWorker) {
    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker,
    });
  }

  registerMachineTerminalRpcHandlers({ rpcHandlerManager });
  registerMachineMcpServersRpcHandlers({ rpcHandlerManager });
  const promptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    homedir: params.deps?.promptAssetsHomedir,
    happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
  });
  const promptRegistryAdapterRegistry = createPromptRegistryAdapterRegistry();
  registerMachinePromptAssetsRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  registerMachinePromptAssetTransferRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  registerMachinePromptRegistriesRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
    assetRegistry: promptAssetAdapterRegistry,
    deps: {
      homedir: params.deps?.promptAssetsHomedir,
      happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    },
  });
  registerMachinePromptRegistryTransferRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
  });
  registerMachineDirectSessionsRpcHandlers({
    rpcHandlerManager,
    spawnSession,
    stopSession,
  });
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
    stopSessionForHandoff: async (sessionId) => {
      const isActive = await handlers.isSessionActive?.(sessionId) ?? false;
      if (!isActive) {
        return 'already_inactive';
      }
      return (await stopSession(sessionId)) ? 'stopped' : 'failed';
    },
    ...(handlers.loadLocalSessionMetadata ? { loadLocalSessionMetadata: handlers.loadLocalSessionMetadata } : {}),
    ...(handlers.machineTransferChannel ? { machineTransferChannel: handlers.machineTransferChannel } : {}),
    ...(handlers.directPeerTransfer ? { directPeerTransfer: handlers.directPeerTransfer } : {}),
  });

	  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, async (raw: unknown) => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const {
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode,
      permissionModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      replay,
    } = parsed.data;

    if (!isKnownAgentId(agent)) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown agent id',
      };
    }

    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'This daemon is not provisioned with dataKey credentials and cannot decrypt transcripts for replay.',
      };
    }

    const replayStrategy = (replay.strategy ?? 'recent_messages') === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';

    const resolvedSeed = await resolveReplaySeedDraft({
      credentials,
      cwd: directory,
      source: {
        kind: 'fork_chain',
        previousSessionId: replay.previousSessionId,
      },
      strategy: replayStrategy,
      recentMessagesCount: replay.recentMessagesCount ?? 250,
      maxSeedChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      summaryRunner: replay.summaryRunner ?? null,
      deps: params.deps?.runReplaySummaryForDialog
        ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : undefined,
    });
    if (!resolvedSeed) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
      };
    }

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;

    logger.debug('[API MACHINE] Continuing session with replay', {
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      previousSessionId: replay.previousSessionId,
      dialogCount: resolvedSeed.dialog.length,
      strategy: replay.strategy ?? 'recent_messages',
      recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    const nowMs = Date.now();
    const created = await (async () => {
      try {
        return await createReplaySeededSession({
          credentials,
          directory,
          agentId: agent,
          tag: `replay:${replay.previousSessionId}:${resolvedSeed.sourceCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            forkV1: {
              v: 1,
              parentSessionId: replay.previousSessionId,
              parentCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: agent },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: replay.previousSessionId,
              sourceCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
              createdAtMs: nowMs,
            },
          },
        });
      } catch (error) {
        logger.debug('[API MACHINE] Failed to create replay-seeded session', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!created) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create a new session for replay',
      };
    }

    const result = await spawnSession({
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: agent },
      approvedNewDirectoryCreation,
      existingSessionId: created.sessionId,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
    } satisfies SpawnSessionOptions);

    if (result.type === 'success') {
      return { type: 'success', sessionId: created.sessionId };
    }

    await archiveSessionBestEffort(credentials.token, created.sessionId);
    return result;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_FORK, async (raw: unknown) => {
    const parsed = SessionForkRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const { parentSessionId, forkPoint } = parsed.data;
    const requestedStrategy = typeof parsed.data.strategy === 'string' ? parsed.data.strategy : 'auto';

    if (forkPoint.type === 'seq') {
      const seq = typeof forkPoint.upToSeqInclusive === 'number' && Number.isFinite(forkPoint.upToSeqInclusive)
        ? Math.trunc(forkPoint.upToSeqInclusive)
        : NaN;
      if (!Number.isFinite(seq) || seq <= 0) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Cannot fork from an uncommitted message (missing seq).',
        };
      }
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Not authenticated',
      };
    }

    let parentSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>> | null = null;
    try {
      parentSession = await fetchSessionByIdCompat({ token: credentials.token, sessionId: parentSessionId });
    } catch (error) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: error instanceof Error ? error.message : 'Failed to load parent session',
      };
    }
    if (!parentSession) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session not found',
      };
    }

    const parentMetadata = tryDecryptSessionMetadata({
      credentials,
      rawSession: parentSession,
    });
    if (!parentMetadata) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to decrypt session metadata',
      };
    }

    const directory = typeof parentMetadata.path === 'string' && parentMetadata.path.trim().length > 0
      ? parentMetadata.path.trim()
      : '';
    if (!directory) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session metadata missing path',
      };
    }

    const unknownAgentId = '__unknown__' as CatalogAgentId;
    const agentRaw = inferAgentIdFromSessionMetadata(parentMetadata, unknownAgentId);
    if (agentRaw === unknownAgentId || !isKnownAgentId(agentRaw)) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session metadata missing agent flavor',
      };
    }

    const openCodeParentAffinity =
      agentRaw === 'opencode'
        ? readOpenCodeSessionAffinityFromMetadata(parentMetadata)
        : null;
    const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(parentMetadata);

    const targetSeqInclusive = forkPoint.type === 'seq'
      ? forkPoint.upToSeqInclusive
      : (typeof (parentSession as any)?.seq === 'number' && Number.isFinite((parentSession as any).seq) ? Math.max(0, Math.floor((parentSession as any).seq)) : 0);

    // Branch-and-edit semantics: when the fork target is a user message, the child session should
    // start from the state *before* that user message, while restoring the message as an editable draft.
    // Providers with native fork support (e.g. OpenCode) still need the original user-message seq
    // to resolve vendor message ids correctly.
    const cutoffSeqInclusive = forkPoint.type === 'seq'
      ? (() => {
        // Default to inclusive cutoff; adjust to exclusive for user messages when detectable.
        return targetSeqInclusive;
      })()
      : targetSeqInclusive;

    const resolvedCutoff = forkPoint.type === 'seq'
      ? await resolveForkCutoffSeqInclusive({
        credentials,
        parentSessionId,
        parentRawSession: parentSession,
        targetSeqInclusive,
      }).catch(() => null)
      : null;

    const effectiveCutoffSeqInclusive =
      forkPoint.type === 'seq' && resolvedCutoff
        ? resolvedCutoff.cutoffSeqInclusive
        : cutoffSeqInclusive;

    // Spawn request coalescing dedupes identical spawn fingerprints within a short window. Forking must
    // be able to create multiple sessions quickly (e.g. multi-level fork chains), so provide a
    // fork-specific nonce to guarantee unique spawn keys without leaking extra env vars to the child.
    const spawnNonce = `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`;

    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const shouldAttemptProviderNative =
      (requestedStrategy === 'auto' || requestedStrategy === 'provider_native');

    if (shouldAttemptProviderNative) {
      try {
        const nativeFork = await dispatchProviderNativeFork({
          credentials,
          agentId: agentRaw,
          parentSessionId,
          parentRawSession: parentSession,
          parentMetadata,
          directory,
          forkPoint: forkPoint.type === 'seq'
            ? { type: 'seq', upToSeqInclusive: targetSeqInclusive }
            : { type: 'latest' },
          targetSeqInclusive,
        });

        if (nativeFork) {
          const result = await spawnSession({
            directory,
            backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
            approvedNewDirectoryCreation: true,
            spawnNonce,
            ...nativeFork.spawn,
            ...inheritedForkOverrides.spawn,
          } satisfies SpawnSessionOptions);

          if (requestedStrategy === 'provider_native' && result.type !== 'success') {
            return {
              ok: false,
              errorCode: (result as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
              errorMessage: (result as any)?.errorMessage ?? 'Failed to spawn provider-native fork session',
            };
          }

          if (result.type === 'success' && result.sessionId) {
            const childSessionId = result.sessionId;
            if (childSessionId === parentSessionId) {
              return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
            }
            try {
              const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
              await updateSessionMetadataWithRetry({
                token: credentials.token,
                credentials,
                sessionId: childSessionId,
                rawSession: childRaw,
                updater: (metadata) => ({
                  ...metadata,
                  ...inheritedForkOverrides.metadata,
                  ...nativeFork.metadata,
                  forkV1: {
                    v: 1,
                    parentSessionId,
                    parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                    createdAtMs: Date.now(),
                    strategy: 'provider_native',
                    providerHint: nativeFork.providerHint,
                  },
                }),
                maxAttempts: 6,
              });
            } catch (error) {
              await cleanupForkChildBestEffort(stopSession, childSessionId);
              await archiveSessionBestEffort(credentials.token, childSessionId);
              return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
              };
            }
            return { ok: true, childSessionId };
          }
        }
      } catch (error) {
        if (requestedStrategy === 'provider_native') {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Provider-native fork failed',
          };
        }
      }
    }

    const shouldAttemptAcpForkLatest =
      (requestedStrategy === 'auto' || requestedStrategy === 'acp_fork_latest') &&
      (forkPoint.type === 'latest') &&
      isAcpForkEligibleForProvider({ providerId: agentRaw, metadata: parentMetadata });

    if (shouldAttemptAcpForkLatest) {
      // Best-effort ACP fork: only applies when the parent session can be resumed as an ACP session.
      // If unsupported, fall back to replay fork below.
      try {
        const vendorSessionIdRaw = resolveVendorResumeIdFromSessionMetadata(agentRaw as any, parentMetadata) ?? '';

        if (vendorSessionIdRaw) {
          const { createCatalogAcpBackend } = await import('@/agent/acp/createCatalogAcpBackend');
          const created = await createCatalogAcpBackend(agentRaw as any, {
            cwd: directory,
            mcpServers: {},
            permissionHandler: {
              handleToolCall: async () => ({ decision: 'denied' as const }),
            },
          } as any);

          try {
            if (typeof created.backend.loadSession === 'function' && typeof (created.backend as any).forkSession === 'function') {
              await created.backend.loadSession(vendorSessionIdRaw as any);
              const forked = await (created.backend as any).forkSession({
                sessionId: vendorSessionIdRaw,
              });
              const forkedSessionId = typeof forked?.sessionId === 'string' ? String(forked.sessionId).trim() : '';
              if (forkedSessionId) {
                const acpForkContinuation = await getAcpForkContinuationHandler(agentRaw);
                const continuationShape = acpForkContinuation
                  ? await acpForkContinuation({
                    agentId: agentRaw,
                    parentMetadata,
                    vendorSessionId: forkedSessionId,
                  })
                  : null;

                const result = await spawnSession({
                  directory,
                  backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
                  approvedNewDirectoryCreation: true,
                  resume: forkedSessionId,
                  ...(continuationShape?.spawn ?? {}),
                  ...inheritedForkOverrides.spawn,
                } satisfies SpawnSessionOptions);

                if (requestedStrategy === 'acp_fork_latest' && result.type !== 'success') {
                  return {
                    ok: false,
                    errorCode: (result as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: (result as any)?.errorMessage ?? 'Failed to spawn ACP fork session',
                  };
                }

                if (result.type === 'success' && result.sessionId) {
                  const childSessionId = result.sessionId;
                  if (childSessionId === parentSessionId) {
                    return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
                  }
                  try {
                    const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
                    await updateSessionMetadataWithRetry({
                      token: credentials.token,
                      credentials,
                      sessionId: childSessionId,
                      rawSession: childRaw,
                      updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkOverrides.metadata,
                        ...(continuationShape?.metadata ?? {}),
                        forkV1: {
                          v: 1,
                          parentSessionId,
                          parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          providerHint: continuationShape?.providerHint ?? {
                            providerId: agentRaw,
                            vendorSessionId: forkedSessionId,
                          },
                        },
                      }),
                        maxAttempts: 6,
                      });
                  } catch (error) {
                    await cleanupForkChildBestEffort(stopSession, childSessionId);
                    await archiveSessionBestEffort(credentials.token, childSessionId);
                    return {
                      ok: false,
                      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                      errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
                    };
                  }
                  return { ok: true, childSessionId };
                }
              }
            }
          } finally {
            await created.backend.dispose().catch(() => {});
          }
        }
      } catch {
        // Ignore and fall back to replay fork below.
      }
    }

    if (requestedStrategy !== 'auto' && requestedStrategy !== 'replay') {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Requested fork strategy is not supported',
      };
    }

    const replaySummaryRunner = parsed.data.replaySummaryRunner;

    const resolvedSeed = await resolveReplaySeedDraft({
      credentials,
      cwd: directory,
      source: {
        kind: 'fork_chain',
        previousSessionId: parentSessionId,
        ...(forkPoint.type === 'seq' ? { upToSeqInclusive: effectiveCutoffSeqInclusive } : {}),
      },
      strategy: replaySummaryRunner ? 'summary_plus_recent' : 'recent_messages',
      recentMessagesCount: configuration.replaySeedCandidateLimit,
      maxSeedChars: typeof parsed.data.replayMaxSeedChars === 'number' ? parsed.data.replayMaxSeedChars : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      summaryRunner: replaySummaryRunner ?? null,
      deps: params.deps?.runReplaySummaryForDialog
        ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : undefined,
    });
    if (!resolvedSeed) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
      };
    }

    const nowMs = Date.now();
    const created = await (async () => {
      try {
        return await createReplaySeededSession({
          credentials,
          directory,
          agentId: agentRaw,
          tag: `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            ...inheritedForkOverrides.metadata,
            ...(agentRaw === 'opencode'
              ? applyOpenCodeSessionAffinityMetadata({
                backendMode: openCodeParentAffinity?.backendMode ?? 'server',
                serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
              })
              : {}),
            forkV1: {
              v: 1,
              parentSessionId,
              parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: agentRaw },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: parentSessionId,
              sourceCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
            },
          },
        });
      } catch (error) {
        logger.debug('[API MACHINE] Failed to create fork session for replay', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!created) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create fork session',
      };
    }

    const spawnResult = await spawnSession({
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
      approvedNewDirectoryCreation: true,
      spawnNonce,
      existingSessionId: created.sessionId,
      ...(agentRaw === 'opencode'
        ? {
          environmentVariables: buildOpenCodeSessionEnvironmentVariables({
            backendMode: openCodeParentAffinity?.backendMode ?? 'server',
            serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
            serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
          }),
        }
        : {}),
      ...inheritedForkOverrides.spawn,
    } satisfies SpawnSessionOptions);

    if (spawnResult.type !== 'success') {
      await archiveSessionBestEffort(credentials.token, created.sessionId);
      return {
        ok: false,
        errorCode: (spawnResult as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: (spawnResult as any)?.errorMessage ?? 'Failed to spawn fork session',
      };
    }

    if (created.sessionId === parentSessionId) {
      return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
    }

    return { ok: true, childSessionId: created.sessionId };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, async () => {
    const markers = await listExecutionRunMarkers();

    let processIndex = new Map<number, DaemonExecutionRunProcessInfo>();
    try {
      const processes = await psList();
	      processIndex = new Map(
	        processes.map((proc) => [
	          proc.pid,
	          {
	            pid: proc.pid,
	            name: typeof proc.name === 'string' ? proc.name : undefined,
	            cpu: typeof (proc as any).cpu === 'number' ? (proc as any).cpu : undefined,
	            memory: typeof (proc as any).memory === 'number' ? (proc as any).memory : undefined,
	          },
	        ]),
	      );
    } catch {
      // best-effort; omit process stats if ps-list fails
    }

    const runs: DaemonExecutionRunEntry[] = markers.map((marker) => {
      const process = processIndex.get(marker.pid);
      return process ? { ...marker, process } : marker;
    });

    return { runs };
  });

  // Register stop session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_SESSION, async (params: any) => {
    const { sessionId } = params || {};

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const success = await stopSession(sessionId);
    if (!success) {
      throw new Error('Session not found or failed to stop');
    }

    logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
    return { message: 'Session stopped' };
  });

  // Register stop daemon handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_DAEMON, () => {
    logger.debug('[API MACHINE] Received stop-daemon RPC request');

    // Trigger shutdown callback after a delay
    setTimeout(() => {
      logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
      requestShutdown();
    }, 100);

    return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    if (!path) {
      return {
        success: false,
        error: 'Session log path is required',
      };
    }
    if (!path.toLowerCase().endsWith('.log')) {
      return {
        success: false,
        error: 'Session log path must point to a .log file',
      };
    }

    const canonicalRequestedPath = await toCanonicalPath(path);
    if (!canonicalRequestedPath) {
      return {
        success: false,
        error: 'Session log path is unavailable on this machine',
      };
    }

    const canonicalHappyHomeDir = await toCanonicalPath(resolve(configuration.happyHomeDir));
    if (!canonicalHappyHomeDir) {
      return {
        success: false,
        error: 'Happy home directory is unavailable for log validation',
      };
    }

    const allowedRoots = [
      resolve(canonicalHappyHomeDir, 'logs'),
      resolve(canonicalHappyHomeDir, 'stacks'),
    ];
    if (!allowedRoots.some((dir) => isPathInside(canonicalRequestedPath, dir))) {
      return {
        success: false,
        error: 'Requested log path is outside allowed Happier directories',
      };
    }

    try {
      const fileStat = await stat(canonicalRequestedPath);
      const tail = await readBugReportLogTail(canonicalRequestedPath, maxBytes);
      return {
        success: true,
        path: canonicalRequestedPath,
        tail,
        truncated: fileStat.size > maxBytes,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, async () => {
    return await collectBugReportMachineDiagnosticsSnapshotForBugReport();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    const diagnostics = await collectBugReportMachineDiagnosticsSnapshotForBugReport();
    const allowedPaths = new Set<string>();
    if (diagnostics.daemonState?.daemonLogPath) {
      allowedPaths.add(diagnostics.daemonState.daemonLogPath.trim());
    }
    for (const entry of diagnostics.daemonLogs) {
      if (typeof entry.path === 'string' && entry.path.trim().length > 0) {
        allowedPaths.add(entry.path.trim());
      }
    }
    for (const entry of diagnostics.stackContext?.logCandidates ?? []) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        allowedPaths.add(entry.trim());
      }
    }

    const canonicalAllowedPaths = new Set<string>();
    for (const candidatePath of allowedPaths) {
      const canonicalPath = await toCanonicalPath(candidatePath);
      if (canonicalPath) {
        canonicalAllowedPaths.add(canonicalPath);
      }
    }

    let canonicalRequestedPath: string | null = null;
    if (path) {
      canonicalRequestedPath = await toCanonicalPath(path);
      if (!canonicalRequestedPath || !canonicalAllowedPaths.has(canonicalRequestedPath)) {
        return {
          ok: false,
          error: 'Requested log path is not allowed for bug report diagnostics',
        };
      }
    }

    const fallbackPath = Array.from(canonicalAllowedPaths)[0] ?? null;
    const targetPath = canonicalRequestedPath ?? fallbackPath;
    if (!targetPath) {
      return {
        ok: false,
        error: 'No daemon log path available',
      };
    }

    try {
      const tail = await readBugReportLogTail(targetPath, maxBytes);
      return {
        ok: true,
        path: targetPath,
        tail,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT, async (params: any) => {
    // Upload is intentionally delegated to UI/service clients via pre-signed URLs.
    // Keep the RPC for capability negotiation and future transport optimizations.
    return {
      ok: false,
      error: 'Daemon-side upload is not enabled; upload via report service pre-signed URL from UI.',
      uploadUrl: typeof params?.uploadUrl === 'string' ? params.uploadUrl : null,
    };
  });
}
