import { isAuthenticationError } from '@/api/client/httpStatusError';
import { getAcpForkContinuationHandler } from '@/backends/catalog';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import type { AcpForkContinuationResult } from '@/session/fork/acpForkContinuationHandler';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
    fetchForkChildSessionOrThrow,
} from './forkChildSessionRecovery';
import type {
    ForkBackendResolution,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkSpawnSession,
    ForkStopSession,
    ForkStrategyAttemptResult,
} from './forkLifecycleTypes';

export async function attemptAcpLatestFork(params: Readonly<{
    requestedStrategy: string;
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
    parentMetadata: ForkLifecycleMetadata;
    directory: string;
    effectiveCutoffSeqInclusive: number;
    forkIsConfiguredAcp: boolean;
    forkProviderAgentId: ForkBackendResolution['providerAgentId'];
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    spawnSession: ForkSpawnSession;
    stopSession: ForkStopSession;
}>): Promise<ForkStrategyAttemptResult> {
    try {
        const forkProviderAgentId = params.forkProviderAgentId;
        const vendorSessionIdRaw = params.forkIsConfiguredAcp
            ? (params.forkBackendResolution.configuredAcp?.vendorSessionId ?? '')
            : (forkProviderAgentId
                ? (resolveVendorResumeIdFromSessionMetadata(forkProviderAgentId, params.parentMetadata) ?? '')
                : '');

        if (!vendorSessionIdRaw) return null;

        const permissionHandler = {
            handleToolCall: async () => ({ decision: 'denied' as const }),
        };
        let acpBackend: {
            loadSession?: (sessionId: string) => Promise<unknown>;
            forkSession?: (params: Readonly<{ sessionId: string; cwd?: string }>) => Promise<unknown>;
            dispose: () => Promise<unknown>;
        } | null = null;

        if (params.forkBackendResolution.configuredAcp?.resolvedBackend && params.forkBackendResolution.configuredAcp.accountSettings) {
            const { createConfiguredAcpBackend } = await import('@/agent/acp/catalog/configured/createConfiguredAcpBackend');
            const { materializeConfiguredAcpEnvironment } = await import('@/agent/acp/catalog/configured/materializeEnvironment');
            const launchEnv = materializeConfiguredAcpEnvironment({
                backend: params.forkBackendResolution.configuredAcp.resolvedBackend,
                accountSettings: params.forkBackendResolution.configuredAcp.accountSettings,
                credentials: params.credentials,
            });
            acpBackend = createConfiguredAcpBackend({
                cwd: params.directory,
                backend: params.forkBackendResolution.configuredAcp.resolvedBackend,
                launchEnv,
                mcpServers: {},
                permissionHandler,
            }) as unknown as NonNullable<typeof acpBackend>;
        } else if (!params.forkIsConfiguredAcp && forkProviderAgentId) {
            const { createCatalogAcpBackend } = await import('@/agent/acp/createCatalogAcpBackend');
            const created = await createCatalogAcpBackend(forkProviderAgentId, {
                cwd: params.directory,
                mcpServers: {},
                permissionHandler,
            });
            acpBackend = created.backend;
        }

        try {
            if (!acpBackend || typeof acpBackend.loadSession !== 'function' || typeof acpBackend.forkSession !== 'function') {
                return null;
            }

            await acpBackend.loadSession(vendorSessionIdRaw);
            const forked = await acpBackend.forkSession({
                sessionId: vendorSessionIdRaw,
            });
            const forkedRecord = (forked && typeof forked === 'object') ? forked as { sessionId?: unknown } : null;
            const forkedSessionId = typeof forkedRecord?.sessionId === 'string'
                ? String(forkedRecord.sessionId).trim()
                : '';
            if (!forkedSessionId) return null;

            let continuationShape: AcpForkContinuationResult | null = null;
            if (forkProviderAgentId) {
                const acpForkContinuation = await getAcpForkContinuationHandler(forkProviderAgentId);
                if (acpForkContinuation) {
                    continuationShape = await acpForkContinuation({
                        agentId: forkProviderAgentId,
                        parentMetadata: params.parentMetadata,
                        vendorSessionId: forkedSessionId,
                    });
                }
            }

            const result = await params.spawnSession({
                directory: params.directory,
                backendTarget: params.forkBackendResolution.backendTargetV2,
                approvedNewDirectoryCreation: true,
                resume: forkedSessionId,
                ...(continuationShape?.spawn ?? {}),
                ...params.inheritedForkOverrides.spawn,
            } satisfies SpawnSessionOptions);

            if (params.requestedStrategy === 'acp_fork_latest' && result.type !== 'success') {
                return {
                    ok: false,
                    errorCode: (result as { errorCode?: string })?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: (result as { errorMessage?: string })?.errorMessage ?? 'Failed to spawn ACP fork session',
                };
            }

            if (result.type !== 'success' || !result.sessionId) return null;

            const childSessionId = result.sessionId;
            if (childSessionId === params.parentSessionId) {
                return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
            }
            try {
                const childRaw = await fetchForkChildSessionOrThrow({ token: params.credentials.token, sessionId: childSessionId });
                await updateSessionMetadataWithRetry({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId: childSessionId,
                    rawSession: childRaw,
                    updater: (metadata) => ({
                        ...metadata,
                        ...params.inheritedForkOverrides.metadata,
                        ...params.forkBackendResolution.metadataOverlay,
                        ...(continuationShape?.metadata ?? {}),
                        forkV1: {
                            v: 1,
                            parentSessionId: params.parentSessionId,
                            parentCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                            createdAtMs: Date.now(),
                            strategy: 'acp_fork_latest',
                            providerHint: continuationShape?.providerHint ?? {
                                providerId: params.forkBackendResolution.providerHintProviderId,
                                vendorSessionId: forkedSessionId,
                            },
                        },
                    }),
                    maxAttempts: 6,
                });
            } catch (error) {
                if (isAuthenticationError(error)) throw error;
                await cleanupForkChildBestEffort(params.stopSession, childSessionId);
                await archiveSessionBestEffort(params.credentials.token, childSessionId);
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
                };
            }
            return { ok: true, childSessionId };
        } finally {
            if (acpBackend) {
                await acpBackend.dispose().catch(() => {});
            }
        }
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return null;
    }
}
