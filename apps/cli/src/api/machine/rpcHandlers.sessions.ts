import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from '@/rpc/handlers/spawnRuntimeSelection';
import { canonicalizeSpawnBackendTargetFromTransportInput } from '@/rpc/handlers/spawnSessionOptionsContract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  AcpConfigOptionOverridesV1Schema,
  parseSessionContinueWithReplayRpcParamsCompatIngress,
  SessionForkRpcParamsSchema,
  SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/api/types';
import { readCredentials } from '@/persistence';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
import { configuration } from '@/configuration';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
	import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
	import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
	import { getAcpForkContinuationHandler, getReplayForkContinuationHandler } from '@/backends/catalog';
	import type { AcpForkContinuationResult } from '@/session/fork/acpForkContinuationHandler';
	import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
	import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
	import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
	import { isAuthenticationError } from '@/api/client/httpStatusError';

	import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
	import type { MachineRpcHandlerDeps, MachineRpcHandlers } from './rpcHandlers';

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
      if (isAuthenticationError(error)) throw error;
      lastError = error;
    }
    if (index < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
}

async function cleanupForkChildBestEffort(
  stopSession: MachineRpcHandlers['stopSession'],
  sessionId: string,
): Promise<void> {
  try {
    await stopSession(sessionId);
  } catch {
    // Best-effort only: the important part is surfacing the original fork failure.
  }
}

async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
  await archiveSessionByIdBestEffort({ token, sessionId });
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

