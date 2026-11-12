import { shallow } from 'zustand/shallow';

import type { Message, ToolCall } from '../domains/messages/messageTypes';
import { readTranscriptExecutionRunToolFields } from '../domains/session/subagents/executionRuns/deriveTranscriptExecutionRunStateIndex';
import { readExecutionRunResultStatus } from '../domains/session/subagents/executionRuns/executionRunSubagentStatus';
import {
    extractExecutionRunIdsFromAgentText,
    looksLikeExecutionRunStartText,
} from '../domains/session/subagents/executionRuns/executionRunTranscriptSignals';

type SourceMessageSnapshot = Readonly<{
    message: Message;
    permissionStatus?: NonNullable<ToolCall['permission']>['status'];
    runningFields?: ReturnType<typeof readTranscriptExecutionRunToolFields>;
    resultStatus?: ReturnType<typeof readExecutionRunResultStatus>;
    startsRun?: boolean;
    runIds?: readonly string[];
    children?: readonly SourceMessageSnapshot[];
}>;

export type SubagentSourceMessageProjection = Readonly<{
    messages: readonly Message[];
    snapshots: readonly SourceMessageSnapshot[];
    snapshotsByMessage: WeakMap<Message, SourceMessageSnapshot>;
}>;

function captureSourceMessage(
    message: Message,
    snapshotsByMessage: WeakMap<Message, SourceMessageSnapshot>,
): SourceMessageSnapshot {
    const cached = snapshotsByMessage.get(message);
    // Published messages are immutable except for shared permission decisions. Walk tools
    // to observe those decisions, but reuse unchanged text/run parsing and child snapshots.
    if (cached && message.kind !== 'tool-call') return cached;
    const snapshot = captureUncachedSourceMessage(message, snapshotsByMessage, cached);
    snapshotsByMessage.set(message, snapshot);
    return snapshot;
}

function captureUncachedSourceMessage(
    message: Message,
    snapshotsByMessage: WeakMap<Message, SourceMessageSnapshot>,
    cached?: SourceMessageSnapshot,
): SourceMessageSnapshot {
    if (message.kind === 'agent-text') {
        return {
            message,
            startsRun: looksLikeExecutionRunStartText(message.text),
            runIds: extractExecutionRunIdsFromAgentText(message.text),
        };
    }
    if (message.kind !== 'tool-call') return { message };
    const permissionStatus = message.tool.permission?.status;
    const children = captureSourceMessages(message.children, snapshotsByMessage, cached?.children);
    if (cached) {
        return cached.permissionStatus === permissionStatus && cached.children === children
            ? cached
            : { ...cached, permissionStatus, children };
    }
    const runningRun = message.tool.name === 'SubAgentRun' && message.tool.state === 'running';
    return {
        message,
        // Permission decisions can mutate the shared object; retain the observed value separately.
        permissionStatus,
        ...(runningRun ? {
            runningFields: readTranscriptExecutionRunToolFields(message.tool),
            resultStatus: readExecutionRunResultStatus(message.tool.result),
        } : {}),
        children,
    };
}

function captureSourceMessages(
    messages: readonly Message[],
    snapshotsByMessage: WeakMap<Message, SourceMessageSnapshot>,
    previous?: readonly SourceMessageSnapshot[],
): readonly SourceMessageSnapshot[] {
    let next = previous?.length === messages.length ? undefined : new Array<SourceMessageSnapshot>(messages.length);
    for (let index = 0; index < messages.length; index += 1) {
        const snapshot = captureSourceMessage(messages[index], snapshotsByMessage);
        if (!next && snapshot !== previous![index]) next = previous!.slice();
        if (next) next[index] = snapshot;
    }
    return next ?? previous!;
}

function areSourceMessagesEqual(left: SourceMessageSnapshot, right: SourceMessageSnapshot): boolean {
    if (left === right) return true;
    const a = left.message;
    const b = right.message;
    if (a.id !== b.id || a.kind !== b.kind || a.seq !== b.seq || a.createdAt !== b.createdAt
        || a.realID !== b.realID || a.localId !== b.localId) return false;
    if (a.kind === 'agent-text' && b.kind === 'agent-text') {
        return left.startsRun === right.startsRun && shallow(left.runIds, right.runIds);
    }
    if (a.kind !== 'tool-call' || b.kind !== 'tool-call') return a === b;
    const toolA = a.tool;
    const toolB = b.tool;
    if (toolA.id !== toolB.id || toolA.name !== toolB.name || toolA.state !== toolB.state
        || toolA.createdAt !== toolB.createdAt || toolA.startedAt !== toolB.startedAt
        || toolA.completedAt !== toolB.completedAt || toolA.description !== toolB.description
        || left.permissionStatus !== right.permissionStatus) return false;
    if (left.runningFields && right.runningFields) {
        const { backendTarget: targetA, launchOrigin: originA, ...fieldsA } = left.runningFields;
        const { backendTarget: targetB, launchOrigin: originB, ...fieldsB } = right.runningFields;
        if (left.resultStatus !== right.resultStatus || !shallow(fieldsA, fieldsB)
            || !shallow(targetA, targetB) || !shallow(originA, originB)) return false;
    } else {
        // Reducer publication replaces input/result on change and preserves unchanged references.
        if (toolA.input !== toolB.input || toolA.result !== toolB.result) return false;
    }
    return areSourceSnapshotsEqual(left.children!, right.children!);
}

function areSourceSnapshotsEqual(left: readonly SourceMessageSnapshot[], right: readonly SourceMessageSnapshot[]): boolean {
    return left.length === right.length && left.every((snapshot, index) => areSourceMessagesEqual(snapshot, right[index]));
}

export function reconcileSubagentSourceMessageProjection(
    messages: readonly Message[],
    previous?: SubagentSourceMessageProjection,
): SubagentSourceMessageProjection {
    // Owned by the session projection: cache eviction also releases this memoization.
    const snapshotsByMessage = previous?.snapshotsByMessage ?? new WeakMap<Message, SourceMessageSnapshot>();
    const snapshots = captureSourceMessages(messages, snapshotsByMessage, previous?.snapshots);
    return previous && areSourceSnapshotsEqual(previous.snapshots, snapshots)
        ? previous
        : { messages, snapshots, snapshotsByMessage };
}
