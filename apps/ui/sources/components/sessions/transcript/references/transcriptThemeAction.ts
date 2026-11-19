import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import {
    THEME_ACTION_IDS, isThemeActionId, ThemeActionInputSchemas, ThemeActionOutputSchemas,
    type ThemeActionId, type ThemeActionInput, type ThemeActionOutput,
} from '@happier-dev/protocol/actions/themeActionFamily';
import { withoutClientActionInput } from '@happier-dev/protocol/actions/clientActionInput';
import {
    isRecord, readHappierActionCallId, readHappierActionCallInput, readHappierActionToolResultCandidates,
} from '@/components/sessions/transcript/references/happierActionToolResult';

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

/** Validate at the transcript boundary through the Action's canonical input/output schemas. */
export function readTranscriptThemeAction(tool: ToolCall): TranscriptThemeAction | null {
    if (tool.state !== 'completed') return null;
    const actionId = readHappierActionCallId(tool.name, tool.input);
    if (!actionId || !isThemeActionId(actionId)) return null;
    const input = ThemeActionInputSchemas[actionId].safeParse(withoutClientActionInput(readHappierActionCallInput(tool.name, tool.input)));
    if (!input.success) return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        const value = isRecord(candidate) && candidate.ok === true ? candidate.result : candidate;
        const output = ThemeActionOutputSchemas[actionId].safeParse(value);
        // Both schemas are keyed by this same catalog-owned id; the cast retains that correlation.
        if (output.success) return { actionId, input: input.data, output: output.data } as TranscriptThemeAction;
    }
    return null;
}

/** Options stay in the transcript's retained input documents; no candidate registry or writes. */
export function readThemeActionCardPresentation(input: Readonly<{
    tool: ToolCall; messages: readonly Message[]; messageId?: string;
}>): ThemeActionCardPresentation | null {
    const call = readTranscriptThemeAction(input.tool);
    if (!call) return null;
    if (call.actionId !== THEME_ACTION_IDS.tryOn && call.actionId !== THEME_ACTION_IDS.keep && call.actionId !== THEME_ACTION_IDS.apply) return null;
    const cardId = input.messageId ?? input.tool.id
        ?? (call.actionId === THEME_ACTION_IDS.tryOn ? call.output.previewRef : call.output.undoHandle);
    if (call.actionId === THEME_ACTION_IDS.keep) {
        for (let position = input.messages.length - 1; position >= 0; position--) {
            const previous = input.messages[position];
            if (previous.kind !== 'tool-call') continue;
            const proposal = readTranscriptThemeAction(previous.tool);
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
    const index = input.messages.findIndex(message => message.kind === 'tool-call' && (
        message.tool === input.tool || (input.messageId ? message.id === input.messageId : Boolean(input.tool.id && message.tool.id === input.tool.id))
    ));
    const own = { id: input.tool.id ?? input.messageId ?? call.output.previewRef, call };
    if (index < 0) return { cardId, call, options: [own], replayTry: call, visible: true };
    const optionAt = (position: number) => {
        const message = input.messages[position];
        if (message?.kind !== 'tool-call') return null;
        const option = message.tool === input.tool ? call : readTranscriptThemeAction(message.tool);
        if (option?.actionId !== THEME_ACTION_IDS.tryOn || option.input.group !== call.input.group) return null;
        return { id: message.tool.id ?? message.id, call: option };
    };
    let first = index;
    while (first > 0 && optionAt(first - 1)) first--;
    const options: Array<Readonly<{ id: string; call: TranscriptThemeTry }>> = [];
    for (let position = first; position < input.messages.length; position++) {
        const option = optionAt(position);
        if (!option) break;
        options.push(option);
    }
    return { cardId, call, options, replayTry: call, visible: index === first + options.length - 1 };
}
