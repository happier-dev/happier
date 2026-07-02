import type { AgentState, Metadata } from '@/api/types';
import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { writeSessionStateFieldWithMetadataPort } from '@/agent/runtime/state/writeSessionStateFieldWithMetadataPort';
import {
    hostSubagentStore,
    type HostSubagentActor,
    type HostSubagentStore,
} from '@/session/subagents/hostSubagentStore';
import type {
    TerminalRuntimeControlProjectionV1,
    TerminalRuntimeProjectionHostServiceV1,
    TerminalRuntimeProviderSessionProjectionV1,
    TerminalRuntimeSubagentProjectionV1,
    TerminalRuntimeTranscriptBindingHostServiceV1,
} from '@happier-dev/agents';
import type { SubagentStatusV1 } from '@happier-dev/protocol';

type TerminalProjectionSession = Readonly<{
    sessionId: string;
    sendSessionEvent?: (event: SessionEventMessage) => void;
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
}>;

type CreateTerminalRuntimeProjectionHostServiceParams = Readonly<{
    session: TerminalProjectionSession;
    transcripts: TerminalRuntimeTranscriptBindingHostServiceV1;
    subagents?: HostSubagentStore;
    subagentActor?: HostSubagentActor;
    logPrefix?: string;
}>;

function normalizeText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeCompletionStatus(
    status: SubagentStatusV1 | undefined,
): Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'> {
    if (status === 'failed' || status === 'aborted') {
        return status;
    }
    return 'completed';
}

function publishSwitchEvent(
    session: TerminalProjectionSession,
    projection: TerminalRuntimeControlProjectionV1,
): void {
    if (projection.target !== 'local' && projection.target !== 'remote') {
        return;
    }
    session.sendSessionEvent?.({ type: 'switch', mode: projection.target });
}

function publishAgentControlState(
    session: TerminalProjectionSession,
    projection: TerminalRuntimeControlProjectionV1,
    logPrefix: string,
): void {
    if (projection.target !== 'local' && projection.target !== 'remote') {
        return;
    }
    updateAgentStateBestEffort(
        session,
        (current) => ({
            ...current,
            controlledByUser: projection.target === 'local',
        }),
        logPrefix,
        projection.reason ?? 'terminal_runtime_control_projection',
    );
}

async function publishProviderSessionId(
    session: TerminalProjectionSession,
    projection: TerminalRuntimeProviderSessionProjectionV1,
): Promise<boolean> {
    const providerSessionId = normalizeText(projection.providerSessionId);
    const metadataKey = normalizeText(projection.metadataKey);
    if (!providerSessionId || !metadataKey) {
        return false;
    }
    return await writeSessionStateFieldWithMetadataPort({
        sessionId: session.sessionId,
        fieldId: 'identity.providerSessionId',
        value: {
            metadataKey,
            value: providerSessionId,
        },
        updateMetadata: (updater) => session.updateMetadata(updater),
        reason: 'reconciliation',
        metadataReason: 'terminal_runtime_provider_session_projection',
    });
}

async function publishSubagentStarted(
    params: Readonly<{
        parentSessionId: string;
        subagents: HostSubagentStore;
        actor: HostSubagentActor;
        projection: TerminalRuntimeSubagentProjectionV1;
    }>,
): Promise<void> {
    const subagentId = normalizeText(params.projection.subagentId);
    if (!subagentId) {
        return;
    }
    const label = normalizeText(params.projection.label)
        ?? normalizeText(params.projection.role)
        ?? subagentId;
    const providerId = normalizeText(params.projection.providerId);
    const providerKind = normalizeText(params.projection.providerKind);
    const sidechainId = normalizeText(params.projection.sidechainId) ?? subagentId;

    await params.subagents.upsert({
        actor: params.actor,
        input: {
            id: subagentId,
            parentSessionId: params.parentSessionId,
            origin: 'provider',
            kind: 'native',
            status: params.projection.status ?? 'running',
            ...(providerId
                ? {
                    providerRef: {
                        providerId,
                        ...(providerKind ? { providerKind } : {}),
                    },
                }
                : {}),
            transcript: {
                parentSessionId: params.parentSessionId,
                sidechainId,
            },
            label,
            display: { label },
            ...(params.projection.metadata ? { providerMetadata: params.projection.metadata } : {}),
        },
    });
}

export function createTerminalRuntimeProjectionHostService(
    params: CreateTerminalRuntimeProjectionHostServiceParams,
): TerminalRuntimeProjectionHostServiceV1 {
    const subagents = params.subagents ?? hostSubagentStore;
    const actor = params.subagentActor ?? Object.freeze({ kind: 'host' as const });
    const logPrefix = params.logPrefix ?? '[terminal-runtime]';

    return Object.freeze({
        openDirectTranscriptMirror: params.transcripts.openDirectMirror,
        publishControlState: (projection) => {
            publishSwitchEvent(params.session, projection);
            publishAgentControlState(params.session, projection, logPrefix);
        },
        publishProviderSessionId: async (projection) => await publishProviderSessionId(params.session, projection),
        publishSubagentStarted: async (projection) => {
            await publishSubagentStarted({
                parentSessionId: params.session.sessionId,
                subagents,
                actor,
                projection,
            });
        },
        publishSubagentCompleted: async (projection) => {
            const subagentId = normalizeText(projection.subagentId);
            if (!subagentId) {
                return;
            }
            const existing = await subagents.get({
                parentSessionId: params.session.sessionId,
                id: subagentId,
            });
            if (!existing) {
                await publishSubagentStarted({
                    parentSessionId: params.session.sessionId,
                    subagents,
                    actor,
                    projection: {
                        ...projection,
                        status: 'running',
                    },
                });
            }
            await subagents.complete({
                actor,
                id: subagentId,
                parentSessionId: params.session.sessionId,
                status: normalizeCompletionStatus(projection.status),
                ...(projection.lifecycleDetail ? { lifecycleDetail: projection.lifecycleDetail } : {}),
            });
        },
    });
}
