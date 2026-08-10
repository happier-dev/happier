import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { deriveSessionSubagentSidechainIds } from '@/sync/domains/session/subagents/sidechains/deriveSessionSubagentSidechainIds';
import type {
    SessionSubagent,
    SessionSubagentActiveExecutionRunState,
} from '@/sync/domains/session/subagents/types';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDirectSessionRuntime, type UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { reconcileStableRows } from './reconcileStableRows';
import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';

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

type SessionSubagentMessageSignatureEntry = Readonly<{
    index: number;
    signature: string;
}>;

type SessionSubagentMessagesSignatureState = Readonly<{
    messages: readonly Message[];
    entries: readonly SessionSubagentMessageSignatureEntry[];
    signature: string;
}>;

function findSharedMessagePrefixLength(left: readonly Message[], right: readonly Message[]): number {
    const max = Math.min(left.length, right.length);
    let index = 0;
    while (index < max && left[index] === right[index]) index += 1;
    return index;
}

function areSignatureEntriesEqual(
    left: readonly SessionSubagentMessageSignatureEntry[],
    right: readonly SessionSubagentMessageSignatureEntry[],
): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index]?.index !== right[index]?.index) return false;
        if (left[index]?.signature !== right[index]?.signature) return false;
    }
    return true;
}

function buildSessionSubagentMessagesSignatureState(
    messages: readonly Message[],
    previous: SessionSubagentMessagesSignatureState | null,
): SessionSubagentMessagesSignatureState {
    if (previous?.messages === messages) return previous;

    const sharedPrefixLength = previous
        ? findSharedMessagePrefixLength(previous.messages, messages)
        : 0;
    const entries: SessionSubagentMessageSignatureEntry[] = previous
        ? previous.entries.filter((entry) => entry.index < sharedPrefixLength)
        : [];

    for (let index = sharedPrefixLength; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || message.kind !== 'tool-call') continue;
        entries.push({
            index,
            signature: buildSessionSubagentToolMessageSignature(message),
        });
    }

    const signature = previous && areSignatureEntriesEqual(entries, previous.entries)
        ? previous.signature
        : entries.map((entry) => entry.signature).join('|');

    return { messages, entries, signature };
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

function buildExecutionRunStateSignature(runs: readonly SessionSubagentActiveExecutionRunState[]): string {
    if (runs.length === 0) return '';
    return runs.map((run) => `${run.runId}\u0000${run.status ?? ''}`).join('\u0001');
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

/**
 * Derived rosters are rebuilt in full on every transcript tick. Reconciling them by key keeps the
 * object identity of rows that did not change, which is what makes a memoized row real — and costs
 * a short-circuiting structural compare instead of serialising the whole array.
 */
function useReconciledStableRows<Row>(
    rows: readonly Row[],
    readKey: (row: Row) => string,
): readonly Row[] {
    const ref = React.useRef<readonly Row[]>(rows);
    ref.current = reconcileStableRows(ref.current, rows, readKey);
    return ref.current;
}

function readSubagentKey(subagent: SessionSubagent): string {
    return subagent.id;
}

function readParticipantTargetKey(target: SessionParticipantTarget): string {
    return target.key;
}

export function useSessionSubagents(params: Readonly<{
    sessionId: string;
    session: Session | null;
    messages: readonly Message[];
    directSessionRuntime?: UseDirectSessionRuntimeResult;
}>): Readonly<{
    subagents: readonly SessionSubagent[];
    participantTargets: ReturnType<typeof deriveSessionSubagentRecipients>;
    sidechainIds: readonly string[];
}> {
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const sessionFlavor = typeof (params.session as any)?.metadata?.flavor === 'string'
        ? String((params.session as any).metadata.flavor)
        : null;
    const subagentMessagesSignatureStateRef = React.useRef<SessionSubagentMessagesSignatureState | null>(null);
    const subagentMessagesSignature = React.useMemo(() => {
        const signatureState = buildSessionSubagentMessagesSignatureState(
            params.messages,
            subagentMessagesSignatureStateRef.current,
        );
        subagentMessagesSignatureStateRef.current = signatureState;
        return signatureState.signature;
    }, [params.messages]);
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
        sessionId: params.sessionId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const runningExecutionRunsSignature = React.useMemo(
        () => buildExecutionRunStateSignature(runningExecutionRuns),
        [runningExecutionRuns],
    );
    const stableRunningExecutionRuns = useStableValueBySignature(runningExecutionRuns, runningExecutionRunsSignature);
    const internalDirectSessionRuntime = useDirectSessionRuntime({
        sessionId: params.sessionId,
        metadata: params.session?.metadata,
        enabled: params.directSessionRuntime == null,
    });
    const directSessionRuntime = params.directSessionRuntime ?? internalDirectSessionRuntime;

    const derivedSubagents = React.useMemo(() => {
        if (!params.session) return [] as const;
        const derivedSubagents = deriveSessionSubagents({
            session: {
                metadata: sessionFlavor ? { flavor: sessionFlavor } : {},
            },
            messages: subagentMessages,
            activeExecutionRuns: stableRunningExecutionRuns,
        });
        return applyExecutionRunControlCapabilities(derivedSubagents, {
            canControlExecutionRuns:
                directSessionRuntime.directSessionLink === null
                || directSessionRuntime.status?.runnerActive === true,
        });
    }, [
        directSessionRuntime.directSessionLink,
        directSessionRuntime.status?.runnerActive,
        params.session != null,
        stableRunningExecutionRuns,
        subagentMessages,
        sessionFlavor,
    ]);
    const subagents = useReconciledStableRows(derivedSubagents, readSubagentKey);

    const derivedParticipantTargets = React.useMemo(() => {
        return deriveSessionSubagentRecipients(subagents);
    }, [subagents]);
    const participantTargets = useReconciledStableRows(derivedParticipantTargets, readParticipantTargetKey);

    const derivedSidechainIds = React.useMemo(() => {
        return deriveSessionSubagentSidechainIds(subagents);
    }, [subagents]);
    const sidechainIdsSignature = derivedSidechainIds.join('\0');
    const sidechainIds = useStableValueBySignature(derivedSidechainIds, sidechainIdsSignature);

    return { subagents, participantTargets, sidechainIds };
}
