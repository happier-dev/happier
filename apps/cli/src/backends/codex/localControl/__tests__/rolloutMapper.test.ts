import { describe, expect, it } from 'vitest';
import { mapCodexRolloutEventToActions } from '../rolloutMapper';

describe('mapCodexRolloutEventToActions', () => {
    it('extracts codex session id from session_meta', () => {
        const actions = mapCodexRolloutEventToActions(
            { type: 'session_meta', payload: { id: 'abc' } },
            { debug: false },
        );
        expect(actions).toEqual([{ type: 'codex-session-id', id: 'abc' }]);
    });

    it('maps user message to user-text (filters harness blobs by default)', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
            },
            { debug: false },
        );
        expect(actions).toEqual([{ type: 'user-text', text: 'hello' }]);

        const filtered = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] },
            },
            { debug: false },
        );
        expect(filtered).toEqual([]);
    });

    it('maps assistant message to assistant-text', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
            },
            { debug: false },
        );
        expect(actions).toEqual([{ type: 'assistant-text', text: 'hi' }]);
    });

    it('maps exec_command function_call to Bash tool-call', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'exec_command',
                    arguments: '{"cmd":"echo hi"}',
                    call_id: 'call_1',
                },
            },
            { debug: false },
        );

        expect(actions).toEqual([
            {
                type: 'tool-call',
                callId: 'call_1',
                name: 'Bash',
                input: { cmd: 'echo hi', _happier: { sessionMode: 'local_control' } },
            },
        ]);
    });

    it('maps apply_patch custom_tool_call to Patch tool-call with patch string', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    name: 'apply_patch',
                    input: '*** Begin Patch\n*** End Patch',
                    call_id: 'call_2',
                },
            },
            { debug: false },
        );

        expect(actions).toEqual([
            {
                type: 'tool-call',
                callId: 'call_2',
                name: 'Patch',
                input: { patch: '*** Begin Patch\n*** End Patch', _happier: { sessionMode: 'local_control' } },
            },
        ]);
    });

    it('does not emit unknown debug-only tool calls when debug is disabled', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'new_unknown_tool',
                    arguments: '{"foo":"bar"}',
                    call_id: 'call_dbg_1',
                },
            },
            { debug: false },
        );

        expect(actions).toEqual([]);
    });

    it('emits unknown debug-only tool calls when debug is enabled', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'new_unknown_tool',
                    arguments: '{"foo":"bar"}',
                    call_id: 'call_dbg_1',
                },
            },
            { debug: true },
        );

        expect(actions).toEqual([
            {
                type: 'tool-call',
                callId: 'call_dbg_1',
                name: 'new_unknown_tool',
                input: { foo: 'bar', _happier: { sessionMode: 'local_control' } },
            },
        ]);
    });

    it('maps custom_tool_call_output JSON string into parsed tool-result output', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call_output',
                    call_id: 'call_3',
                    output: '{"ok":true}',
                },
            },
            { debug: false },
        );

        expect(actions).toEqual([{ type: 'tool-result', callId: 'call_3', output: { ok: true } }]);
    });

    it('emits debug action for unhandled payload type when debug is enabled', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'unknown_payload_type',
                },
            },
            { debug: true },
        );

        expect(actions).toEqual([
            {
                type: 'debug',
                message: 'unhandled rollout payload type: unknown_payload_type',
                value: { type: 'unknown_payload_type' },
            },
        ]);
    });
});
