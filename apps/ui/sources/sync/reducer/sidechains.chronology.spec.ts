import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

const PARENT_TOOL_ID = 'subagent_run_1';

function parentTool(): NormalizedMessage {
    return {
        id: 'msg_run',
        localId: null,
        seq: 1,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [
            {
                type: 'tool-call',
                id: PARENT_TOOL_ID,
                name: 'SubAgentRun',
                input: { intent: 'review' },
                description: null,
                uuid: 'uuid_run',
                parentUUID: null,
            },
        ],
    } as any;
}

function sidechainText(params: Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    text: string;
    streamKey?: string;
}>): NormalizedMessage {
    const msg: any = {
        id: params.id,
        localId: null,
        seq: params.seq,
        createdAt: params.createdAt,
        role: 'agent',
        isSidechain: true,
        ...(params.streamKey ? { meta: { happierSidechainStreamKey: params.streamKey } } : {}),
        content: [
            {
                type: 'text',
                text: params.text,
                uuid: `uuid_${params.id}`,
                parentUUID: null,
            },
        ],
    };
    msg.sidechainId = PARENT_TOOL_ID;
    return msg as NormalizedMessage;
}

function sidechainThinking(params: Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    thinking: string;
}>): NormalizedMessage {
    const msg: any = {
        id: params.id,
        localId: null,
        seq: params.seq,
        createdAt: params.createdAt,
        role: 'agent',
        isSidechain: true,
        content: [
            {
                type: 'thinking',
                thinking: params.thinking,
                uuid: `uuid_${params.id}`,
                parentUUID: null,
            },
        ],
    };
    msg.sidechainId = PARENT_TOOL_ID;
    return msg as NormalizedMessage;
}

function sidechainThinkingSegment(params: Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    segmentLocalId: string;
    thinking: string;
}>): NormalizedMessage {
    const msg: any = {
        id: params.id,
        localId: params.segmentLocalId,
        seq: params.seq,
        createdAt: params.createdAt,
        role: 'agent',
        isSidechain: true,
        meta: {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'thinking',
                segmentLocalId: params.segmentLocalId,
                segmentState: 'complete',
                updatedAtMs: params.createdAt,
            },
        },
        content: [
            {
                type: 'thinking',
                thinking: params.thinking,
                uuid: `uuid_${params.id}`,
                parentUUID: null,
            },
        ],
    };
    msg.sidechainId = PARENT_TOOL_ID;
    return msg as NormalizedMessage;
}

function readChildren(result: ReturnType<typeof reducer>): any[] {
    const toolMessage = result.messages.find(
        (m: any) => m.kind === 'tool-call' && m.tool?.name === 'SubAgentRun',
    ) as any;
    expect(toolMessage).toBeTruthy();
    return toolMessage.children as any[];
}

