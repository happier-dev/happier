import { useMemo, useRef } from 'react';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import {
    THEME_ACTION_IDS, isThemeActionId, ThemeActionInputSchemas, ThemeActionOutputSchemas,
    type ThemeActionId, type ThemeActionInput, type ThemeActionOutput,
} from '@happier-dev/protocol/actions/themeActionFamily';
import { withoutClientActionInput } from '@happier-dev/protocol/actions/clientActionInput';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import {
    isRecord, readHappierActionCallId, readHappierActionCallInput, readHappierActionToolResultCandidates,
} from '@/components/sessions/transcript/references/happierActionToolResult';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';

export type TranscriptThemeAction = {
    [Id in ThemeActionId]: Readonly<{ actionId: Id; input: ThemeActionInput<Id>; output: ThemeActionOutput<Id> }>;
}[ThemeActionId];
export type TranscriptThemeTry = Extract<TranscriptThemeAction, { actionId: typeof THEME_ACTION_IDS.tryOn }>;
export type TranscriptThemeCardAction = Extract<TranscriptThemeAction, { actionId:
    typeof THEME_ACTION_IDS.tryOn | typeof THEME_ACTION_IDS.keep | typeof THEME_ACTION_IDS.apply }>;
export type ThemeActionCardPresentation = Readonly<{
    cardId: string;
    call: TranscriptThemeCardAction;
    options: readonly Readonly<{ id: string; call: TranscriptThemeTry }>[];
    /** Keep only sends a handle. Its prior validated try supplies retained replay input. */
    replayTry: TranscriptThemeTry | null;
    /** Consecutive grouped proposals have one controls host, on their final tool. */
    visible: boolean;
}>;

type PendingThemeTry = Readonly<{
    actionId: typeof THEME_ACTION_IDS.tryOn;
    input: TranscriptThemeTry['input'];
    artifactId: string;
}>;
type ThemeToolOutcome = TranscriptThemeAction | PendingThemeTry;
type ReadThemeCall = (tool: ToolCall) => TranscriptThemeAction | null;

const decodedCalls = new WeakMap<ToolCall, Readonly<{
    name: string; input: unknown; result: unknown; call: ThemeToolOutcome | null;
}>>();

/** Validate at the transcript boundary through the Action's canonical input/output schemas. */
function readThemeToolOutcome(tool: ToolCall): ThemeToolOutcome | null {
    if (tool.state !== 'completed') return null;
    const cached = decodedCalls.get(tool);
    if (cached && cached.name === tool.name && cached.input === tool.input && cached.result === tool.result) {
        return cached.call;
    }
    const call = decodeTranscriptThemeAction(tool);
    decodedCalls.set(tool, { name: tool.name, input: tool.input, result: tool.result, call });
    return call;
}

function decodeTranscriptThemeAction(tool: ToolCall): ThemeToolOutcome | null {
    const actionId = readHappierActionCallId(tool.name, tool.input);
    if (!actionId || !isThemeActionId(actionId)) return null;
    const args = withoutClientActionInput(readHappierActionCallInput(tool.name, tool.input));
    const input = ThemeActionInputSchemas[actionId].safeParse(args);
    if (!input.success) return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        const value = isRecord(candidate) && candidate.ok === true ? candidate.result : candidate;
        const output = ThemeActionOutputSchemas[actionId].safeParse(value);
        // Both schemas are keyed by this same catalog-owned id; the cast retains that correlation.
        if (output.success) return { actionId, input: input.data, output: output.data } as TranscriptThemeAction;
        if (actionId === THEME_ACTION_IDS.tryOn && isRecord(value) && value.kind === 'approval_request_created') {
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(value);
            if (approval.success && approval.data.actionId === actionId) {
                return { actionId, input: input.data as TranscriptThemeTry['input'], artifactId: approval.data.artifactId };
            }
        }
    }
    return null;
}

const decodedReceipts = new WeakMap<Message, Readonly<{ artifactId: string; output: TranscriptThemeTry['output'] }> | null>();

