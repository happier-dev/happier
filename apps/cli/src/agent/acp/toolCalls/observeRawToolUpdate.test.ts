import { describe, expect, it } from 'vitest';

import { AcpToolCallAccumulator } from './AcpToolCallAccumulator';
import { observeRawAcpToolUpdate, parseRawAcpToolUpdate } from './observeRawToolUpdate';

describe('observeRawAcpToolUpdate', () => {
    it('retains normalized MCP identity and internal provenance through partial updates', () => {
        const accumulator = new AcpToolCallAccumulator();
        const observe = (update: unknown, revision: number) => observeRawAcpToolUpdate({
            accumulator, update, sessionId: 'session-1', turnId: 'turn-1', sidechainId: null,
            revision, observedAtMs: revision, semanticName: 'other',
        });
        expect(observe({
            sessionUpdate: 'tool_call', toolCallId: 'opaque-mcp-call', name: 'echo', title: 'Echo', kind: 'other',
            toolMetadata: { mcp: { server: 'probe', tool: 'echo' }, internal: true },
        }, 1)).toMatchObject({ call: {
            name: 'echo', toolName: 'mcp__probe__echo',
            toolMetadata: { mcp: { server: 'probe', tool: 'echo' }, internal: true },
        } });
        expect(observe({
            sessionUpdate: 'tool_call_update', toolCallId: 'opaque-mcp-call', status: 'completed',
            toolMetadata: { internal: false },
        }, 2)).toMatchObject({ call: {
            name: 'echo', toolName: 'mcp__probe__echo',
            toolMetadata: { mcp: { server: 'probe', tool: 'echo' }, internal: false },
        }, result: { toolName: 'mcp__probe__echo' } });
    });

    it('retains the standard FX tool name across sparse updates instead of its presentation kind or title', () => {
        const accumulator = new AcpToolCallAccumulator();
        const observe = (update: unknown, revision: number, semanticName = 'edit') => observeRawAcpToolUpdate({
            accumulator,
            update,
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: null,
            revision,
            observedAtMs: revision,
            semanticName,
        });

        // FX 0.0.14 capture, 2026-10-27: E-fx-live-probe.md §3, ask-mode write_file.
        expect(observe({
            sessionUpdate: 'tool_call',
            toolCallId: '<T1>',
            name: 'write_file',
            title: 'file_mutation',
            kind: 'edit',
            status: 'pending',
            rawInput: { path: 'probe-ok.txt', content: 'ok' },
        }, 1)).toMatchObject({ kind: 'progress', call: { toolName: 'write_file' } });
        expect(observe({
            sessionUpdate: 'tool_call_update', toolCallId: '<T1>', status: 'in_progress', name: '  ',
        }, 2)).toMatchObject({ kind: 'progress', call: { toolName: 'write_file', status: 'running' } });
        expect(observe({
            sessionUpdate: 'tool_call_update', toolCallId: '<T1>', status: 'in_progress', name: null,
        }, 3)).toEqual({ kind: 'ignored', reason: 'duplicate' });
        expect(observe({
            sessionUpdate: 'tool_call_update', toolCallId: '<T1>', status: 'completed', name: null,
            content: [{ type: 'content', content: { type: 'text', text: 'wrote probe-ok.txt (2 bytes)' } }],
        }, 4)).toMatchObject({
            kind: 'terminal',
            call: { toolName: 'write_file', title: 'file_mutation', kind: 'edit' },
            result: { toolName: 'write_file' },
        });
    });

    it.each([
        { toolCallId: 'opaque-subagent-call', name: 'subagent', expected: 'subagent' },
        { toolCallId: 'opaque-mcp-call', name: 'mcp__probe__echo', expected: 'mcp__probe__echo' },
        { toolCallId: 'legacy-without-name', name: undefined, expected: 'Read' },
        { toolCallId: 'legacy-blank-name', name: '  ', expected: 'Read' },
    ])('uses named identity with opaque ids and preserves legacy inference: $toolCallId', ({ toolCallId, name, expected }) => {
        // Adjacent H5 cases from C2-fx-acp-sol.md; only write_file above is a live-captured tool invocation.
        expect(observeRawAcpToolUpdate({
            accumulator: new AcpToolCallAccumulator(),
            update: { sessionUpdate: 'tool_call', toolCallId, name, title: 'Work', kind: 'other' },
            sessionId: 'session-1',
            turnId: 'turn-1',
            sidechainId: null,
            revision: 1,
            observedAtMs: 1,
            semanticName: 'Read',
        })).toMatchObject({ call: { toolCallId, toolName: expected } });
    });

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