export function registerMachineSessionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): void {
  const { rpcHandlerManager, handlers } = params;
  const { spawnSession, stopSession } = handlers;
  const sessionHostBridge = getSessionHostBridge();

  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (rawParams: any) => {
    const {
      directory,
      spawnNonce,
      initialPrompt,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      backendTarget,
      agent,
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
      runtimeDescriptorV1,
      agentRuntimeDescriptorV1: legacyAgentRuntimeDescriptorV1,
      mcpSelection,
    } = rawParams || {};

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
    const normalizedBackendTargetResolution = canonicalizeSpawnBackendTargetFromTransportInput({
      backendTarget,
      legacyAgent: agent,
    });
    if (normalizedBackendTargetResolution.errorMessage) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: normalizedBackendTargetResolution.errorMessage,
      };
    }
    const normalizedBackendTarget = normalizedBackendTargetResolution.backendTarget;
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
    const normalizedRuntimeSelection = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      codexBackendMode,
      experimentalCodexAcp,
      runtimeDescriptorV1,
      legacyAgentRuntimeDescriptorV1,
    });
    const normalizedRuntimeDescriptorV1 = normalizedRuntimeSelection.runtimeDescriptorV1;
    const normalizedCodexBackendMode = normalizedRuntimeSelection.codexBackendMode;
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
      ...(normalizedRuntimeDescriptorV1 ? { runtimeDescriptorV1: normalizedRuntimeDescriptorV1 } : {}),
      ...(normalizedCodexBackendMode ? { codexBackendMode: normalizedCodexBackendMode } : {}),
    });

    if (rawParams?.type === 'resume-session') {
      const { sessionId: existingSessionId } = rawParams;
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

      return { type: 'success' };
    }

    if (!directory) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
    }
    if (!normalizedBackendTarget) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Backend target is required for fresh session spawn.',
      };
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

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, async (raw: unknown) => {
    const parsed = parseSessionContinueWithReplayRpcParamsCompatIngress(raw);
    if (!parsed.success) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const resolvedBackend = sessionHostBridge.resolveContinueWithReplayBackendTarget({
      backendTarget: parsed.data.backendTarget,
    });
    if (!resolvedBackend.ok) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: resolvedBackend.errorMessage,
      };
    }

    return await continueSessionWithReplay(
      {
        directory: parsed.data.directory,
        backendTarget: resolvedBackend.backendTargetV2,
        approvedNewDirectoryCreation: parsed.data.approvedNewDirectoryCreation,
        permissionMode: parsed.data.permissionMode,
        permissionModeUpdatedAt: parsed.data.permissionModeUpdatedAt,
        modelId: parsed.data.modelId,
        modelUpdatedAt: parsed.data.modelUpdatedAt,
        replay: parsed.data.replay,
      },
      {
        spawnSession,
        ...(params.deps?.runReplaySummaryForDialog
          ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
          : {}),
      },
    );
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
      if (isAuthenticationError(error)) throw error;
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

    const forkBackendResolution = await sessionHostBridge.resolveSessionForkBackendTarget({
      parentMetadata,
      credentials,
    });
    if (!forkBackendResolution.ok) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: forkBackendResolution.errorMessage,
      };
    }

	    const forkIsConfiguredAcp = forkBackendResolution.configuredAcp !== null;
	    const forkProviderAgentId = forkBackendResolution.providerAgentId;
	    const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(parentMetadata);

    const targetSeqInclusive = forkPoint.type === 'seq'
      ? forkPoint.upToSeqInclusive
      : (typeof (parentSession as any)?.seq === 'number' && Number.isFinite((parentSession as any).seq)
        ? Math.max(0, Math.floor((parentSession as any).seq))
        : 0);

    const cutoffSeqInclusive = forkPoint.type === 'seq'
      ? (() => targetSeqInclusive)()
      : targetSeqInclusive;

    const resolvedCutoff = forkPoint.type === 'seq'
      ? await resolveForkCutoffSeqInclusive({
        credentials,
        parentSessionId,
        parentRawSession: parentSession,
        targetSeqInclusive,
      }).catch((error) => {
        if (isAuthenticationError(error)) throw error;
        return null;
      })
      : null;

    const effectiveCutoffSeqInclusive =
      forkPoint.type === 'seq' && resolvedCutoff
        ? resolvedCutoff.cutoffSeqInclusive
        : cutoffSeqInclusive;

    const spawnNonce = `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`;
    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const shouldAttemptProviderNative =
      requestedStrategy === 'auto' || requestedStrategy === 'provider_native';

    if (shouldAttemptProviderNative && !forkIsConfiguredAcp && forkProviderAgentId) {
      try {
        const nativeFork = await dispatchProviderNativeFork({
          credentials,
          agentId: forkProviderAgentId,
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
            backendTarget: forkBackendResolution.backendTargetV2,
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
                  ...forkBackendResolution.metadataOverlay,
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
              if (isAuthenticationError(error)) throw error;
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
        if (isAuthenticationError(error)) throw error;
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
      forkPoint.type === 'latest' &&
      (
        forkIsConfiguredAcp ||
        (forkProviderAgentId !== null && isAcpForkEligibleForProvider({
          providerId: forkProviderAgentId,
          metadata: parentMetadata,
        }))
      );

    if (shouldAttemptAcpForkLatest) {
      try {
        const vendorSessionIdRaw = forkIsConfiguredAcp
          ? (forkBackendResolution.configuredAcp?.vendorSessionId ?? '')
          : (forkProviderAgentId
            ? (resolveVendorResumeIdFromSessionMetadata(forkProviderAgentId as any, parentMetadata) ?? '')
            : '');

        if (vendorSessionIdRaw) {
          const permissionHandler = {
            handleToolCall: async () => ({ decision: 'denied' as const }),
          };
          let acpBackend: {
            loadSession?: (sessionId: string) => Promise<unknown>;
            forkSession?: (params: Readonly<{ sessionId: string; cwd?: string }>) => Promise<unknown>;
            dispose: () => Promise<unknown>;
          } | null = null;

          if (forkBackendResolution.configuredAcp?.resolvedBackend && forkBackendResolution.configuredAcp.accountSettings) {
            const { createConfiguredAcpBackend } = await import('@/agent/acp/catalog/configured/createConfiguredAcpBackend');
            const { materializeConfiguredAcpEnvironment } = await import('@/agent/acp/catalog/configured/materializeEnvironment');
            const launchEnv = materializeConfiguredAcpEnvironment({
              backend: forkBackendResolution.configuredAcp.resolvedBackend,
              accountSettings: forkBackendResolution.configuredAcp.accountSettings,
              credentials,
            });
            acpBackend = createConfiguredAcpBackend({
              cwd: directory,
              backend: forkBackendResolution.configuredAcp.resolvedBackend,
              launchEnv,
              mcpServers: {},
              permissionHandler,
            }) as unknown as NonNullable<typeof acpBackend>;
          } else if (!forkIsConfiguredAcp && forkProviderAgentId) {
            const { createCatalogAcpBackend } = await import('@/agent/acp/createCatalogAcpBackend');
            const created = await createCatalogAcpBackend(forkProviderAgentId as any, {
              cwd: directory,
              mcpServers: {},
              permissionHandler,
            } as any);
            acpBackend = created.backend;
          }

          try {
            if (acpBackend && typeof acpBackend.loadSession === 'function' && typeof acpBackend.forkSession === 'function') {
              await acpBackend.loadSession(vendorSessionIdRaw);
              const forked = await acpBackend.forkSession({
                sessionId: vendorSessionIdRaw,
              });
              const forkedRecord = (forked && typeof forked === 'object') ? forked as { sessionId?: unknown } : null;
              const forkedSessionId = typeof forkedRecord?.sessionId === 'string'
                ? String(forkedRecord.sessionId).trim()
                : '';
              if (forkedSessionId) {
                let continuationShape: AcpForkContinuationResult | null = null;
                if (forkProviderAgentId) {
                  const acpForkContinuation = await getAcpForkContinuationHandler(forkProviderAgentId);
                  if (acpForkContinuation) {
                    continuationShape = await acpForkContinuation({
                      agentId: forkProviderAgentId,
                      parentMetadata,
                      vendorSessionId: forkedSessionId,
                    });
                  }
                }

                const result = await spawnSession({
                  directory,
                  backendTarget: forkBackendResolution.backendTargetV2,
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
                        ...forkBackendResolution.metadataOverlay,
                        ...(continuationShape?.metadata ?? {}),
                        forkV1: {
                          v: 1,
                          parentSessionId,
                          parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          providerHint: continuationShape?.providerHint ?? {
                            providerId: forkBackendResolution.providerHintProviderId,
                            vendorSessionId: forkedSessionId,
                          },
                        },
                      }),
                      maxAttempts: 6,
                    });
                  } catch (error) {
                    if (isAuthenticationError(error)) throw error;
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
            if (acpBackend) {
              await acpBackend.dispose().catch(() => {});
            }
          }
        }
      } catch (error) {
        if (isAuthenticationError(error)) throw error;
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
	    const replayForkContinuation = forkBackendResolution.providerAgentId
	      ? await (async () => {
	        const handler = await getReplayForkContinuationHandler(forkBackendResolution.providerAgentId);
	        return handler ? await handler({ parentMetadata }) : null;
	      })()
	      : null;
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
      maxSeedChars: typeof parsed.data.replayMaxSeedChars === 'number'
        ? parsed.data.replayMaxSeedChars
        : configuration.replaySeedMaxChars,
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
          flavor: forkBackendResolution.replayFlavor,
          tag: `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`,
	          metadata: {
	            ...inheritedForkOverrides.metadata,
	            ...forkBackendResolution.metadataOverlay,
	            ...(replayForkContinuation?.metadata ?? {}),
	            forkV1: {
	              v: 1,
	              parentSessionId,
	              parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: forkBackendResolution.providerHintProviderId },
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
        if (isAuthenticationError(error)) throw error;
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
	      backendTarget: forkBackendResolution.backendTargetV2,
	      approvedNewDirectoryCreation: true,
	      spawnNonce,
	      existingSessionId: created.sessionId,
	      ...(replayForkContinuation?.spawn ?? {}),
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
}