/** The deferred approval publisher delivers an admitted host input to the originating Session. */
function decodeSettledThemeTry(message: Message | undefined, artifactId: string): TranscriptThemeTry['output'] | undefined {
    if (message?.kind !== 'user-text') return undefined;
    if (!decodedReceipts.has(message)) {
        decodedReceipts.set(message, readSettledThemeTry(message));
    }
    const receipt = decodedReceipts.get(message);
    return receipt?.artifactId === artifactId ? receipt.output : undefined;
}

function readSettledThemeTry(message: Extract<Message, { kind: 'user-text' }>) {
    const provenance = readSessionMessageProvenanceV1(message.meta, 'stored');
    if (provenance?.kind !== 'host' || provenance.producer !== 'happierMcp') return null;
    let receipt: unknown;
    try {
        receipt = JSON.parse(message.text);
    } catch {
        return null;
    }
    if (!isRecord(receipt) || typeof receipt.artifactId !== 'string' || receipt.actionId !== THEME_ACTION_IDS.tryOn
        || receipt.ok !== true || receipt.status !== 'executed' || !isRecord(receipt.execution) || receipt.execution.ok !== true) return null;
    const output = ThemeActionOutputSchemas[THEME_ACTION_IDS.tryOn].safeParse(receipt.execution.result);
    return output.success ? { artifactId: receipt.artifactId, output: output.data } : null;
}

export function readTranscriptThemeAction(tool: ToolCall): TranscriptThemeAction | null {
    const call = readThemeToolOutcome(tool);
    return call && 'output' in call ? call : null;
}

type TranscriptNeighbors = Readonly<{ index: number; at: (position: number) => Message | undefined; readCall: ReadThemeCall }>;

/** Options stay in the transcript's retained input documents; no candidate registry or writes. */
export function readThemeActionCardPresentation(input: Readonly<{
    tool: ToolCall; messages: readonly Message[]; messageId?: string;
}>, neighbors?: TranscriptNeighbors): ThemeActionCardPresentation | null {
    const readCall = neighbors?.readCall ?? readTranscriptThemeAction;
    const call = readCall(input.tool);
    if (!call) return null;
    if (call.actionId !== THEME_ACTION_IDS.tryOn && call.actionId !== THEME_ACTION_IDS.keep && call.actionId !== THEME_ACTION_IDS.apply) return null;
    const cardId = input.messageId ?? input.tool.id
        ?? (call.actionId === THEME_ACTION_IDS.tryOn ? call.output.previewRef : call.output.undoHandle);
    if (call.actionId === THEME_ACTION_IDS.keep) {
        for (let position = input.messages.length - 1; position >= 0; position--) {
            const previous = input.messages[position];
            if (previous.kind !== 'tool-call') continue;
            const proposal = readCall(previous.tool);
            if (proposal?.actionId === THEME_ACTION_IDS.tryOn && proposal.output.previewRef === call.input.previewRef) {
                return { cardId, call, options: [], replayTry: proposal, visible: true };
            }
        }
        // Paginated history may omit the input needed for Redo. Keep the generic tool result then.
        return null;
    }
    if (call.actionId === THEME_ACTION_IDS.apply) {
        return { cardId, call, options: [], replayTry: null, visible: true };
    }
    if (!call.input.group) return { cardId, call, options: [], replayTry: call, visible: true };
    const index = neighbors?.index ?? input.messages.findIndex(message => message.kind === 'tool-call' && (
        message.tool === input.tool || (input.messageId ? message.id === input.messageId : Boolean(input.tool.id && message.tool.id === input.tool.id))
    ));
    const own = { id: input.tool.id ?? input.messageId ?? call.output.previewRef, call };
    if (index < 0) return { cardId, call, options: [own], replayTry: call, visible: true };

    const at = neighbors?.at ?? ((position: number) => input.messages[position]);
    const adjacentOption = (from: number, step: 1 | -1) => {
        let position = from + step;
        let message = at(position);
        // Reasoning between tool calls is part of the same proposal, during a streamed agent turn.
        while (message?.kind === 'agent-text' && message.isThinking) message = at(position += step);
        if (message?.kind !== 'tool-call') return null;
        const option = readCall(message.tool);
        return option?.actionId === THEME_ACTION_IDS.tryOn && option.input.group === call.input.group
            ? { position, id: message.tool.id ?? message.id, call: option }
            : null;
    };
    if (adjacentOption(index, 1)) return { cardId, call, options: [], replayTry: call, visible: false };
    const options = [own];
    for (let previous = adjacentOption(index, -1); previous; previous = adjacentOption(previous.position, -1)) {
        options.push({ id: previous.id, call: previous.call });
    }
    return { cardId, call, options: options.reverse(), replayTry: call, visible: true };
}

