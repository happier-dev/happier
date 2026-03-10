import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  BackendTargetRefSchema,
  SessionContinueWithReplayRpcParamsSchema,
  SessionForkRpcParamsSchema,
  SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';
import {
  buildHappierReplayPromptFromDialog,
} from '@happier-dev/agents';
import { isPermissionMode } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { hydrateReplayDialogFromTranscript } from '@/session/replay/hydrateReplayDialogFromTranscript';
import { hydrateReplayDialogFromForkChain } from '@/session/replay/hydrateReplayDialogFromForkChain';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import psList from 'ps-list';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { configuration } from '@/configuration';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffProviderBundle,
  SessionHandoffWorkspaceBundle,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '@/backends/opencode/utils/opencodeSessionAffinity';

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<boolean>;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  directPeerTransfer?: Readonly<{
    publishTransfer: (params: Readonly<{
      handoffId: string;
      bundles: Readonly<{
        providerBundle: SessionHandoffProviderBundle;
        workspaceBundle?: SessionHandoffWorkspaceBundle;
      }>;
    }>) => readonly TransferEndpointCandidate[];
    requestBundles?: (params: Readonly<{
      handoffId: string;
      endpointCandidates: readonly TransferEndpointCandidate[];
    }>) => Promise<Readonly<{
      providerBundle: SessionHandoffProviderBundle;
      workspaceBundle?: SessionHandoffWorkspaceBundle;
    }>>;
    clearPublishedTransfer: (handoffId: string) => void;
  }>;
};

