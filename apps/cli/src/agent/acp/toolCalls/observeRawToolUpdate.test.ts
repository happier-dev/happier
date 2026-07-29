import { describe, expect, it } from 'vitest';

import { AcpToolCallAccumulator } from './AcpToolCallAccumulator';
import { observeRawAcpToolUpdate, parseRawAcpToolUpdate } from './observeRawToolUpdate';

describe('observeRawAcpToolUpdate', () => {
    it('is the canonical raw parser and preserves exact opaque ids and nullable patches', () => {
        const accumulator = new AcpToolCallAccumulator();
        const exactId = ' call\n\0id ';

        const parsed = parseRawAcpToolUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: exactId,
            title: null,
            kind: 'edit',
            status: 'in_progress',
            rawInput: { path: 'a.ts' },
            content: null,
            locations: null,
        });
        expect(parsed.toolCallId).toBe(exactId);

        expect(observeRawAcpToolUpdate({
            accumulator,
            update: parsed,
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: null,
            revision: 1,
            observedAtMs: 1,
            semanticName: 'Edit',
        })).toMatchObject({
            kind: 'progress',
            call: {
                toolCallId: exactId,
                toolName: 'Edit',
                kind: 'edit',
                rawInput: { path: 'a.ts' },
            },
        });
    });

    it('rejects malformed calls before mutating the accumulator', () => {
        const accumulator = new AcpToolCallAccumulator();

        expect(() => observeRawAcpToolUpdate({
            accumulator,
            update: { sessionUpdate: 'tool_call', toolCallId: 'call-1' },
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: null,
            revision: 1,
            observedAtMs: 1,
        })).toThrow(/title/u);
        expect(accumulator.activeSize).toBe(0);
    });
});
