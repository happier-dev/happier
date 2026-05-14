import { randomUUID } from 'node:crypto';

import { configuration } from '@/configuration';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { readCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';

import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { commitSessionStoredMessage } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import { createSessionTranscriptFollowLeaseRegistry } from '@/api/session/transcriptQueries';
import { SessionMessageContentSchema } from '@/api/types';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Metadata } from '@/api/types';
import type { ACPMessageData, ACPProvider } from '../../sessionMessageTypes';
import { deriveVoiceAgentTurnLocalId, readRuntimeDescriptorV1FromMetadata, readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';

export function resolveSessionClientParentProvider(metadata: unknown): CatalogAgentId {
    const runtimeDescriptorProviderId = typeof readRuntimeDescriptorV1FromMetadata(metadata)?.providerId === 'string'
        ? String(readRuntimeDescriptorV1FromMetadata(metadata)?.providerId).trim()
        : '';
    if ((CATALOG_AGENT_IDS as readonly string[]).includes(runtimeDescriptorProviderId)) {
        return runtimeDescriptorProviderId as CatalogAgentId;
    }

    const resolvedFlavor = typeof (metadata as { flavor?: unknown })?.flavor === 'string'
        ? String((metadata as { flavor?: string }).flavor).trim()
        : '';
    if ((CATALOG_AGENT_IDS as readonly string[]).includes(resolvedFlavor)) {
        return resolvedFlavor as CatalogAgentId;
    }

    throw new Error('Missing canonical session parent provider identity');
}

function createExecutionBudgetRegistry(): ExecutionBudgetRegistry | undefined {
    const hasBudgetCaps =
        configuration.executionRunsMaxConcurrentPerSession !== null
        || configuration.oneShotTasksMaxConcurrentPerSession !== null
        || typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
        || (configuration.executionBudgetMaxConcurrentByClass && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0);
    if (!hasBudgetCaps) {
        return undefined;
    }

    return new ExecutionBudgetRegistry({
        maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
        maxConcurrentOneShotTasks: configuration.oneShotTasksMaxConcurrentPerSession,
        ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
            : {}),
        ...(configuration.executionBudgetMaxConcurrentByClass
            && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
            ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
            : {}),
    });
}

