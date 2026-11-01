import { describe, expect, it } from 'vitest';
import { mapCodexRolloutEventToActions } from '../rolloutMapper';

describe('mapCodexRolloutEventToActions', () => {
    it('preserves readable reasoning without exposing encrypted payloads, including in debug mode', () => {
        expect(mapCodexRolloutEventToActions({ type: 'response_item', payload: {
            type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the boundary' }, { type: 'summary_text', text: 'Then verify' }],
            encrypted_content: 'opaque-private-reasoning',
        } }, { debug: false })).toEqual([{ type: 'thinking', text: 'Check the boundary\n\nThen verify' }]);
        expect(mapCodexRolloutEventToActions({ type: 'response_item', payload: {
            type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Readable detail' }],
            summary: [{ type: 'summary_text', text: 'Summary fallback' }],
        } }, { debug: false })).toEqual([{ type: 'thinking', text: 'Readable detail' }]);
        expect(mapCodexRolloutEventToActions({ type: 'response_item', payload: {
            type: 'reasoning', summary: [{ type: 'encrypted', text: 'do not render' }],
            encrypted_content: 'opaque-private-reasoning',
        } }, { debug: true })).toEqual([]);
    });

    it('accepts the Codex 0.162.1 rollout reasoning content text variant', () => {
        expect(mapCodexRolloutEventToActions({ type: 'response_item', payload: {
            type: 'reasoning', content: [{ type: 'text', text: 'Provider-exposed detail' }], summary: [],
        } }, { debug: false })).toEqual([{ type: 'thinking', text: 'Provider-exposed detail' }]);
    });

    it('extracts codex session id from session_meta', () => {
        const actions = mapCodexRolloutEventToActions(
            { type: 'session_meta', payload: { id: 'abc' } },
            { debug: false },
        );
        expect(actions).toEqual([{ type: 'codex-session-id', id: 'abc' }]);
    });

    it('maps Codex rollout compaction markers to structured context-compaction actions', () => {
        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'event_msg',
                    timestamp: '2026-01-02T00:00:01.000Z',
                    payload: { type: 'context_compacted', turn_id: 'turn_compact' },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'context-compaction',
                phase: 'completed',
                lifecycleId: 'codex:context-compaction:turn_compact',
                source: 'provider-event',
                providerEventId: 'turn_compact',
            },
        ]);

        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'compacted',
                    timestamp: '2026-01-02T00:00:02.000Z',
                    payload: { message: 'private compaction summary' },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'context-compaction',
                phase: 'completed',
                lifecycleId: 'codex:context-compaction:2026-01-02T00:00:02.000Z',
                source: 'transcript-inference',
            },
        ]);
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

        const debugFiltered = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<subagent_notification>\n{}\n</subagent_notification>' }] },
            },
            { debug: true },
        );
        expect(debugFiltered).toEqual([]);

        const completionFromNotification = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: '<subagent_notification>\n{"agent_id":"thread_child","status":{"completed":"done"}}\n</subagent_notification>' }],
                },
            },
            { debug: false },
        );
        expect(completionFromNotification).toEqual([
            {
                type: 'subagent-complete',
                threadId: 'thread_child',
                status: 'completed',
                summaryText: 'done',
            },
        ]);
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

    it('maps collaboration events into synthetic subagent actions', () => {
        const spawnActions = mapCodexRolloutEventToActions(
            {
                type: 'event_msg',
                payload: {
                    type: 'collab_agent_spawn_end',
                    new_thread_id: 'thread_child',
                    new_agent_nickname: 'Lovelace',
                    new_agent_role: 'explorer',
                    prompt: 'inspect the repo',
                },
            },
            { debug: false },
        );

        expect(spawnActions).toEqual([
            {
                type: 'subagent-spawn',
                threadId: 'thread_child',
                nickname: 'Lovelace',
                role: 'explorer',
                prompt: 'inspect the repo',
            },
        ]);

        const completionActions = mapCodexRolloutEventToActions(
            {
                type: 'event_msg',
                payload: {
                    type: 'collab_waiting_end',
                    agent_statuses: [
                        {
                            thread_id: 'thread_child',
                            status: { completed: 'done' },
                        },
                    ],
                },
            },
            { debug: false },
        );

        expect(completionActions).toEqual([
            {
                type: 'subagent-complete',
                threadId: 'thread_child',
                status: 'completed',
                summaryText: 'done',
            },
        ]);
    });

    it('maps main task lifecycle event messages into turn lifecycle actions', () => {
        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'event_msg',
                    payload: {
                        type: 'task_started',
                        turn_id: 'turn_1',
                    },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'turn-lifecycle',
                event: {
                    type: 'turn_started',
                    providerTurnId: 'turn_1',
                    source: 'codex_rollout_task_started',
                },
            },
        ]);

        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'event_msg',
                    payload: {
                        type: 'task_complete',
                        turn_id: 'turn_1',
                    },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'turn-lifecycle',
                event: {
                    type: 'turn_terminal',
                    providerTurnId: 'turn_1',
                    reason: 'completed',
                    source: 'codex_rollout_task_complete',
                },
            },
        ]);

        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'event_msg',
                    payload: {
                        type: 'turn_complete',
                        turn_id: 'turn_1',
                    },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'turn-lifecycle',
                event: {
                    type: 'turn_terminal',
                    providerTurnId: 'turn_1',
                    reason: 'completed',
                    source: 'codex_rollout_turn_complete',
                },
            },
        ]);
    });

    it('maps any turn_aborted reason into a terminal aborted lifecycle action', () => {
        expect(
            mapCodexRolloutEventToActions(
                {
                    type: 'event_msg',
                    payload: {
                        type: 'turn_aborted',
                        turn_id: 'turn_2',
                        reason: 'replaced',
                    },
                },
                { debug: false },
            ),
        ).toEqual([
            {
                type: 'turn-lifecycle',
                event: {
                    type: 'turn_terminal',
                    providerTurnId: 'turn_2',
                    reason: 'aborted',
                    source: 'codex_rollout_turn_aborted',
                    detail: 'replaced',
                },
            },
        ]);
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

    it('suppresses collaboration plumbing tool calls because synthetic subagent events replace them', () => {
        const actions = mapCodexRolloutEventToActions(
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'spawn_agent',
                    arguments: '{"role":"default"}',
                    call_id: 'call_spawn_1',
                },
            },
            { debug: true },
        );

        expect(actions).toEqual([
            {
                type: 'collaboration-tool-call',
                callId: 'call_spawn_1',
                name: 'spawn_agent',
                prompt: null,
                nickname: null,
                role: 'default',
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