/** Select the grouped card presentation from the owning live Session, with a local fallback for detached renders. */
export function useThemeActionCardPresentation(
    enabled: boolean, tool: ToolCall, messages: readonly Message[], messageId?: string, sessionId?: string,
): ThemeActionCardPresentation | null {
    const source = useOptionalSessionTranscriptSource();
    const call = enabled ? readThemeToolOutcome(tool) : null;
    const liveSessionId = source?.kind === 'app' && source.sessionId === sessionId && tool.id
        && call?.actionId === THEME_ACTION_IDS.tryOn && ('artifactId' in call || call.input.group) ? source.sessionId : undefined;
    const serverId = liveSessionId ? source?.serverId : undefined;
    const activeServerId = useActiveServerSnapshot(Boolean(serverId)).serverId;
    const retainedFallback = useRef<ThemeActionCardPresentation | null>(null);
    const fallback = useMemo(() => {
        if (!enabled) return null;
        return retainedFallback.current = retainDeep(retainedFallback.current, readThemeActionCardPresentation({ tool, messages, messageId }));
    }, [enabled, tool, messages, messageId]);
    const selector = useMemo(() => {
        let ids: readonly string[] | undefined;
        let reducer: StorageState['sessionMessages'][string]['reducerState'] | undefined;
        let version: number | undefined;
        let index = -1;
        let current = fallback;
        return (state: StorageState) => {
            if (!liveSessionId || !tool.id) return fallback;
            const scoped = !serverId || selectHomeQualifiedSession(state, liveSessionId, serverId, activeServerId);
            const transcript = scoped ? state.sessionMessages[liveSessionId] : undefined;
            if (!transcript) return fallback;
            const structureVersion = transcript.transcriptStructureVersion ?? transcript.messagesVersion;
            if (ids === transcript.messageIdsOldestFirst && reducer === transcript.reducerState && version === structureVersion) return current;
            ids = transcript.messageIdsOldestFirst;
            reducer = transcript.reducerState;
            version = structureVersion;
            const anchorId = transcript.reducerState.toolIdToMessageId.get(tool.id);
            if (anchorId === undefined) return current = fallback;
            // Appends leave this position alone. Re-find it when history is inserted or replaced.
            if (ids[index] !== anchorId) index = ids.lastIndexOf(anchorId);
            if (index < 0) return current = fallback;
            const at = (position: number) => transcript.messagesById[transcript.messageIdsOldestFirst[position]];
            const readCall: ReadThemeCall = candidate => {
                const result = readThemeToolOutcome(candidate);
                if (!result || 'output' in result) return result;
                // actionExecutor publishes to this Session with the approval Artifact's stable local id.
                const receiptId = transcript.reducerState.localIds.get(`approval-result:${result.artifactId}`);
                const output = decodeSettledThemeTry(receiptId === undefined ? undefined : transcript.messagesById[receiptId], result.artifactId);
                return output ? { actionId: result.actionId, input: result.input, output } : null;
            };
            return current = retainDeep(current, readThemeActionCardPresentation({ tool, messages, messageId }, { index, at, readCall }));
        };
    }, [activeServerId, fallback, liveSessionId, messageId, messages, serverId, tool]);
    return getStorage()(selector, {
        sessionMessages: liveSessionId ? [liveSessionId] : [],
        sessions: serverId && liveSessionId ? [liveSessionId] : [],
    });
}
