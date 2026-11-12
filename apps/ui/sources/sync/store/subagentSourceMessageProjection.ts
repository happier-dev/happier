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
}>;

function captureSourceMessage(message: Message): SourceMessageSnapshot {
    if (message.kind === 'agent-text') {
        return {
            message,
            startsRun: looksLikeExecutionRunStartText(message.text),
            runIds: extractExecutionRunIdsFromAgentText(message.text),
        };
    }
    if (message.kind !== 'tool-call') return { message };
    const runningRun = message.tool.name === 'SubAgentRun' && message.tool.state === 'running';
    return {
        message,
        // Permission decisions can mutate the shared object; retain the observed value separately.
        permissionStatus: message.tool.permission?.status,
        ...(runningRun ? {
            runningFields: readTranscriptExecutionRunToolFields(message.tool),
            resultStatus: readExecutionRunResultStatus(message.tool.result),
        } : {}),
        children: message.children.map(captureSourceMessage),
    };
}

function areSourceMessagesEqual(left: SourceMessageSnapshot, right: SourceMessageSnapshot): boolean {
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
    const snapshots = messages.map(captureSourceMessage);
    return previous && areSourceSnapshotsEqual(previous.snapshots, snapshots)
        ? previous
        : { messages, snapshots };
}