export type MachineRpcHandlerDeps = Readonly<{
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  promptAssetsHomedir?: () => string;
  promptAssetsHappierHomeDir?: () => string;
}>;

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
      token,
      environmentVariables,
      profileId,
      terminal,
      resume,
      connectedServices,
      transcriptStorage,
      permissionMode,
      permissionModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      experimentalCodexAcp,
      mcpSelection,
    } = params || {};

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
      ? environmentVariables as Record<string, string>
      : undefined;
    const normalizedResume = typeof resume === 'string' ? resume : undefined;
    const normalizedInitialPrompt = typeof initialPrompt === 'string' ? initialPrompt : undefined;
    const normalizedSpawnNonce = typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? spawnNonce : undefined;
    const normalizedTranscriptStorage =
      transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? transcriptStorage : undefined;
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
      hasToken: !!token,
      terminal,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasMcpSelection: normalizedMcpSelection !== undefined,
      mcpSelectionForceIncludeCount: normalizedMcpSelection?.forceIncludeServerIds.length ?? 0,
      mcpSelectionForceExcludeCount: normalizedMcpSelection?.forceExcludeServerIds.length ?? 0,
      hasResume: normalizedResume !== undefined,
      experimentalCodexAcp: experimentalCodexAcp === true,
    });

    const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
      directory: resolvedDirectory,
      spawnNonce: normalizedSpawnNonce,
      initialPrompt: normalizedInitialPrompt,
      machineId,
      backendTarget: normalizedBackendTarget,
      token,
      environmentVariables: normalizedEnvironmentVariables,
      profileId,
      terminal,
      resume: normalizedResume,
      connectedServices,
      transcriptStorage: normalizedTranscriptStorage,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      mcpSelection: normalizedMcpSelection,
      experimentalCodexAcp,
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const {
        sessionId: existingSessionId,
        experimentalCodexAcp
      } = params;
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
        experimentalCodexAcp: Boolean(experimentalCodexAcp),
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
  registerMachinePromptAssetsRpcHandlers({
    rpcHandlerManager,
    deps: {
      homedir: params.deps?.promptAssetsHomedir,
      happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    },
  });
  registerMachinePromptRegistriesRpcHandlers({
    rpcHandlerManager,
    deps: {
      homedir: params.deps?.promptAssetsHomedir,
      happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    },
  });
  registerMachineDirectSessionsRpcHandlers({
    rpcHandlerManager,
    spawnSession,
    stopSession,
  });
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
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

    const hydrated = await hydrateReplayDialogFromForkChain({
      credentials,
      startingSessionId: replay.previousSessionId,
      limit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      wantSynopsisText: replayStrategy === 'summary_plus_recent',
    }).catch(() => null);
    if (!hydrated || hydrated.dialog.length === 0) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }

	    const summaryText = await (async () => {
	      if (replayStrategy !== 'summary_plus_recent') return null;
	      const hydratedSynopsis = typeof (hydrated as any)?.synopsisText === 'string' ? String((hydrated as any).synopsisText).trim() : '';
	      if (hydratedSynopsis) return hydratedSynopsis;

	      const summaryRunner = (replay as any)?.summaryRunner;
	      if (summaryRunner && resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled') {
	        try {
	          const fn = params.deps?.runReplaySummaryForDialog ?? runReplaySummaryForDialog;
	          const generated = await fn({
	            cwd: directory,
	            parentSessionId: replay.previousSessionId,
	            runner: summaryRunner,
	            dialog: hydrated.dialog,
	          });
	          const trimmed = typeof generated === 'string' ? generated.trim() : '';
	          if (trimmed) return trimmed;
	        } catch {
	          // Best-effort only: fall back to any cached/metadata summary.
	        }
	      }

	      return null;
	    })();

    const seedDraft = buildHappierReplayPromptFromDialog({
      previousSessionId: replay.previousSessionId,
      strategy: replayStrategy,
      recentMessagesCount: replay.recentMessagesCount ?? 250,
      summaryText,
      dialog: hydrated.dialog,
      maxPromptChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
    });

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
      dialogCount: hydrated.dialog.length,
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
          tag: `replay:${replay.previousSessionId}:${hydrated.sourceCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            forkV1: {
              v: 1,
              parentSessionId: replay.previousSessionId,
              parentCutoffSeqInclusive: hydrated.sourceCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: agent },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: replay.previousSessionId,
              sourceCutoffSeqInclusive: hydrated.sourceCutoffSeqInclusive,
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

    const parentSession = await fetchSessionById({ token: credentials.token, sessionId: parentSessionId }).catch(() => null);
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

    const agentRaw = typeof parentMetadata.flavor === 'string' ? parentMetadata.flavor.trim() : '';
    if (!agentRaw || !isKnownAgentId(agentRaw)) {
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

    if (shouldAttemptProviderNative && agentRaw === 'opencode') {
      try {
        const backendMode = openCodeParentAffinity?.backendMode ?? '';
        const vendorSessionIdRaw = typeof (parentMetadata as any)?.opencodeSessionId === 'string'
          ? String((parentMetadata as any).opencodeSessionId).trim()
          : '';

        if (backendMode === 'server' && vendorSessionIdRaw) {
          const { forkOpenCodeSessionNative } = await import('@/backends/opencode/server/nativeFork');
          const forked = await forkOpenCodeSessionNative({
            credentials,
            parentHappySessionId: parentSessionId,
            parentRawSession: parentSession,
            directory,
            parentOpenCodeSessionId: vendorSessionIdRaw,
            forkPoint: forkPoint.type === 'seq'
              ? { type: 'seq', upToSeqInclusive: targetSeqInclusive }
              : { type: 'latest' },
          }).catch(() => null);

          const forkedVendorSessionId = typeof forked?.vendorSessionId === 'string' ? forked.vendorSessionId.trim() : '';
          if (forkedVendorSessionId) {
            const result = await spawnSession({
              directory,
              backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
              approvedNewDirectoryCreation: true,
              spawnNonce,
              resume: forkedVendorSessionId,
              environmentVariables: buildOpenCodeSessionEnvironmentVariables({
                backendMode: 'server',
                serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
              }),
              ...inheritedForkOverrides.spawn,
            } satisfies SpawnSessionOptions);

            if (result.type === 'success' && result.sessionId) {
              const childSessionId = result.sessionId;
              if (childSessionId === parentSessionId) {
                return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
              }
              const childRaw = await fetchSessionById({ token: credentials.token, sessionId: childSessionId }).catch(() => null);
              if (childRaw) {
                await updateSessionMetadataWithRetry({
                  token: credentials.token,
                  credentials,
                  sessionId: childSessionId,
                  rawSession: childRaw,
                      updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkOverrides.metadata,
                        ...applyOpenCodeSessionAffinityMetadata({
                          backendMode: 'server',
                          vendorSessionId: forkedVendorSessionId,
                          serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                          serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
                        }),
                        forkV1: {
                          v: 1,
                          parentSessionId,
                      parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                      createdAtMs: Date.now(),
                      strategy: 'provider_native',
                      providerHint: {
                        providerId: agentRaw,
                        backendMode: 'server',
                        vendorSessionId: forkedVendorSessionId,
                      },
                    },
                  }),
                  maxAttempts: 6,
                });
              }
              return { ok: true, childSessionId };
            }
          }
        }
      } catch {
        // Ignore and fall back (auto) or error below (provider_native).
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
        const vendorSessionIdKey = `${agentRaw}SessionId`;
          const vendorSessionIdRaw = typeof (parentMetadata as any)?.[vendorSessionIdKey] === 'string'
          ? String((parentMetadata as any)[vendorSessionIdKey]).trim()
          : '';

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
                const result = await spawnSession({
                  directory,
                  backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
                  approvedNewDirectoryCreation: true,
                  resume: forkedSessionId,
                  ...(agentRaw === 'codex' ? { experimentalCodexAcp: true } : {}),
                  ...(agentRaw === 'opencode'
                    ? {
                      environmentVariables: buildOpenCodeSessionEnvironmentVariables({
                        backendMode: 'acp',
                        serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                      }),
                    }
                    : {}),
                  ...inheritedForkOverrides.spawn,
                } satisfies SpawnSessionOptions);

                if (result.type === 'success' && result.sessionId) {
                  const childSessionId = result.sessionId;
                  if (childSessionId === parentSessionId) {
                    return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
                  }
                  const childRaw = await fetchSessionById({ token: credentials.token, sessionId: childSessionId }).catch(() => null);
                  if (childRaw) {
                    await updateSessionMetadataWithRetry({
                      token: credentials.token,
                      credentials,
                      sessionId: childSessionId,
                      rawSession: childRaw,
                      updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkOverrides.metadata,
                        ...(agentRaw === 'opencode'
                          ? applyOpenCodeSessionAffinityMetadata({
                            backendMode: 'acp',
                            vendorSessionId: forkedSessionId,
                            serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                            serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
                          })
                          : {}),
                        forkV1: {
                          v: 1,
                          parentSessionId,
                          parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          providerHint: { providerId: agentRaw, vendorSessionId: forkedSessionId },
                        },
                      }),
                      maxAttempts: 6,
                    });
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
    const summaryRequested = Boolean(replaySummaryRunner);

    const hydrated = await hydrateReplayDialogFromForkChain({
      credentials,
      startingSessionId: parentSessionId,
      limit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      wantSynopsisText: summaryRequested,
      ...(forkPoint.type === 'seq' ? { upToSeqInclusive: effectiveCutoffSeqInclusive } : {}),
    }).catch(() => null);
    if (!hydrated || hydrated.dialog.length === 0) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }

	    const summaryText = summaryRequested
      ? await (async () => {
	      const hydratedSynopsis = typeof (hydrated as any)?.synopsisText === 'string'
	        ? String((hydrated as any).synopsisText).trim()
	        : '';
	      if (hydratedSynopsis) return hydratedSynopsis;

	      if (replaySummaryRunner && resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled') {
	        try {
	          const fn = params.deps?.runReplaySummaryForDialog ?? runReplaySummaryForDialog;
	          const generated = await fn({
	            cwd: directory,
	            parentSessionId,
	            runner: replaySummaryRunner,
	            dialog: hydrated.dialog,
	          });
	          const trimmed = typeof generated === 'string' ? generated.trim() : '';
	          if (trimmed) return trimmed;
	        } catch {
	          // Best-effort only.
	        }
	      }

	      return null;
	    })()
      : null;

	    const seedDraft = buildHappierReplayPromptFromDialog({
	      previousSessionId: parentSessionId,
	      strategy: summaryText ? 'summary_plus_recent' : 'recent_messages',
	      recentMessagesCount: hydrated.dialog.length,
	      summaryText,
	      dialog: hydrated.dialog,
        maxPromptChars: typeof parsed.data.replayMaxSeedChars === 'number' ? parsed.data.replayMaxSeedChars : configuration.replaySeedMaxChars,
	    });

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
          }),
        }
        : {}),
      ...inheritedForkOverrides.spawn,
    } satisfies SpawnSessionOptions);

    if (spawnResult.type !== 'success') {
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
