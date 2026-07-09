import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { deriveSessionSubagentSidechainIds } from '@/sync/domains/session/subagents/sidechains/deriveSessionSubagentSidechainIds';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';

function normalizeSessionId(sessionId: string): string {
    return String(sessionId ?? '').trim();
}

const sessionSubagentToolMessageSignatureCache = new WeakMap<Message, string>();

function buildSessionSubagentToolMessageSignature(message: Message): string {
    const cached = sessionSubagentToolMessageSignatureCache.get(message);
    if (cached) return cached;

    const tool = message.kind === 'tool-call' ? message.tool : null;
    const signature = JSON.stringify({
        id: message.id,
        createdAt: message.createdAt ?? null,
        toolId: tool?.id ?? null,
        toolName: tool?.name ?? null,
        toolState: tool?.state ?? null,
        toolCreatedAt: tool?.createdAt ?? null,
        toolStartedAt: tool?.startedAt ?? null,
        toolCompletedAt: tool?.completedAt ?? null,
        input: tool?.input ?? null,
        result: tool?.result ?? null,
    }) ?? 'null';
    sessionSubagentToolMessageSignatureCache.set(message, signature);
    return signature;
}

function buildSessionSubagentMessagesSignature(messages: readonly Message[]): string {
    const parts: string[] = [];
    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        parts.push(buildSessionSubagentToolMessageSignature(message));
    }
    return parts.join('|');
}

function useStableMessagesBySignature(
    messages: readonly Message[],
    signature: string,
): readonly Message[] {
    const ref = React.useRef<{ signature: string; messages: readonly Message[] }>({
        signature,
        messages,
    });
    if (ref.current.signature !== signature) {
        ref.current = { signature, messages };
    }
    return ref.current.messages;
}

function buildStableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(value ?? null) ?? 'null';
    } catch {
        return String(value);
    }
}

function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({
        signature,
        value,
    });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}

export function useSessionSubagents(params: Readonly<{
    sessionId: string;
    session: Session | null;
    messages: readonly Message[];
    externalSessionRuntime?: UseExternalSessionRuntimeResult;
}>): Readonly<{
    subagents: readonly SessionSubagent[];
    participantTargets: ReturnType<typeof deriveSessionSubagentRecipients>;
    sidechainIds: readonly string[];
}> {
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const sessionMetadata = params.session?.metadata ?? null;
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(sessionMetadata),
        [sessionMetadata],
    );
    const stableSessionMetadata = useStableValueBySignature(sessionMetadata, sessionMetadataSignature);
    const subagentMessagesSignature = React.useMemo(
        () => buildSessionSubagentMessagesSignature(params.messages),
        [params.messages],
    );
    const subagentMessages = useStableMessagesBySignature(params.messages, subagentMessagesSignature);

    const executionRunPollingEnabled = React.useMemo(() => {
        return shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: executionRunsEnabled,
            messages: subagentMessages,
        });
    }, [executionRunsEnabled, subagentMessages]);

    const executionRunPollingRefreshKey = React.useMemo(() => {
        return deriveExecutionRunPollingRefreshKey(subagentMessages);
    }, [subagentMessages]);

    const runningExecutionRuns = useSessionRunningExecutionRuns({
        sessionId: normalizedSessionId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const internalExternalSessionRuntime = useSessionExternalSessionRuntime({
        sessionId: normalizedSessionId,
        metadata: params.session?.metadata,
        enabled: params.externalSessionRuntime == null,
    });
    const externalSessionRuntime = params.externalSessionRuntime ?? internalExternalSessionRuntime;

    const derivedSubagents = React.useMemo(() => {
        if (!params.session) return [] as const;
        const derivedSubagents = deriveSessionSubagents({
            session: {
                metadata: stableSessionMetadata,
            },
            messages: subagentMessages,
            activeExecutionRuns: runningExecutionRuns,
        });
        return applyExecutionRunControlCapabilities(derivedSubagents, {
            canControlExecutionRuns:
                externalSessionRuntime.externalSessionLink === null
                || externalSessionRuntime.status?.runnerActive === true,
        });
    }, [
        externalSessionRuntime.externalSessionLink,
        externalSessionRuntime.status?.runnerActive,
        params.session != null,
        runningExecutionRuns,
        stableSessionMetadata,
        subagentMessages,
    ]);
    const subagentsSignature = React.useMemo(
        () => buildStableJsonSignature(derivedSubagents),
        [derivedSubagents],
    );
    const subagents = useStableValueBySignature(derivedSubagents, subagentsSignature);

    const derivedParticipantTargets = React.useMemo(() => {
        return deriveSessionSubagentRecipients(subagents);
    }, [subagents]);
    const participantTargetsSignature = React.useMemo(
        () => buildStableJsonSignature(derivedParticipantTargets),
        [derivedParticipantTargets],
    );
    const participantTargets = useStableValueBySignature(derivedParticipantTargets, participantTargetsSignature);

    const derivedSidechainIds = React.useMemo(() => {
        return deriveSessionSubagentSidechainIds(subagents);
    }, [subagents]);
    const sidechainIdsSignature = derivedSidechainIds.join('\0');
    const sidechainIds = useStableValueBySignature(derivedSidechainIds, sidechainIdsSignature);

    return { subagents, participantTargets, sidechainIds };
}
