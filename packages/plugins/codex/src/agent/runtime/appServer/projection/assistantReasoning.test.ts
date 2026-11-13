import { describe, expect, it } from 'vitest';

import { createCodexAppServerAssistantReasoningProjector } from './assistantReasoning';

function createRecordingBridge() {
    const assistantDeltas: Array<Readonly<{ deltaText: string; streamKey: string; sidechainId: string | null }>> = [];
    const assistantOverrides: Array<Readonly<{ text: string; streamKey: string; sidechainId: string | null }>> = [];
    const thinkingDeltas: Array<Readonly<{ deltaText: string; streamKey: string; sidechainId: string | null }>> = [];
    const thinkingOverrides: Array<Readonly<{ text: string; streamKey: string; sidechainId: string | null }>> = [];
    return {
        assistantDeltas,
        assistantOverrides,
        thinkingDeltas,
        thinkingOverrides,
        bridge: {
            appendAssistantDelta(args: Readonly<{ deltaText: string; streamKey: string; sidechainId: string | null }>) {
                assistantDeltas.push(args);
            },
            appendThinkingDelta(args: Readonly<{ deltaText: string; streamKey: string; sidechainId: string | null }>) {
                thinkingDeltas.push(args);
            },
            overrideAssistantText(args: Readonly<{ text: string; streamKey: string; sidechainId: string | null }>) {
                assistantOverrides.push(args);
            },
            overrideThinkingText(args: Readonly<{ text: string; streamKey: string; sidechainId: string | null }>) {
                thinkingOverrides.push(args);
            },
            async flushAll() {},
        },
    };
}

describe('createCodexAppServerAssistantReasoningProjector', () => {
    it('drops compaction text and restores raw assistant fallback after cancellation', async () => {
        const recording = createRecordingBridge();
        const projector = createCodexAppServerAssistantReasoningProjector({ bridge: recording.bridge });
        const context = { sidechainId: null, streamScopeId: 'cancelled-turn' };
        projector.observeStreamUpdate({ type: 'context-compaction-started' }, context);
        projector.observeStreamUpdate({ type: 'assistant-raw-final', itemId: 'summary', text: 'Internal context' }, context);
        await projector.flush('abort');
        expect(recording.assistantDeltas).toEqual([]);
        projector.observeStreamUpdate({ type: 'assistant-raw-final', itemId: 'reply', text: 'New answer' },
            { sidechainId: null, streamScopeId: 'new-turn' });
        await projector.flush('turn-end');
        expect(recording.assistantDeltas.map(event => event.deltaText)).toEqual(['New answer']);
    });

    it('keeps separate Codex assistant items on item-scoped transcript streams', () => {
        const recording = createRecordingBridge();
        const projector = createCodexAppServerAssistantReasoningProjector({ bridge: recording.bridge });
        const context = { sidechainId: null, streamScopeId: 'turn_1' };

        projector.observeStreamUpdate({ type: 'assistant-text-delta', itemId: 'plan_1', text: 'Plan' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-final', itemId: 'plan_1', text: 'Plan final' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-delta', itemId: 'msg_1', text: 'Answer' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-final', itemId: 'msg_1', text: 'Answer final' }, context);

        expect(recording.assistantDeltas).toEqual([
            { deltaText: 'Plan', streamKey: 'turn_1:assistant:plan_1', sidechainId: null },
            { deltaText: ' final', streamKey: 'turn_1:assistant:plan_1', sidechainId: null },
            { deltaText: 'Answer', streamKey: 'turn_1:assistant:msg_1', sidechainId: null },
            { deltaText: ' final', streamKey: 'turn_1:assistant:msg_1', sidechainId: null },
        ]);
        expect(recording.assistantOverrides).toEqual([]);
    });

    it('commits an item-scoped raw final when another assistant item has a normalized final', async () => {
        const recording = createRecordingBridge();
        const projector = createCodexAppServerAssistantReasoningProjector({ bridge: recording.bridge });
        const context = { sidechainId: null, streamScopeId: 'turn_1' };

        projector.observeStreamUpdate({
            type: 'assistant-raw-final',
            itemId: 'raw_msg_1',
            text: 'Raw final',
        }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-delta', itemId: 'msg_2', text: 'Normalized' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-final', itemId: 'msg_2', text: 'Normalized final' }, context);
        await projector.flush('turn-end');

        expect(recording.assistantDeltas).toEqual([
            { deltaText: 'Raw final', streamKey: 'turn_1:assistant:raw_msg_1', sidechainId: null },
            { deltaText: 'Normalized', streamKey: 'turn_1:assistant:msg_2', sidechainId: null },
            { deltaText: ' final', streamKey: 'turn_1:assistant:msg_2', sidechainId: null },
        ]);
    });

    it('prefers the normalized final for the current item over its pending raw snapshot', async () => {
        const recording = createRecordingBridge();
        const projector = createCodexAppServerAssistantReasoningProjector({ bridge: recording.bridge });
        const context = { sidechainId: null, streamScopeId: 'turn_1' };
        projector.observeStreamUpdate({ type: 'assistant-text-delta', itemId: 'msg_1', text: 'Draft' }, context);
        projector.observeStreamUpdate({ type: 'assistant-raw-final', itemId: 'msg_1', text: 'Raw candidate' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-final', itemId: 'msg_1', text: 'Normalized final' }, context);
        projector.observeStreamUpdate({ type: 'assistant-text-delta', itemId: 'msg_2', text: 'Acknowledgment' }, context);
        await projector.flush('turn-end');
        expect(recording.assistantDeltas.map((event) => event.deltaText)).toEqual(['Draft', 'Acknowledgment']);
        expect(recording.assistantOverrides).toEqual([
            { text: 'Normalized final', streamKey: 'turn_1:assistant:msg_1', sidechainId: null },
        ]);
    });
});