describe('sidechain child chronology across paged batches', () => {
    it('orders an older page before the already-applied newer page', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);

        // Newest page arrives first (paging always starts from the latest rows).
        reducer(state, [
            sidechainText({ id: 'msg_sc_5', seq: 5, createdAt: 5000, text: 'five' }),
            sidechainText({ id: 'msg_sc_6', seq: 6, createdAt: 6000, text: 'six' }),
        ]);

        // The user scrolls up: the older page is fetched and applied afterwards.
        const result = reducer(state, [
            sidechainText({ id: 'msg_sc_2', seq: 2, createdAt: 2000, text: 'two' }),
            sidechainText({ id: 'msg_sc_3', seq: 3, createdAt: 3000, text: 'three' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['two', 'three', 'five', 'six']);
    });

    it('does not merge an older same-stream chunk into the newer tail chunk', () => {
        const state = createReducer();
        const streamKey = 'sc_stream_key_paged';

        reducer(state, [parentTool()]);

        reducer(state, [
            sidechainText({ id: 'msg_sc_late', seq: 9, createdAt: 9000, text: 'LATE', streamKey }),
        ]);

        const result = reducer(state, [
            sidechainText({ id: 'msg_sc_early', seq: 4, createdAt: 4000, text: 'EARLY', streamKey }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['EARLY', 'LATE']);
    });

    it('still merges consecutive same-stream chunks that arrive in order', () => {
        const state = createReducer();
        const streamKey = 'sc_stream_key_inorder';

        reducer(state, [parentTool()]);
        reducer(state, [sidechainText({ id: 'msg_sc_a', seq: 2, createdAt: 2000, text: 'Work', streamKey })]);
        const result = reducer(state, [
            sidechainText({ id: 'msg_sc_b', seq: 3, createdAt: 3000, text: 'ing...', streamKey }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['Working...']);
    });
    it('still merges same-stream chunks that arrive together inside an older page', () => {
        const state = createReducer();
        const streamKey = 'sc_stream_key_older_page';

        reducer(state, [parentTool()]);
        reducer(state, [sidechainText({ id: 'msg_sc_tail', seq: 9, createdAt: 9000, text: 'TAIL' })]);

        // One streamed block, delivered as two chunks, entirely inside the older page.
        const result = reducer(state, [
            sidechainText({ id: 'msg_sc_h', seq: 2, createdAt: 2000, text: 'Hel', streamKey }),
            sidechainText({ id: 'msg_sc_o', seq: 3, createdAt: 3000, text: 'lo', streamKey }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['Hello', 'TAIL']);
    });

    it('still merges thinking chunks that arrive together inside an older page', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);
        reducer(state, [sidechainText({ id: 'msg_sc_tail2', seq: 9, createdAt: 9000, text: 'TAIL' })]);

        const result = reducer(state, [
            sidechainThinking({ id: 'msg_th_r', seq: 2, createdAt: 2000, thinking: 'Rea' }),
            sidechainThinking({ id: 'msg_th_s', seq: 3, createdAt: 3000, thinking: 'son' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['Reason', 'TAIL']);
    });

    it('does not append an older page\'s thinking chunk onto the newer thinking block', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);
        reducer(state, [sidechainThinking({ id: 'msg_th_late', seq: 9, createdAt: 9000, thinking: 'LATE' })]);

        const result = reducer(state, [
            sidechainThinking({ id: 'msg_th_early', seq: 4, createdAt: 4000, thinking: 'EARLY' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['EARLY', 'LATE']);
        expect(children.every((c) => c.isThinking === true)).toBe(true);
    });

    it('keeps the thinking merge cursor on the newest block after an older page lands', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);
        reducer(state, [sidechainThinking({ id: 'msg_th_9', seq: 9, createdAt: 9000, thinking: 'LATE' })]);
        reducer(state, [sidechainThinking({ id: 'msg_th_4', seq: 4, createdAt: 4000, thinking: 'EARLY' })]);

        // A live continuation of the newest block must still extend the newest block.
        const result = reducer(state, [
            sidechainThinking({ id: 'msg_th_10', seq: 10, createdAt: 10000, thinking: '-CONT' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['EARLY', 'LATE-CONT']);
    });
    it('keeps the thinking merge cursor on the newest block after an older page MERGES two thinking chunks', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);
        reducer(state, [sidechainThinking({ id: 'msg_th_l', seq: 9, createdAt: 9000, thinking: 'LATE' })]);

        // Two chunks inside the older page: the second one takes the *append* path.
        reducer(state, [
            sidechainThinking({ id: 'msg_th_p', seq: 2, createdAt: 2000, thinking: 'Rea' }),
            sidechainThinking({ id: 'msg_th_q', seq: 3, createdAt: 3000, thinking: 'son' }),
        ]);

        // The live continuation must still extend the newest block, not the older merged one.
        const result = reducer(state, [
            sidechainThinking({ id: 'msg_th_12', seq: 12, createdAt: 12000, thinking: '-CONT' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['Reason', 'LATE-CONT']);
    });

    it('keeps the thinking merge cursor on the newest block when an older stream segment is re-delivered', () => {
        const state = createReducer();

        reducer(state, [parentTool()]);
        reducer(state, [
            sidechainThinkingSegment({
                id: 'msg_seg_late',
                seq: 9,
                createdAt: 9000,
                segmentLocalId: 'seg_late',
                thinking: 'LATE',
            }),
        ]);
        reducer(state, [
            sidechainThinkingSegment({
                id: 'msg_seg_early',
                seq: 4,
                createdAt: 4000,
                segmentLocalId: 'seg_early',
                thinking: 'EARLY',
            }),
        ]);

        const result = reducer(state, [
            sidechainThinking({ id: 'msg_th_11', seq: 11, createdAt: 11000, thinking: '-CONT' }),
        ]);

        const children = readChildren(result);
        expect(children.map((c) => c.text)).toEqual(['EARLY', 'LATE-CONT']);
    });
});