export function registerSessionClientRuntimeHandlers(
    params: Readonly<{
        rpcHandlerManager: RpcHandlerManager;
        token: string;
        metadataPath: string;
        metadata: unknown;
        sessionId: string;
        getSessionMetadata: () => Metadata | null;
        enqueueSessionUserMessage: (request: Readonly<{
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
        }>) => void;
        sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
        sendAgentMessage: (provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
        sendUserTextMessageCommitted: (text: string, opts: { localId: string; meta?: Record<string, unknown> }) => Promise<void>;
        sendAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }) => Promise<void>;
        sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }) => void;
        getTranscriptQueryContext: () => Readonly<{
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        }>;
        getAgentStateRequestStore?: ExecutionRunPermissionRequestStoreProvider;
        persistVoiceAgentRunMetadataFromPublicRun: (run: unknown, welcomedEpoch?: number) => void;
        socketEmitExecutionRunUpdated: (run: unknown) => void;
    }>,
): void {
    const parentProvider = resolveSessionClientParentProvider(params.metadata);
    const workingDirectory = params.metadataPath ?? process.cwd();
    const executionBudgetRegistry = createExecutionBudgetRegistry();
    const transcriptQueryContext = params.getTranscriptQueryContext();
    const transcriptActionExecutor = createCliActionExecutor({
        token: params.token,
        sessionId: params.sessionId,
        ctx: transcriptQueryContext,
        transcriptSessionId: params.sessionId,
        transcriptStore: createServerBackedSessionTranscriptStore({
            token: params.token,
            sessionId: params.sessionId,
            ctx: transcriptQueryContext,
        }),
        // A.13 watcher bound floor: idle TTL must be ≥ 600_000 ms (10 min) per packet body §2.
        transcriptFollowLeaseRegistry: createSessionTranscriptFollowLeaseRegistry({ maxLeases: 16, idleTtlMs: 600_000 }),
        writeTranscriptItems: async (_sessionId: string, items: readonly SessionTranscriptActionItem[]) => {
            let imported = 0;
            let cursor: string | null = null;
            for (const item of items) {
                const parsedContent = SessionMessageContentSchema.safeParse(item.content);
                if (!parsedContent.success) continue;
                const committed = await commitSessionStoredMessage({
                    token: params.token,
                    sessionId: params.sessionId,
                    localId: item.id,
                    content: parsedContent.data,
                });
                imported += 1;
                cursor = String(committed.seq);
            }
            return { imported, cursor };
        },
        sessionLogAccess: {
            workingDirectory,
            accessPolicy: { kind: 'osUser' },
        },
    });

    registerSessionHandlers(params.rpcHandlerManager, workingDirectory, {
        getSessionMetadata: () => params.getSessionMetadata(),
        enqueueSessionUserMessage: (request: Readonly<{
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
        }>) => params.enqueueSessionUserMessage(request),
        transcriptActionExecutor,
    });

    const transcriptWriter = {
        appendUserText: (text: string, meta: Record<string, unknown>) => {
            params.sendUserTextMessage(text, { meta });
        },
        appendAssistantText: (text: string, meta: Record<string, unknown>) => {
            params.sendAgentMessage(parentProvider as ACPProvider, { type: 'message', message: text }, { meta });
        },
        appendUserTextCommitted: async (text: string, meta: Record<string, unknown>) => {
            const voiceTurn = readVoiceAgentTurnPayloadFromMeta(meta);
            await params.sendUserTextMessageCommitted(text, {
                localId: voiceTurn ? deriveVoiceAgentTurnLocalId(voiceTurn) : randomUUID(),
                meta,
            });
        },
        appendAssistantTextCommitted: async (text: string, meta: Record<string, unknown>) => {
            const voiceTurn = readVoiceAgentTurnPayloadFromMeta(meta);
            await params.sendAgentMessageCommitted(
                parentProvider as ACPProvider,
                { type: 'message', message: text },
                {
                    localId: voiceTurn ? deriveVoiceAgentTurnLocalId(voiceTurn) : randomUUID(),
                    meta,
                },
            );
        },
    };

    registerExecutionRunHandlers(params.rpcHandlerManager, {
        sessionId: params.sessionId,
        cwd: workingDirectory,
        serverUrl: configuration.serverUrl,
        parentProvider,
        sendAcp: (provider, body, opts) => params.sendAgentMessage(provider as ACPProvider, body as ACPMessageData, opts),
        streamedTranscriptSession: {
            sendAgentMessageEphemeral: (provider, body, opts) =>
                params.sendAgentMessageEphemeral(provider as ACPProvider, body as ACPMessageData, opts),
            sendAgentMessageCommitted: (provider, body, opts) =>
                params.sendAgentMessageCommitted(provider as ACPProvider, body as ACPMessageData, opts),
        },
        transcriptWriter,
        budgetRegistry: executionBudgetRegistry,
        getPermissionRequestStore: params.getAgentStateRequestStore,
        onExecutionRunPublicStateUpdated: (run) => {
            try {
                params.persistVoiceAgentRunMetadataFromPublicRun(run);
                params.socketEmitExecutionRunUpdated(run);
            } catch {
                // best effort
            }
        },
        onExecutionRunVoiceAgentWelcomed: (run, welcomedEpoch) => {
            params.persistVoiceAgentRunMetadataFromPublicRun(run, welcomedEpoch);
        },
        policy: {
            maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
            boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
            reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
            maxTurns: configuration.executionRunsMaxTurns,
            maxDepth: configuration.executionRunsMaxDepth,
        },
        resolveAccountSettings: async () => {
            const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
            if (activeSettings) return activeSettings;
            const credentials = await readCredentials();
            if (!credentials) return null;
            const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
            return context.settings ?? null;
        },
        actionApprovalDeps: createExecutionRunRpcApprovalDeps({ readCredentials }),
    });
}
