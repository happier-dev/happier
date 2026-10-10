import { readToolCallObservedAtMs } from '@/sync/domains/session/subagents/toolCallActivityTimestamps';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import * as React from 'react';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import type { Message } from "@happier-dev/session-core/messages";
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { deriveSessionSubagentSidechainIds } from '@/sync/domains/session/subagents/sidechains/deriveSessionSubagentSidechainIds';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionRuntimeLostSinceMs } from '@/sync/domains/session/attention/runtimePresentation';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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
        childObservedAt: message.kind === 'tool-call' ? readToolCallObservedAtMs(message) : null,
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
    /** Exact Home selected by the route/pane when the Session id is ambiguous. */
    serverId?: string | null;
    session: Session | null;
    messages: readonly Message[];
    externalSessionRuntime?: UseExternalSessionRuntimeResult;
}>): Readonly<{
    subagents: readonly SessionSubagent[];
    runtimeLostSinceMs: number | null;
    participantTargets: ReturnType<typeof deriveSessionSubagentRecipients>;
    sidechainIds: readonly string[];
}> {
    const sessionServerId = params.serverId ?? params.session?.serverId ?? null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs', sessionServerId
        ? { scopeKind: 'spawn', serverId: sessionServerId }
        : undefined);
    const accountScopeResolution = useServerCredentialAccountScopeResolution(sessionServerId);
    const accountScope = sessionServerId === null ? undefined
        : accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null;
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const sessionMetadata = params.session
        ? readSessionOwnerMetadataView(params.session)
        : null;
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
        serverId: sessionServerId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const internalExternalSessionRuntime = useSessionExternalSessionRuntime({
        sessionId: normalizedSessionId,
        serverId: sessionServerId,
        metadata: stableSessionMetadata,
        // A Home-qualified activity caller deliberately gives us `null` when
        // the legacy id-keyed live cache belongs to another Home.  It must not
        // turn that cache miss into a raw-id external-runtime request.
        enabled: params.externalSessionRuntime == null && params.session !== null,
    });
    const externalSessionRuntime = params.externalSessionRuntime ?? internalExternalSessionRuntime;

    // The roster's only use of session liveness is "has the runtime that owns these rows gone, and
    // since when" — so that instant, not the raw fields, is what the derivation depends on. Keying
    // the memo on it keeps the roster off the heartbeat: `activeAt` advances continuously while the
    // session is attached and this stays `null` the whole time, then changes exactly once when the
    // runtime is judged gone.
    const runtimeNowMs = useSessionListRuntimeNowMs();
    const sessionRuntimeLostSinceMs = params.session
        ? readSessionRuntimeLostSinceMs(params.session, Math.max(runtimeNowMs, Date.now()))
        : null;
    const expirations = params.session ? readSessionRuntimePresentationFreshnessExpirations(params.session, Math.max(runtimeNowMs, Date.now())) : [];
    useSessionListRuntimeWake(expirations.length > 0 ? Math.min(...expirations) : null);

    const derivedSubagents = React.useMemo(() => {
        if (!params.session) return [] as const;
        const derivedSubagents = deriveSessionSubagents({
            accountScope,
            session: {
                metadataLayoutVersion: 0,
                metadata: stableSessionMetadata,
                active: params.session.active,
                activeAt: params.session.activeAt,
                archivedAt: params.session.archivedAt ?? null,
                presence: params.session.presence,
            },
            messages: subagentMessages,
            runtimeLostSinceMs: sessionRuntimeLostSinceMs,
            activeExecutionRuns: runningExecutionRuns,
        });
        return applyExecutionRunControlCapabilities(derivedSubagents, {
            canControlExecutionRuns:
                externalSessionRuntime.externalSessionLink === null
                || externalSessionRuntime.status?.runnerActive === true,
        });
    }, [
        accountScope,
        externalSessionRuntime.externalSessionLink,
        externalSessionRuntime.status?.runnerActive,
        params.session != null,
        runningExecutionRuns,
        sessionRuntimeLostSinceMs,
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

    return { subagents, runtimeLostSinceMs: sessionRuntimeLostSinceMs, participantTargets, sidechainIds };
}
