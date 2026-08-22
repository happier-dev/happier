import { describe, it, expect, vi } from 'vitest';
import { NormalizedMessage } from '../typesRaw';
import { createReducer } from './reducer';
import { reducer } from './reducer';
import { AgentState } from '../domains/state/storageTypes';
import { markSyntheticNoResponseMeta } from '../domains/messages/syntheticNoResponseMessageMeta';
import { messageAttentionImpact } from '../domains/messages/messageUserAttention';
import { SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT } from '@happier-dev/protocol';
import { buildSessionTranscriptAgentAttributionIndex } from '@/components/sessions/transcript/attribution/sessionTranscriptAgentAttribution';
import {
    buildAgentTransitionDividerLocalId,
    createAgentTransitionDividerEventFixture,
} from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';

describe('reducer', () => {
    // it('should process golden cases', () => {
    //     for (let i = 0; i <= 3; i++) {

    //         // Load raw data
    //         const raw = require(`./__testdata__/log_${i}.json`) as any[];
    //         const rawParsed = raw.map((v: any) => RawRecordSchema.parse(v.content));
    //         for (let i = 0; i < rawParsed.length; i++) {
    //             expect(rawParsed[i]).not.toBeNull();
    //         }
    //         expect(rawParsed, `raw_${i}`).toMatchSnapshot();

    //         const normalized = rawParsed.map((v: any, i) => normalizeRawMessage(`${i}`, null, 0, v));
    //         for (let i = 0; i < normalized.length; i++) {
    //             if (rawParsed[i].role === 'agent' && ((rawParsed[i] as any).content.data.type === 'system' || (rawParsed[i] as any).content.data.type === 'result')) {
    //                 continue;
    //             }
    //             expect(normalized[i]).not.toBeNull();
    //         }
    //         expect(normalized, `normalized_${i}`).toMatchSnapshot();

    //         const state = createReducer();
    //         const newMessages = reducer(state, normalized.filter(v => v !== null));
    //         expect(newMessages, `log_${i}`).toMatchSnapshot();
    //     }
    // });

    describe('agent event handling', () => {
        it('carries the reserved localId onto the converted agent-event row so the Agent-transition divider stays readable', () => {
            const state = createReducer();
            const localId = buildAgentTransitionDividerLocalId('local-1');
            const event = createAgentTransitionDividerEventFixture({
                fromAgentId: 'claude',
                toAgentId: 'codex',
            });
            const messages: NormalizedMessage[] = [
                {
                    id: 'divider-1',
                    localId,
                    seq: 50,
                    createdAt: 5_000,
                    role: 'event',
                    content: event as never,
                    isSidechain: false,
                },
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(1);
            const message = result.messages[0];
            expect(message.kind).toBe('agent-event');
            // The divider is only readable at the reserved localId: the sidecar alone is
            // writable by anything that can post an agent event. A converted row that
            // drops it makes both the attention exemption and historical attribution
            // permanently unreachable, no matter what the producer wrote.
            expect(message.kind === 'agent-event' ? message.localId : undefined).toBe(localId);
            expect(messageAttentionImpact(message)).toBe(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
            expect(
                buildSessionTranscriptAgentAttributionIndex(result.messages).boundaries,
            ).toEqual([
                expect.objectContaining({ seq: 50, fromAgentId: 'claude', toAgentId: 'codex' }),
            ]);
        });
    });

    describe('user message handling', () => {
        it('should process user messages with localId', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: 'local123',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'Hello' },
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].kind).toBe('user-text');
            if (result.messages[0].kind === 'user-text') {
                expect(result.messages[0].text).toBe('Hello');
            }
            expect(state.localIds.has('local123')).toBe(true);
        });

        it('applies semantic marked same-server-id user updates while leaving unmarked deliveries inert', () => {
            const state = createReducer();
            const initial: NormalizedMessage = {
                id: 'server-user-row',
                localId: 'voice-realtime:attempt:user:item',
                createdAt: 1_000,
                seq: 7,
                role: 'user',
                content: { type: 'text', text: 'initial transcript' },
                isSidechain: false,
                meta: { displayText: 'initial display text' },
            };

            expect(reducer(state, [initial]).messages).toEqual([
                expect.objectContaining({
                    kind: 'user-text',
                    realID: initial.id,
                    localId: initial.localId,
                    createdAt: initial.createdAt,
                    seq: initial.seq,
                    text: 'initial transcript',
                    displayText: 'initial display text',
                }),
            ]);
            expect(reducer(state, [initial]).messages).toEqual([]);

            const unmarkedDuplicate: NormalizedMessage = {
                ...initial,
                content: { type: 'text', text: 'unmarked duplicate transcript' },
            };
            expect(reducer(state, [unmarkedDuplicate]).messages).toEqual([]);

            const corrected: NormalizedMessage & { isAuthoritativeUpdate: true } = {
                ...initial,
                content: { type: 'text', text: 'corrected transcript' },
                isAuthoritativeUpdate: true,
            };
            expect(reducer(state, [corrected]).messages).toEqual([
                expect.objectContaining({
                    kind: 'user-text',
                    realID: initial.id,
                    localId: initial.localId,
                    createdAt: initial.createdAt,
                    seq: initial.seq,
                    text: 'corrected transcript',
                }),
            ]);
            expect(reducer(state, [corrected]).messages).toEqual([]);

            const displayTextChanged: NormalizedMessage = {
                ...corrected,
                meta: { displayText: 'corrected display text' },
            };
            expect(reducer(state, [displayTextChanged]).messages).toEqual([
                expect.objectContaining({
                    kind: 'user-text',
                    realID: initial.id,
                    text: 'corrected transcript',
                    displayText: 'corrected display text',
                }),
            ]);

            const displayTextRetracted: NormalizedMessage = {
                ...corrected,
                meta: undefined,
            };
            const retracted = reducer(state, [displayTextRetracted]);
            expect(retracted.messages).toEqual([
                expect.objectContaining({
                    kind: 'user-text',
                    realID: initial.id,
                    text: 'corrected transcript',
                }),
            ]);
            expect(retracted.messages[0]).not.toHaveProperty('displayText');
            expect(reducer(state, [displayTextRetracted]).messages).toEqual([]);
        });

        it('replaces a marked same-server-id agent row while leaving an unmarked durable duplicate inert', () => {
            const state = createReducer();
            const initial: NormalizedMessage = {
                id: 'server-agent-row',
                localId: 'voice-realtime:attempt:assistant:item',
                createdAt: 1_000,
                seq: 8,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: 'initial assistant transcript',
                    uuid: 'server-agent-row',
                    parentUUID: null,
                }],
                isSidechain: false,
            };

            expect(reducer(state, [initial]).messages).toEqual([
                expect.objectContaining({
                    kind: 'agent-text',
                    realID: initial.id,
                    localId: initial.localId,
                    createdAt: initial.createdAt,
                    seq: initial.seq,
                    text: 'initial assistant transcript',
                }),
            ]);

            const unmarkedDuplicate: NormalizedMessage = {
                ...initial,
                content: [{
                    type: 'text',
                    text: 'unmarked durable duplicate',
                    uuid: 'server-agent-row',
                    parentUUID: null,
                }],
            };
            expect(reducer(state, [unmarkedDuplicate]).messages).toEqual([]);
            expect([...state.messages.values()].filter((message) => message.realID === initial.id)).toEqual([
                expect.objectContaining({ text: 'initial assistant transcript' }),
            ]);

            const corrected: NormalizedMessage = {
                ...initial,
                isAuthoritativeUpdate: true,
                content: [{
                    type: 'text',
                    text: 'corrected assistant transcript',
                    uuid: 'server-agent-row',
                    parentUUID: null,
                }],
            };
            expect(reducer(state, [corrected]).messages).toEqual([
                expect.objectContaining({
                    kind: 'agent-text',
                    realID: initial.id,
                    localId: initial.localId,
                    createdAt: initial.createdAt,
                    seq: initial.seq,
                    text: 'corrected assistant transcript',
                }),
            ]);
            expect(reducer(state, [corrected]).messages).toEqual([]);
        });

        it('claims a marked agent correction before parser conversion can create a second row', () => {
            const state = createReducer();
            const initial: NormalizedMessage = {
                id: 'server-agent-parser-row',
                localId: 'voice-realtime:attempt:assistant:parser-item',
                createdAt: 1_000,
                seq: 8,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: 'initial assistant transcript',
                    uuid: 'server-agent-parser-row',
                    parentUUID: null,
                }],
                isSidechain: false,
            };
            const initialResult = reducer(state, [initial]);
            expect(initialResult.messages).toHaveLength(1);
            const originalServerIdMapping = state.messageIds.get(initial.id);

            const unmarkedDuplicate: NormalizedMessage = {
                ...initial,
                content: [{
                    type: 'text',
                    text: 'Claude AI usage limit reached|123',
                    uuid: 'server-agent-parser-row',
                    parentUUID: null,
                }],
            };
            expect(reducer(state, [unmarkedDuplicate]).messages).toEqual([]);
            expect([...state.messages.values()].filter((message) => message.realID === initial.id)).toEqual([
                expect.objectContaining({
                    id: initialResult.messages[0]?.id,
                    text: 'initial assistant transcript',
                    event: null,
                }),
            ]);

            const corrected: NormalizedMessage = {
                ...initial,
                isAuthoritativeUpdate: true,
                content: [{
                    type: 'text',
                    text: 'Claude AI usage limit reached|123',
                    uuid: 'server-agent-parser-row',
                    parentUUID: null,
                }],
            };

            const result = reducer(state, [corrected]);
            expect(result.messages).toEqual([
                expect.objectContaining({
                    id: initialResult.messages[0]?.id,
                    realID: initial.id,
                    text: 'Claude AI usage limit reached|123',
                }),
            ]);
            const rowsForServerMessage = [...state.messages.values()].filter((message) => message.realID === initial.id);
            expect(rowsForServerMessage).toEqual([
                expect.objectContaining({
                    id: initialResult.messages[0]?.id,
                    text: 'Claude AI usage limit reached|123',
                    event: null,
                }),
            ]);
            expect(state.messageIds.get(initial.id)).toBe(originalServerIdMapping);
        });

        it('retracts a marked ordinary agent row action reference even when its text is unchanged', () => {
            const state = createReducer();
            const messageActionReference = {
                v: 1,
                sessionId: 'session-1',
                messageId: 'server-agent-reference-row',
                observedRevision: 'revision-1',
            } as const;
            const initial: NormalizedMessage = {
                id: 'server-agent-reference-row',
                localId: null,
                createdAt: 1_000,
                seq: 8,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: 'same durable agent text',
                    uuid: 'server-agent-reference-row',
                    parentUUID: null,
                }],
                isSidechain: false,
                messageActionReference,
            };

            expect(reducer(state, [initial]).messages).toEqual([
                expect.objectContaining({
                    kind: 'agent-text',
                    realID: initial.id,
                    messageActionReference,
                }),
            ]);

            const retracted: NormalizedMessage = {
                ...initial,
                isAuthoritativeUpdate: true,
            };
            delete (retracted as { messageActionReference?: unknown }).messageActionReference;

            const retractionResult = reducer(state, [retracted]);
            expect(retractionResult.messages).toEqual([
                expect.objectContaining({
                    kind: 'agent-text',
                    realID: initial.id,
                    text: 'same durable agent text',
                }),
            ]);
            expect(retractionResult.messages[0]).not.toHaveProperty('messageActionReference');
            expect(reducer(state, [retracted]).messages).toEqual([]);
        });

        it('refreshes a server-issued message action reference even when the durable user content is unchanged', () => {
            const state = createReducer();
            const messageActionReference = {
                v: 1,
                sessionId: 'session-1',
                messageId: 'msg-actionable',
                observedRevision: 'revision-4',
            } as const;

            const first = reducer(state, [{
                id: 'msg-actionable',
                localId: null,
                createdAt: 1_000,
                role: 'user',
                content: { type: 'text', text: 'Actionable text' },
                isSidechain: false,
                messageActionReference,
            }]);

            expect(first.messages).toEqual([expect.objectContaining({
                kind: 'user-text',
                messageActionReference,
            })]);

            const refreshedReference = {
                ...messageActionReference,
                observedRevision: 'revision-5',
            } as const;
            const refreshed = reducer(state, [{
                id: 'msg-actionable',
                localId: null,
                createdAt: 1_000,
                role: 'user',
                content: { type: 'text', text: 'Actionable text' },
                isSidechain: false,
                messageActionReference: refreshedReference,
            }]);

            expect(refreshed.messages).toEqual([expect.objectContaining({
                kind: 'user-text',
                messageActionReference: refreshedReference,
            })]);

            const revoked = reducer(state, [{
                id: 'msg-actionable',
                localId: null,
                createdAt: 1_000,
                role: 'user',
                content: { type: 'text', text: 'Actionable text' },
                isSidechain: false,
            }]);

            expect(revoked.messages).toHaveLength(1);
            expect(revoked.messages[0]?.messageActionReference).toBeUndefined();
        });

        it('should deduplicate user messages by localId', () => {
            const state = createReducer();

            // First message with localId
            const messages1: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: 'local123',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'First' },
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, messages1);
            expect(result1.messages).toHaveLength(1);

            // Second message with same localId should be ignored
            const messages2: NormalizedMessage[] = [
                {
                    id: 'msg2',
                    localId: 'local123',
                    createdAt: 2000,
                    role: 'user',
                    content: { type: 'text', text: 'Second' },
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, messages2);
            expect(result2.messages).toHaveLength(0);
        });

        it('should deduplicate user messages by message id when no localId', () => {
            const state = createReducer();

            // First message without localId
            const messages1: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'First' },
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, messages1);
            expect(result1.messages).toHaveLength(1);

            // Second message with same id should be ignored
            const messages2: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 2000,
                    role: 'user',
                    content: { type: 'text', text: 'Second' },
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, messages2);
            expect(result2.messages).toHaveLength(0);
        });

        it('should process multiple user messages with different localIds', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: 'local123',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'First' },
                    isSidechain: false
                },
                {
                    id: 'msg2',
                    localId: 'local456',
                    createdAt: 2000,
                    role: 'user',
                    content: { type: 'text', text: 'Second' },
                    isSidechain: false
                },
                {
                    id: 'msg3',
                    localId: null,
                    createdAt: 3000,
                    role: 'user',
                    content: { type: 'text', text: 'Third' },
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(3);
            if (result.messages[0].kind === 'user-text') {
                expect(result.messages[0].text).toBe('First');
            }
            if (result.messages[1].kind === 'user-text') {
                expect(result.messages[1].text).toBe('Second');
            }
            if (result.messages[2].kind === 'user-text') {
                expect(result.messages[2].text).toBe('Third');
            }
        });
    });

    describe('tool result meta propagation', () => {
        it('propagates tool-result meta onto the owning tool-call message (shallow merge)', () => {
            const state = createReducer();

            const toolCallMsg: NormalizedMessage = {
                id: 'msg-tool-call',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_1',
                        name: 'SubAgentRun',
                        input: {},
                        description: null,
                        uuid: 'uuid_tool_call',
                        parentUUID: null,
                    } as any,
                ],
                meta: { source: 'ui' } as any,
            };

            reducer(state, [toolCallMsg]);

            const toolResultMsg: NormalizedMessage = {
                id: 'msg-tool-result',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-result',
                        tool_use_id: 'call_1',
                        content: { ok: true },
                        is_error: false,
                        uuid: 'uuid_tool_result',
                        parentUUID: null,
                    } as any,
                ],
                meta: { happier: { kind: 'review_findings.v1', payload: { runRef: { runId: 'run_1' } } } } as any,
            };

            const result = reducer(state, [toolResultMsg]);
            const updatedTool = result.messages.find((m) => m.kind === 'tool-call');
            expect(updatedTool).toBeTruthy();
            if (updatedTool?.kind !== 'tool-call') return;
            expect((updatedTool.meta as any)?.happier?.kind).toBe('review_findings.v1');
        });
    });

    describe('Claude task-list tracking', () => {
        it('tracks TodoWrite tool inputs as session todos', () => {
            const state = createReducer();

            const result = reducer(state, [{
                id: 'msg-todo-write',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'toolu_todo_1',
                    name: 'TodoWrite',
                    input: {
                        todos: [
                            { id: 'todo-1', content: 'Patch parser', status: 'in_progress', priority: 'high' },
                            { id: 'todo-2', content: 'Run tests', status: 'pending', priority: 'medium' },
                        ],
                    },
                    description: null,
                    uuid: 'uuid_todo_1',
                    parentUUID: null,
                }],
            }]);

            expect(result.todos?.map((todo) => [todo.id, todo.content, todo.status])).toEqual([
                ['todo-1', 'Patch parser', 'in_progress'],
                ['todo-2', 'Run tests', 'pending'],
            ]);
        });

        it('does not derive session todos from Claude TaskCreate tool rows in the UI reducer', () => {
            const state = createReducer();

            const result = reducer(state, [{
                id: 'msg-task-create',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'toolu_task_create_ui_owner',
                    name: 'TaskCreate',
                    input: {
                        subject: 'Patch task projection',
                    },
                    description: null,
                    uuid: 'uuid_task_create_ui_owner',
                    parentUUID: null,
                }],
            }]);

            expect(result.todos).toBeUndefined();
        });

    });

    describe('agent text message handling', () => {
        it('should process agent text messages', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'agent1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: 'Hello from Claude!',
                        uuid: 'test-uuid-1',
                        parentUUID: null
                    }]
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].kind).toBe('agent-text');
            if (result.messages[0].kind === 'agent-text') {
                expect(result.messages[0].text).toBe('Hello from Claude!');
            }
        });

        it('preserves a persisted structured presentation as one immutable agent transcript row', () => {
            const state = createReducer();
            const structuredPresentation = {
                v: 1 as const,
                profile: 'pluginTranscriptV1' as const,
                owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                snapshot: {
                    kind: 'status' as const,
                    label: 'Report',
                    value: 'Ready',
                },
            };
            const message: NormalizedMessage = {
                id: 'agent-structured',
                localId: null,
                createdAt: 1_000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: '',
                    uuid: 'agent-structured',
                    parentUUID: null,
                }],
                structuredPresentation,
            };

            const first = reducer(state, [message]);
            expect(first.messages).toEqual([expect.objectContaining({
                kind: 'agent-text',
                text: '',
                structuredPresentation,
            })]);
            expect(reducer(state, [message]).messages).toEqual([]);

            const correctedStructuredPresentation = {
                ...structuredPresentation,
                snapshot: {
                    ...structuredPresentation.snapshot,
                    value: 'Corrected',
                },
            };
            const corrected: NormalizedMessage = {
                ...message,
                structuredPresentation: correctedStructuredPresentation,
                isAuthoritativeUpdate: true,
            };
            expect(reducer(state, [corrected]).messages).toEqual([expect.objectContaining({
                kind: 'agent-text',
                structuredPresentation: correctedStructuredPresentation,
            })]);

            const retracted: NormalizedMessage = {
                ...message,
                isAuthoritativeUpdate: true,
            };
            delete (retracted as { structuredPresentation?: unknown }).structuredPresentation;
            const retractionResult = reducer(state, [retracted]);
            expect(retractionResult.messages).toEqual([expect.objectContaining({
                kind: 'agent-text',
                text: '',
            })]);
            expect(retractionResult.messages[0]).not.toHaveProperty('structuredPresentation');
            expect(reducer(state, [retracted]).messages).toEqual([]);
        });

        it('should process multiple text blocks in one agent message', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'agent1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [
                        {
                            type: 'text',
                            text: 'Part 1',
                            uuid: 'test-uuid-2',
                            parentUUID: null
                        },
                        {
                            type: 'text',
                            text: 'Part 2',
                            uuid: 'test-uuid-2',
                            parentUUID: null
                        }
                    ]
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(2);
            if (result.messages[0].kind === 'agent-text') {
                expect(result.messages[0].text).toBe('Part 1');
            }
            if (result.messages[1].kind === 'agent-text') {
                expect(result.messages[1].text).toBe('Part 2');
            }
        });
    });

    describe('live usage projection', () => {
        it('projects a canonical provider snapshot and prefers it over scalar context telemetry', () => {
            const state = createReducer();
            const contextSnapshot = {
                v: 1 as const,
                modelId: 'gpt-5.4',
                usedTokens: 42_000,
                windowTokens: 400_000,
                totalProcessedTokens: 120_000,
                baselineTokens: 12_000,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn' as const,
            };

            reducer(state, [{
                id: 'usage-provider-snapshot',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 700,
                    output_tokens: 250,
                    context_used_tokens: 1_200,
                    context_window_tokens: 258_400,
                    contextSnapshot,
                },
            }]);

            expect(state.latestUsage).toMatchObject({
                contextSize: 42_000,
                contextWindowTokens: 400_000,
                contextSnapshot,
                contextSnapshotStale: false,
            });
        });

        it('merges context-only usage records without clobbering previous token totals', () => {
            const state = createReducer();
            const liveSnapshot = {
                v: 1 as const,
                modelId: 'claude-fable-5',
                usedTokens: 39_072,
                windowTokens: 1_000_000,
                totalProcessedTokens: null,
                baselineTokens: null,
                isAutoCompactEnabled: true,
                categories: null,
                observedAtMs: 2_000,
                source: 'provider_live' as const,
            };

            // A real turn's usage first…
            reducer(state, [{
                id: 'usage-turn',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 700,
                    output_tokens: 250,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 40,
                },
            }]);

            // …then a context-only snapshot record (live Claude getContextUsage shape).
            reducer(state, [{
                id: 'usage-context-only',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    context_only: true,
                    context_used_tokens: 39_072,
                    context_window_tokens: 1_000_000,
                    contextSnapshot: liveSnapshot,
                },
            }]);

            expect(state.latestUsage).toMatchObject({
                // Token totals PRESERVED from the real turn.
                inputTokens: 700,
                outputTokens: 250,
                cacheCreation: 30,
                cacheRead: 40,
                // Context truth UPDATED from the snapshot.
                contextSize: 39_072,
                contextWindowTokens: 1_000_000,
                contextSnapshot: liveSnapshot,
                contextSnapshotStale: false,
                timestamp: 2000,
            });
        });

        it('synthesizes a canonical derived-estimate snapshot when provider truth is absent', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'usage-derived-snapshot',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 11,
                    output_tokens: 7,
                    cache_creation_input_tokens: 3,
                    cache_read_input_tokens: 2,
                },
            }]);

            expect(state.latestUsage?.contextSnapshot).toEqual({
                v: 1,
                modelId: null,
                usedTokens: 16,
                windowTokens: null,
                totalProcessedTokens: null,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'derived_estimate',
            });
            expect(state.latestUsage?.contextSnapshotStale).toBe(false);
        });

        it('projects usage-only agent records into latestUsage without creating transcript messages', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'usage-1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [],
                    usage: {
                        input_tokens: 11,
                        output_tokens: 7,
                        cache_creation_input_tokens: 3,
                        cache_read_input_tokens: 2,
                    },
                },
            ];

            const result = reducer(state, messages);

            expect(result.messages).toHaveLength(0);
            expect(result.usage).toEqual({
                inputTokens: 11,
                outputTokens: 7,
                cacheCreation: 3,
                cacheRead: 2,
                contextSize: 16,
            });
            expect(state.latestUsage).toEqual({
                inputTokens: 11,
                outputTokens: 7,
                cacheCreation: 3,
                cacheRead: 2,
                contextSize: 16,
                contextSnapshot: {
                    v: 1,
                    modelId: null,
                    usedTokens: 16,
                    windowTokens: null,
                    totalProcessedTokens: null,
                    baselineTokens: null,
                    isAutoCompactEnabled: null,
                    categories: null,
                    observedAtMs: 1000,
                    source: 'derived_estimate',
                },
                contextSnapshotStale: false,
                timestamp: 1000,
            });
        });

        it('retains the provider snapshot with the newest observedAtMs when records reorder', () => {
            const state = createReducer();

            const freshSnapshot = {
                v: 1 as const,
                modelId: 'gpt-5.4',
                usedTokens: 42_000,
                windowTokens: 400_000,
                totalProcessedTokens: 120_000,
                baselineTokens: 12_000,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 2_000,
                source: 'provider_turn' as const,
            };
            const staleSnapshot = {
                ...freshSnapshot,
                usedTokens: 99_999,
                observedAtMs: 1_500,
            };

            // Fresher-by-observedAtMs snapshot arrives first (record ts 1000)...
            reducer(state, [{
                id: 'usage-fresh-snapshot',
                localId: null,
                createdAt: 1_000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: { input_tokens: 700, output_tokens: 250, contextSnapshot: freshSnapshot },
            }]);

            // ...then a transport-reordered staler snapshot lands with a NEWER record ts (1001).
            reducer(state, [{
                id: 'usage-stale-snapshot',
                localId: null,
                createdAt: 1_001,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: { input_tokens: 800, output_tokens: 300, contextSnapshot: staleSnapshot },
            }]);

            // The reducer must keep the snapshot the provider observed most recently.
            expect(state.latestUsage?.contextSnapshot).toEqual(freshSnapshot);
            expect(state.latestUsage?.contextSize).toBe(42_000);
            expect(state.latestUsage?.contextSnapshotStale).toBe(false);
        });

        it('projects explicit context-window usage telemetry into latestUsage', () => {
            const state = createReducer();

            const result = reducer(state, [{
                id: 'usage-context-window',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 700,
                    output_tokens: 250,
                    cache_read_input_tokens: 200,
                    context_used_tokens: 1_200,
                    context_window_tokens: 258_400,
                },
            }]);

            expect(result.messages).toHaveLength(0);
            expect(result.usage).toEqual({
                inputTokens: 700,
                outputTokens: 250,
                cacheCreation: 0,
                cacheRead: 200,
                contextSize: 1_200,
                contextWindowTokens: 258_400,
            });
        });

        it('does not derive active context from context-window-only cumulative telemetry', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'usage-before-result-telemetry',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 1,
                    output_tokens: 4_765,
                    cache_creation_input_tokens: 111,
                    cache_read_input_tokens: 938_731,
                },
            }]);

            const result = reducer(state, [{
                id: 'legacy-result-telemetry',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 4_000_000,
                    output_tokens: 25_000,
                    cache_creation_input_tokens: 769_000,
                    cache_read_input_tokens: 39_231_000,
                    context_window_tokens: 1_000_000,
                },
            }]);

            expect(result.usage).toEqual({
                inputTokens: 4_000_000,
                outputTokens: 25_000,
                cacheCreation: 769_000,
                cacheRead: 39_231_000,
                contextSize: 938_843,
                contextWindowTokens: 1_000_000,
            });
        });

        it('does not let older usage-only records overwrite newer live usage', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'usage-new',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 20,
                    output_tokens: 5,
                },
            }]);

            const result = reducer(state, [{
                id: 'usage-old',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [],
                usage: {
                    input_tokens: 2,
                    output_tokens: 1,
                },
            }]);

            expect(result.messages).toHaveLength(0);
            expect(result.usage).toEqual({
                inputTokens: 20,
                outputTokens: 5,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 20,
            });
        });
    });

    describe('thinking timeline', () => {
        it('does not merge thinking across a tool-call boundary (separate messages)', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'think-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'thinking',
                    thinking: 'first',
                    uuid: 'think-uuid-1',
                    parentUUID: null,
                }],
            }]);

            reducer(state, [{
                id: 'tool-1-msg',
                localId: null,
                createdAt: 1100,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'CodeSearch',
                    input: { query: 'foo' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null,
                }],
            }]);

            reducer(state, [{
                id: 'think-2',
                localId: null,
                createdAt: 1200,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'thinking',
                    thinking: 'second',
                    uuid: 'think-uuid-2',
                    parentUUID: null,
                }],
            }]);

            const thinkingMessages = [...state.messages.values()].filter((m) => m.role === 'agent' && m.isThinking);
            expect(thinkingMessages).toHaveLength(2);
            expect(thinkingMessages.some((m) => typeof m.text === 'string' && m.text.includes('first'))).toBe(true);
            expect(thinkingMessages.some((m) => typeof m.text === 'string' && m.text.includes('second'))).toBe(true);
        });

        it('preserves tool/thinking interleaving inside a single agent message', () => {
            const state = createReducer();

            const result = reducer(state, [{
                id: 'agent-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'thinking',
                        thinking: 'before tool',
                        uuid: 'agent-uuid-1',
                        parentUUID: null,
                    },
                    {
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'CodeSearch',
                        input: { query: 'foo' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null,
                    },
                    {
                        type: 'thinking',
                        thinking: 'after tool',
                        uuid: 'agent-uuid-1',
                        parentUUID: null,
                    },
                ],
            }]);

            expect(result.messages).toHaveLength(3);
            expect(result.messages[0]?.kind).toBe('agent-text');
            expect(result.messages[1]?.kind).toBe('tool-call');
            expect(result.messages[2]?.kind).toBe('agent-text');

            const thinkingMessages = result.messages.filter((m) => m.kind === 'agent-text' && m.isThinking);
            expect(thinkingMessages).toHaveLength(2);
        });
    });

    describe('tool lifecycle cancellation', () => {
        it('keeps running tools active on turn_aborted when there is no tool error proof', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'tool-call-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'CodeSearch',
                    input: { query: 'foo' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null,
                }],
            }]);

            reducer(state, [{
                id: 'event-abort-1',
                localId: null,
                createdAt: 2000,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-lifecycle',
                    event: 'turn_aborted',
                    id: 'tool-1',
                },
            }]);

            const toolMessageId = state.toolIdToMessageId.get('tool-1');
            const toolMessage = toolMessageId ? state.messages.get(toolMessageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
        });

        it('keeps running tools active on ready events because readiness is not tool error proof', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'tool-call-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'CodeSearch',
                    input: { query: 'foo' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null,
                }],
            }]);

            const readyResult = reducer(state, [
                {
                    id: 'ready-1',
                    seq: 7,
                    localId: null,
                    createdAt: 1500,
                    role: 'event',
                    isSidechain: false,
                    content: { type: 'ready' },
                },
                {
                    id: 'ready-2',
                    seq: 11,
                    localId: null,
                    createdAt: 1700,
                    role: 'event',
                    isSidechain: false,
                    content: { type: 'ready' },
                },
            ]);

            const toolMessageId = state.toolIdToMessageId.get('tool-1');
            const toolMessage = toolMessageId ? state.messages.get(toolMessageId) : null;
            expect(readyResult.hasReadyEvent).toBe(true);
            expect(readyResult.latestReadyEventSeq).toBe(11);
            expect(readyResult.latestReadyEventAt).toBe(1700);
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
        });

        it('applies late tool results after ready events because ready is not tool error proof', () => {
            const state = createReducer();

            reducer(state, [{
                id: 'tool-call-late-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-late-1',
                    name: 'CodeSearch',
                    input: { query: 'foo' },
                    description: null,
                    uuid: 'tool-uuid-late-1',
                    parentUUID: null,
                }],
            }]);

            reducer(state, [{
                id: 'ready-late-1',
                localId: null,
                createdAt: 1500,
                role: 'event',
                isSidechain: false,
                content: { type: 'ready' },
            }]);

            reducer(state, [{
                id: 'tool-result-late-1',
                localId: null,
                createdAt: 1800,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-late-1',
                    content: { ok: true },
                    is_error: false,
                    uuid: 'tool-result-uuid-late-1',
                    parentUUID: null,
                }],
            }]);

            const toolMessageId = state.toolIdToMessageId.get('tool-late-1');
            const toolMessage = toolMessageId ? state.messages.get(toolMessageId) : null;
            expect(toolMessage?.tool?.state).toBe('completed');
            expect(toolMessage?.tool?.completedAt).toBe(1800);
            expect(toolMessage?.tool?.result).toEqual({ ok: true });
        });

        it('does not cancel pending permission gates on ready events', () => {
            const state = createReducer();

            reducer(state, [], {
                requests: {
                    'tool-permission-1': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'find . -type f | head' },
                        createdAt: 1000,
                    },
                },
                completedRequests: null,
            });

            reducer(state, [{
                id: 'ready-after-permission',
                localId: null,
                createdAt: 1500,
                role: 'event',
                isSidechain: false,
                content: { type: 'ready' },
            }]);

            const toolMessageId = state.toolIdToMessageId.get('tool-permission-1');
            const toolMessage = toolMessageId ? state.messages.get(toolMessageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.startedAt).toBeNull();
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
            expect(toolMessage?.tool?.permission?.status).toBe('pending');
        });
    });

    describe('mixed message processing', () => {
        it('should handle interleaved user and agent messages', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'user1',
                    localId: 'local1',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'Question 1' },
                    isSidechain: false
                },
                {
                    id: 'agent1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    content: [{
                        type: 'text',
                        text: 'Answer 1',
                        uuid: 'test-uuid-3',
                        parentUUID: null
                    }],
                    isSidechain: false
                },
                {
                    id: 'user2',
                    localId: 'local2',
                    createdAt: 3000,
                    role: 'user',
                    content: { type: 'text', text: 'Question 2' },
                    isSidechain: false
                },
                {
                    id: 'agent2',
                    localId: null,
                    createdAt: 4000,
                    role: 'agent',
                    content: [{
                        type: 'text',
                        text: 'Answer 2',
                        uuid: 'test-uuid-4',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(4);
            expect(result.messages[0].kind).toBe('user-text');
            if (result.messages[0].kind === 'user-text') {
                expect(result.messages[0].text).toBe('Question 1');
            }
            expect(result.messages[1].kind).toBe('agent-text');
            if (result.messages[1].kind === 'agent-text') {
                expect(result.messages[1].text).toBe('Answer 1');
            }
            expect(result.messages[2].kind).toBe('user-text');
            if (result.messages[2].kind === 'user-text') {
                expect(result.messages[2].text).toBe('Question 2');
            }
            expect(result.messages[3].kind).toBe('agent-text');
            if (result.messages[3].kind === 'agent-text') {
                expect(result.messages[3].text).toBe('Answer 2');
            }
        });
    });

    describe('edge cases', () => {
        it('should handle empty message array', () => {
            const state = createReducer();
            const result = reducer(state, []);
            expect(result.messages).toHaveLength(0);
        });

        it('should not duplicate agent messages when applied multiple times', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'agent1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    content: [{
                        type: 'text',
                        text: 'Hello world!',
                        uuid: 'test-uuid-5',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            // Apply the same messages multiple times
            const result1 = reducer(state, messages);
            expect(result1.messages).toHaveLength(1);

            const result2 = reducer(state, messages);
            expect(result2.messages).toHaveLength(0); // Should not add duplicates

            const result3 = reducer(state, messages);
            expect(result3.messages).toHaveLength(0); // Still no duplicates
        });

        it('should filter out null normalized messages', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'user1',
                    localId: 'local1',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'Valid' },
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(1);
            if (result.messages[0].kind === 'user-text') {
                expect(result.messages[0].text).toBe('Valid');
            }
        });

        it('should handle summary messages', () => {
            const state = createReducer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'agent1',
                    localId: null,
                    createdAt: 1000,
                    role: 'event',
                    content: {
                        type: 'message',
                        message: 'This is a summary'
                    },
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages);
            // Summary messages should be processed but may not appear in output
            expect(result).toBeDefined();
        });
    });

    describe('AgentState permissions', () => {
        it('should treat permission-request tool-call inputs as pending permissions (no AgentState required)', () => {
            const state = createReducer();

            const messages: NormalizedMessage[] = [
                {
                    id: 'perm-msg-1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'write_file-123',
                        name: 'write',
                        input: {
                            permissionId: 'write_file-123',
                            toolCall: {
                                toolCallId: 'write_file-123',
                                status: 'pending',
                                title: 'Writing to .tmp/example.txt',
                                content: [{ path: 'example.txt', type: 'diff', oldText: '', newText: 'hello' }],
                                locations: [{ path: '/Users/example/.tmp/example.txt' }],
                            },
                        },
                        description: 'write',
                        uuid: 'perm-msg-1',
                        parentUUID: null,
                    }],
                },
            ];

            const result = reducer(state, messages);
            expect(result.messages).toHaveLength(1);

            const msg = result.messages[0];
            expect(msg.kind).toBe('tool-call');
            if (msg.kind !== 'tool-call') return;

            expect(msg.tool.permission).toEqual({ id: 'write_file-123', status: 'pending' });
            expect(msg.tool.startedAt).toBeNull();
        });

        it('should create tool messages for pending permission requests', () => {
            const state = createReducer();
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            const result = reducer(state, [], agentState);

            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].kind).toBe('tool-call');
            if (result.messages[0].kind === 'tool-call') {
                expect(result.messages[0].tool.name).toBe('Bash');
                expect(result.messages[0].tool.state).toBe('running');
                expect(result.messages[0].tool.permission).toEqual({
                    id: 'tool-1',
                    status: 'pending'
                });
            }
        });

        it('should update permission status for completed requests', () => {
            const state = createReducer();

            // First create a pending permission
            const agentState1: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            const result1 = reducer(state, [], agentState1);
            expect(result1.messages).toHaveLength(1);

            // Then mark it as completed
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'User denied permission'
                    }
                }
            };

            const result2 = reducer(state, [], agentState2);
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.state).toBe('error');
                expect(result2.messages[0].tool.permission?.status).toBe('denied');
                expect(result2.messages[0].tool.permission?.reason).toBe('User denied permission');
            }
        });

        it('should match incoming tool calls to approved permission messages', () => {
            const state = createReducer();

            // First create an approved permission
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            const result1 = reducer(state, [], agentState);
            expect(result1.messages).toHaveLength(1);

            // Then receive the actual tool call from the agent
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls -la' },
                        description: null,
                        uuid: 'msg-1-uuid',
                        parentUUID: null
                    }]
                }
            ];

            const result2 = reducer(state, messages, agentState);

            // The tool call should be matched to the existing permission message
            // So we should get an update to the existing message, not a new one
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.permission?.status).toBe('approved');
                expect(result2.messages[0].tool.state).toBe('running');
                expect(result2.messages[0].tool.name).toBe('Bash');
            }
        });

        it('should match tool calls by ID regardless of arguments', () => {
            const state = createReducer();

            // Create multiple pending permission requests
            const agentState1: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    },
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 2000
                    }
                }
            };

            const result1 = reducer(state, [], agentState1);
            expect(result1.messages).toHaveLength(2);

            // Approve both permissions
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 3000,
                        status: 'approved'
                    },
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 2000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };

            reducer(state, [], agentState2);

            // Now receive a tool call from the agent
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 4000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'pwd' },
                        description: null,
                        uuid: 'msg-2-uuid',
                        parentUUID: null
                    }]
                }
            ];

            // Pass agentState2 - it's always provided as current state
            const result3 = reducer(state, messages, agentState2);

            // Should return the updated permission message (ID match)
            expect(result3.messages).toHaveLength(1);
            expect(result3.messages[0].kind).toBe('tool-call');
            if (result3.messages[0].kind === 'tool-call') {
                // With ID matching, keeps original permission arguments
                expect(result3.messages[0].tool.input).toEqual({ command: 'ls -la' });
            }

            // Verify that tool-1 is in the map
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            // Should have both tool IDs in the map
            expect(state.toolIdToMessageId.size).toBe(2);
        });

        it('should not create new message when tool can be matched to existing permission (priority to newest)', () => {
            const state = createReducer();

            // Create multiple approved permissions with same tool but different times
            const agentState: AgentState = {
                completedRequests: {
                    'tool-old': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    },
                    'tool-new': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 3000,
                        completedAt: 4000,
                        status: 'approved'
                    }
                }
            };

            const result1 = reducer(state, [], agentState);
            expect(result1.messages).toHaveLength(2);

            // Store the message IDs
            const oldMessageId = state.toolIdToMessageId.get('tool-old');
            const newMessageId = state.toolIdToMessageId.get('tool-new');

            // Now receive a tool call that matches both
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 5000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls' },
                        description: null,
                        uuid: 'msg-3-uuid',
                        parentUUID: null
                    }]
                }
            ];

            // Pass agentState - it's always provided as current state
            const result2 = reducer(state, messages, agentState);

            // Should only return the updated message that matched
            expect(result2.messages).toHaveLength(1);
            expect(result2.messages[0].kind).toBe('tool-call');
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.input).toEqual({ command: 'ls' });
            }

            // With new design, tool-1 creates a new message since it doesn't match tool-old or tool-new
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-old')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-new')).toBe(true);

            // Verify that old messages were not updated (tool-1 is different ID)
            const newMessage = state.messages.get(newMessageId!);
            expect(newMessage?.tool?.startedAt).toBeNull();

            const oldMessage = state.messages.get(oldMessageId!);
            expect(oldMessage?.tool?.startedAt).toBeNull();
        });

        it('should not create duplicate messages when called twice with same AgentState', () => {
            const state = createReducer();

            // AgentState with both pending and completed permissions
            const agentState: AgentState = {
                requests: {
                    'tool-pending': {
                        tool: 'Read',
                        arguments: { file: 'test.txt' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-completed': {
                        tool: 'Write',
                        arguments: { file: 'output.txt', content: 'hello' },
                        createdAt: 2000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };

            // First call - should create messages
            const result1 = reducer(state, [], agentState);
            expect(result1.messages).toHaveLength(2);

            // Verify the messages were created
            expect(state.toolIdToMessageId.has('tool-pending')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-completed')).toBe(true);

            // Second call with same AgentState - should not create duplicates
            const sizeBefore = state.messages.size;
            const idsBefore = new Set(Array.from(state.messages.keys()));
            const result2 = reducer(state, [], agentState);
            // Reducer may return updated existing messages, but must not add duplicates.
            expect(state.messages.size).toBe(sizeBefore);
            for (const msg of result2.messages) {
                expect(idsBefore.has(msg.id)).toBe(true);
            }

            // Verify the mappings still exist and haven't changed
            expect(state.toolIdToMessageId.size).toBe(2);

            // Third call with a message and same AgentState - still no duplicates
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 4000,
                    role: 'user',
                    content: { type: 'text', text: 'Hello' },
                    isSidechain: false
                }
            ];

            const result3 = reducer(state, messages, agentState);
            expect(result3.messages).toHaveLength(1); // Only the user message
            expect(result3.messages[0].kind).toBe('user-text');

            // Verify permission messages weren't duplicated
            expect(state.toolIdToMessageId.size).toBe(2);
        });

        it('should prioritize tool call over permission request when both provided simultaneously', () => {
            const state = createReducer();

            // AgentState with approved permission
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            // Tool call message with different timestamp
            const messages: NormalizedMessage[] = [
                {
                    id: 'tool-msg-1',
                    localId: null,
                    createdAt: 5000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            // Process both simultaneously
            const result = reducer(state, messages, agentState);

            // Should create only one message (the tool call takes priority)
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].kind).toBe('tool-call');
            if (result.messages[0].kind === 'tool-call') {
                // Should use tool call's timestamp, not permission's
                expect(result.messages[0].createdAt).toBe(5000);
                expect(result.messages[0].id).toBeDefined();

                // Should have permission info from AgentState (it was skipped in Phase 0 but attached in Phase 2)
                expect(result.messages[0].tool.permission).toBeDefined();
                expect(result.messages[0].tool.permission?.id).toBe('tool-1');
                expect(result.messages[0].tool.permission?.status).toBe('approved');
            }

            // Verify only the tool message was created, not a separate permission message
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            // Tool ID maps to message ID
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            expect(toolMsgId).toBeDefined();
        });

        it('should preserve original timestamps when request received first, then tool call', () => {
            const state = createReducer();
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
            try {

                // First: Process permission request
                const agentState1: AgentState = {
                    requests: {
                        'tool-1': {
                            tool: 'Bash',
                            arguments: { command: 'ls' },
                            createdAt: 1000
                        }
                    }
                };

                const result1 = reducer(state, [], agentState1);
                expect(result1.messages).toHaveLength(1);

                const permMessageId = state.toolIdToMessageId.get('tool-1');
                const originalMessage = state.messages.get(permMessageId!);
                expect(originalMessage?.createdAt).toBe(1000);
                expect(originalMessage?.realID).toBeNull();

                // Then: Approve the permission
                const agentState2: AgentState = {
                    completedRequests: {
                        'tool-1': {
                            tool: 'Bash',
                            arguments: { command: 'ls' },
                            createdAt: 1000,
                            completedAt: 2000,
                            status: 'approved'
                        }
                    }
                };

                const result2 = reducer(state, [], agentState2);
                expect(result2.messages).toHaveLength(1); // Same message, updated

                // Finally: Receive the actual tool call
                const messages: NormalizedMessage[] = [
                    {
                        id: 'tool-msg-1',
                        localId: null,
                        createdAt: 5000,
                        role: 'agent',
                        content: [{
                            type: 'tool-call',
                            id: 'tool-1',
                            name: 'Bash',
                            input: { command: 'ls' },
                            description: null,
                            uuid: 'tool-uuid-1',
                            parentUUID: null
                        }],
                        isSidechain: false
                    }
                ];

                const result3 = reducer(state, messages, agentState2);
                expect(result3.messages).toHaveLength(1); // Same message, updated

                // Check the final state of the message
                const finalMessage = state.messages.get(permMessageId!);

                // Original timestamp should be preserved
                expect(finalMessage?.createdAt).toBe(1000);

                // But realID should be updated to the tool message's ID
                expect(finalMessage?.realID).toBe('tool-msg-1');
                expect(result3.messages[0]?.kind).toBe('tool-call');
                expect(result3.messages[0] && 'realID' in result3.messages[0] ? result3.messages[0].realID : null).toBe('tool-msg-1');

                // Tool should be updated with execution details
                expect(finalMessage?.tool?.startedAt).toBe(5000);
                expect(finalMessage?.tool?.permission?.status).toBe('approved');

                // Verify the tool is properly linked
                expect(state.toolIdToMessageId.get('tool-1')).toBe(permMessageId);
            } finally {
                randomSpy.mockRestore();
            }
        });

        it('should create separate messages for same tool name with different arguments', () => {
            const state = createReducer();

            // AgentState with two approved permissions for same tool but different arguments
            const agentState: AgentState = {
                completedRequests: {
                    'tool-ls': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    },
                    'tool-pwd': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1500,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            // Process permissions
            const result1 = reducer(state, [], agentState);
            expect(result1.messages).toHaveLength(2);

            // Both should be separate messages
            const lsMessageId = state.toolIdToMessageId.get('tool-ls');
            const pwdMessageId = state.toolIdToMessageId.get('tool-pwd');
            expect(lsMessageId).toBeDefined();
            expect(pwdMessageId).toBeDefined();
            expect(lsMessageId).not.toBe(pwdMessageId);

            // Verify the messages have correct arguments
            const lsMessage = state.messages.get(lsMessageId!);
            const pwdMessage = state.messages.get(pwdMessageId!);
            expect(lsMessage?.tool?.input).toEqual({ command: 'ls -la' });
            expect(pwdMessage?.tool?.input).toEqual({ command: 'pwd' });

            // Now receive the first tool call (pwd)
            const messages1: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-pwd',
                        name: 'Bash',
                        input: { command: 'pwd' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, messages1, agentState);
            expect(result2.messages).toHaveLength(1);

            // Should match to the pwd permission (newer one, matching arguments)
            expect(state.toolIdToMessageId.get('tool-pwd')).toBe(pwdMessageId);
            // ls permission should have its own message
            expect(state.toolIdToMessageId.has('tool-ls')).toBe(true);

            // Now receive the second tool call (ls)
            const messages2: NormalizedMessage[] = [
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 4000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-ls',
                        name: 'Bash',
                        input: { command: 'ls -la' },
                        description: null,
                        uuid: 'tool-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result3 = reducer(state, messages2, agentState);
            expect(result3.messages).toHaveLength(1);

            // Should match to the ls permission
            expect(state.toolIdToMessageId.get('tool-ls')).toBe(lsMessageId);

            // Both tools should be in the map
            expect(state.toolIdToMessageId.size).toBe(2);

            // Verify final states
            const finalLsMessage = state.messages.get(lsMessageId!);
            const finalPwdMessage = state.messages.get(pwdMessageId!);
            expect(finalLsMessage?.tool?.startedAt).toBe(4000);
            expect(finalPwdMessage?.tool?.startedAt).toBe(3000);
        });

        it('should update an existing permission placeholder to the real tool name when the tool call arrives later', () => {
            const state = createReducer();

            const agentState1: AgentState = {
                requests: {
                    'call-1': {
                        tool: 'external_directory',
                        arguments: {
                            permissionId: 'call-1',
                            providerPermissionId: 'perm-1',
                            toolCallId: 'call-1',
                            toolName: 'external_directory',
                            filePath: '/tmp/outside.txt',
                            toolCall: {
                                toolCallId: 'call-1',
                                status: 'pending',
                                rawInput: {
                                    filePath: '/tmp/outside.txt',
                                },
                            },
                            permission: {
                                id: 'perm-1',
                                kind: 'external_directory',
                            },
                        },
                        createdAt: 1000,
                    },
                },
            };

            reducer(state, [], agentState1);

            const permissionMessageId = state.toolIdToMessageId.get('call-1');
            expect(permissionMessageId).toBeDefined();
            expect(state.messages.get(permissionMessageId!)?.tool?.name).toBe('external_directory');

            const messages: NormalizedMessage[] = [
                {
                    id: 'tool-msg-1',
                    localId: null,
                    createdAt: 5000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'call-1',
                        name: 'Read',
                        input: { filePath: '/tmp/outside.txt' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            reducer(state, messages, agentState1);

            expect(state.messages.get(permissionMessageId!)?.tool?.name).toBe('Read');
        });

        it('should update permission message when tool call has matching ID', () => {
            const state = createReducer();

            // AgentState with a pending permission request
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            // Tool call with matching ID (arguments don't matter with ID matching)
            const messages: NormalizedMessage[] = [
                {
                    id: 'tool-msg-1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'pwd' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            // Process both simultaneously
            const result = reducer(state, messages, agentState);

            // Should update the existing permission message
            expect(result.messages).toHaveLength(1);

            // Verify the message was updated with tool execution details
            if (result.messages[0].kind === 'tool-call') {
                // Should keep original permission data
                expect(result.messages[0].tool.permission?.id).toBe('tool-1');
                expect(result.messages[0].tool.permission?.status).toBe('pending');
                // Should keep original arguments from permission
                expect(result.messages[0].tool.input).toEqual({ command: 'ls -la' });
                // Should keep original timestamp
                expect(result.messages[0].createdAt).toBe(1000);
            }

            // Verify internal state - should be the same message
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);

            // They should be the same message now
            const permMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            expect(permMsgId).toBe(toolMsgId);

            // Now approve the permission and send its tool call
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };

            const messages2: NormalizedMessage[] = [
                {
                    id: 'tool-msg-2',
                    localId: null,
                    createdAt: 4000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',  // Must match permission ID
                        name: 'Bash',
                        input: { command: 'ls -la' },
                        description: null,
                        uuid: 'tool-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, messages2, agentState2);

            // Should update the permission message
            expect(result2.messages).toHaveLength(1);
            expect(result2.messages[0].kind).toBe('tool-call');
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.input).toEqual({ command: 'ls -la' });
                expect(result2.messages[0].tool.permission?.status).toBe('approved');
            }

            // Verify it matched to the correct permission (same ID now)
            // Should resolve to the permission message since it was created first
            expect(state.toolIdToMessageId.get('tool-1')).toBe(permMsgId);
        });

        it('should handle full permission lifecycle: pending -> approved -> tool execution -> completion', () => {
            const state = createReducer();

            // Step 1: Create pending permission
            const agentState1: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Read',
                        arguments: { file: '/test.txt' },
                        createdAt: 1000
                    }
                }
            };

            const result1 = reducer(state, [], agentState1);
            expect(result1.messages).toHaveLength(1);
            expect(result1.messages[0].kind).toBe('tool-call');
            if (result1.messages[0].kind === 'tool-call') {
                expect(result1.messages[0].tool.state).toBe('running');
                expect(result1.messages[0].tool.permission?.status).toBe('pending');
            }

            // Step 2: Approve permission
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Read',
                        arguments: { file: '/test.txt' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            const result2 = reducer(state, [], agentState2);
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.permission?.status).toBe('approved');
                expect(result2.messages[0].tool.state).toBe('completed');
                expect(result2.messages[0].tool.startedAt).toBeNull();
                expect(result2.messages[0].tool.completedAt).toBe(2000);
            }

            // Step 3: Tool call arrives
            const toolMessages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Read',
                        input: { file: '/test.txt' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result3 = reducer(state, toolMessages, agentState2);
            expect(result3.messages).toHaveLength(1);
            if (result3.messages[0].kind === 'tool-call') {
                expect(result3.messages[0].tool.startedAt).toBe(3000);
            }

            // Step 4: Tool result arrives
            const resultMessages: NormalizedMessage[] = [
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 4000,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'File contents',
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result4 = reducer(state, resultMessages, agentState2);
            expect(result4.messages).toHaveLength(1);
            if (result4.messages[0].kind === 'tool-call') {
                expect(result4.messages[0].tool.state).toBe('completed');
                expect(result4.messages[0].tool.result).toBe('File contents');
                expect(result4.messages[0].tool.completedAt).toBe(4000);
            }
        });

        it('should handle denied and canceled permissions correctly', () => {
            const state = createReducer();

            // Create two permissions
            const agentState1: AgentState = {
                requests: {
                    'tool-deny': {
                        tool: 'Write',
                        arguments: { file: '/secure.txt', content: 'hack' },
                        createdAt: 1000
                    },
                    'tool-cancel': {
                        tool: 'Delete',
                        arguments: { file: '/important.txt' },
                        createdAt: 1500
                    }
                }
            };

            const result1 = reducer(state, [], agentState1);
            expect(result1.messages).toHaveLength(2);

            // Deny first, cancel second
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-deny': {
                        tool: 'Write',
                        arguments: { file: '/secure.txt', content: 'hack' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'Unauthorized access'
                    },
                    'tool-cancel': {
                        tool: 'Delete',
                        arguments: { file: '/important.txt' },
                        createdAt: 1500,
                        completedAt: 2500,
                        status: 'canceled',
                        reason: 'User canceled'
                    }
                }
            };

            const result2 = reducer(state, [], agentState2);
            expect(result2.messages).toHaveLength(2);

            const deniedMsg = result2.messages.find(m =>
                m.kind === 'tool-call' && m.tool.name === 'Write'
            );
            const canceledMsg = result2.messages.find(m =>
                m.kind === 'tool-call' && m.tool.name === 'Delete'
            );

            if (deniedMsg?.kind === 'tool-call') {
                expect(deniedMsg.tool.state).toBe('error');
                expect(deniedMsg.tool.permission?.status).toBe('denied');
                expect(deniedMsg.tool.permission?.reason).toBe('Unauthorized access');
                expect(deniedMsg.tool.result).toEqual({ error: 'Unauthorized access' });
            }

            if (canceledMsg?.kind === 'tool-call') {
                expect(canceledMsg.tool.state).toBe('error');
                expect(canceledMsg.tool.permission?.status).toBe('canceled');
                expect(canceledMsg.tool.permission?.reason).toBe('User canceled');
                expect(canceledMsg.tool.result).toEqual({ error: 'User canceled' });
            }
        });

        it('keeps orphaned running approved tools active when the agent emits "No response requested."', () => {
            const state = createReducer();

            const pendingState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                    },
                },
            };
            reducer(state, [], pendingState);

            const approvedState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved',
                    },
                },
            };
            reducer(state, [], approvedState);

            const toolCall: NormalizedMessage = {
                id: 'tool-msg-1',
                localId: null,
                createdAt: 1600,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'sleep 90' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null,
                }],
            };
            reducer(state, [toolCall], approvedState);

            const syntheticNoResponse: NormalizedMessage = {
                id: 'assistant-no-response',
                localId: null,
                createdAt: 1700,
                role: 'agent',
                isSidechain: false,
                meta: markSyntheticNoResponseMeta(),
                content: [{
                    type: 'text',
                    text: 'No response requested.',
                    uuid: 'text-uuid-no-response-1',
                    parentUUID: null,
                }],
            };
            reducer(state, [syntheticNoResponse], approvedState);

            const messageId = state.toolIdToMessageId.get('tool-1');
            const toolMessage = messageId ? state.messages.get(messageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.permission?.status).toBe('approved');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
            expect(
                Array.from(state.messages.values()).some((message) =>
                    message.role === 'agent'
                    && message.text === 'No response requested.'
                    && !message.tool
                    && !message.event
                )
            ).toBe(false);
        });

        it('renders ordinary agent text that happens to match the synthetic no-response copy', () => {
            const state = createReducer();
            const ordinaryNoResponseText: NormalizedMessage = {
                id: 'ordinary-no-response',
                localId: null,
                createdAt: 1700,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'No response requested.',
                    uuid: 'text-uuid-ordinary-no-response',
                    parentUUID: null,
                }],
            };

            reducer(state, [ordinaryNoResponseText]);

            expect(
                Array.from(state.messages.values()).some((message) =>
                    message.role === 'agent'
                    && message.text === 'No response requested.'
                    && !message.tool
                    && !message.event
                )
            ).toBe(true);
        });

        it('keeps orphaned running approved tools active when partial output already streamed', () => {
            const state = createReducer();

            const pendingState: AgentState = {
                requests: {
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                    },
                },
            };
            reducer(state, [], pendingState);

            const approvedState: AgentState = {
                completedRequests: {
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved',
                    },
                },
            };
            reducer(state, [], approvedState);

            const toolCall: NormalizedMessage = {
                id: 'tool-msg-2',
                localId: null,
                createdAt: 1600,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-2',
                    name: 'Bash',
                    input: { command: 'sleep 90' },
                    description: null,
                    uuid: 'tool-uuid-2',
                    parentUUID: null,
                }],
            };
            reducer(state, [toolCall], approvedState);

            const streamChunk: NormalizedMessage = {
                id: 'tool-stream-2',
                localId: null,
                createdAt: 1650,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-2',
                    content: { _stream: true, stdoutChunk: 'partial\\n' },
                    is_error: false,
                    uuid: 'stream-uuid-2',
                    parentUUID: null,
                }],
            };
            reducer(state, [streamChunk], approvedState);

            const syntheticNoResponse: NormalizedMessage = {
                id: 'assistant-no-response-2',
                localId: null,
                createdAt: 1700,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'No response requested.',
                    uuid: 'text-uuid-no-response-2',
                    parentUUID: null,
                }],
            };
            reducer(state, [syntheticNoResponse], approvedState);

            const messageId = state.toolIdToMessageId.get('tool-2');
            const toolMessage = messageId ? state.messages.get(messageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.permission?.status).toBe('approved');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toEqual({ stdout: 'partial\\n' });
        });

        it('keeps orphaned running approved tools active when a task lifecycle abort event arrives', () => {
            const state = createReducer();

            const approvedState: AgentState = {
                completedRequests: {
                    'tool-lifecycle-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved',
                    },
                },
            };
            reducer(state, [], approvedState);

            const toolCall: NormalizedMessage = {
                id: 'tool-msg-lifecycle-1',
                localId: null,
                createdAt: 1600,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-lifecycle-1',
                    name: 'Bash',
                    input: { command: 'sleep 90' },
                    description: null,
                    uuid: 'tool-lifecycle-uuid-1',
                    parentUUID: null,
                }],
            };
            reducer(state, [toolCall], approvedState);

            const lifecycleAbortEvent: NormalizedMessage = {
                id: 'event-lifecycle-abort-1',
                localId: null,
                createdAt: 1700,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-lifecycle',
                    event: 'turn_aborted',
                    id: 'tool-lifecycle-1',
                },
            };
            const result = reducer(state, [lifecycleAbortEvent], approvedState);

            expect(result.messages).toHaveLength(0);

            const messageId = state.toolIdToMessageId.get('tool-lifecycle-1');
            const toolMessage = messageId ? state.messages.get(messageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.permission?.status).toBe('approved');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
        });

        it('keeps orphaned running approved tools active when a task lifecycle complete event arrives', () => {
            const state = createReducer();

            const approvedState: AgentState = {
                completedRequests: {
                    'tool-lifecycle-2': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 90' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved',
                    },
                },
            };
            reducer(state, [], approvedState);

            const toolCall: NormalizedMessage = {
                id: 'tool-msg-lifecycle-2',
                localId: null,
                createdAt: 1600,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-lifecycle-2',
                    name: 'Bash',
                    input: { command: 'sleep 90' },
                    description: null,
                    uuid: 'tool-lifecycle-uuid-2',
                    parentUUID: null,
                }],
            };
            reducer(state, [toolCall], approvedState);

            const lifecycleCompleteEvent: NormalizedMessage = {
                id: 'event-lifecycle-complete-2',
                localId: null,
                createdAt: 1700,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'task-lifecycle',
                    event: 'task_complete',
                    id: 'tool-lifecycle-2',
                },
            };
            const result = reducer(state, [lifecycleCompleteEvent], approvedState);

            expect(result.messages).toHaveLength(0);

            const messageId = state.toolIdToMessageId.get('tool-lifecycle-2');
            const toolMessage = messageId ? state.messages.get(messageId) : null;
            expect(toolMessage?.tool?.state).toBe('running');
            expect(toolMessage?.tool?.permission?.status).toBe('approved');
            expect(toolMessage?.tool?.completedAt).toBeNull();
            expect(toolMessage?.tool?.result).toBeUndefined();
        });

        it('should buffer a tool result that arrives before the tool call and apply it when the tool call arrives', () => {
            const state = createReducer();

            // Tool result arrives first
            const resultMessages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 1100,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'Success',
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, resultMessages);
            expect(result1.messages).toHaveLength(0); // No tool call yet, so nothing to render

            // Tool call arrives later
            const toolMessages: NormalizedMessage[] = [
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Test',
                        input: { test: true },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, toolMessages);
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.state).toBe('completed');
                expect(result2.messages[0].tool.result).toBe('Success');
                expect(result2.messages[0].tool.completedAt).toBe(1100);
            }

            // Result arrives again (should be ignored once tool is already completed)
            const resultMessages2: NormalizedMessage[] = [
                {
                    id: 'msg-3',
                    localId: null,
                    createdAt: 1200,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'Success',
                        is_error: false,
                        uuid: 'result-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result3 = reducer(state, resultMessages2, null);
            expect(result3.messages).toHaveLength(0);
        });

        it('should apply buffered streaming tool-result chunks and final results when the tool call arrives later', () => {
            const state = createReducer();

            const toolResultChunksFirst: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 1100,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: { _stream: true, stdoutChunk: 'hello\\n' },
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                },
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 1200,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: { exit_code: 0 },
                        is_error: false,
                        uuid: 'result-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, toolResultChunksFirst);
            expect(result1.messages).toHaveLength(0);

            const toolCallLater: NormalizedMessage[] = [
                {
                    id: 'msg-3',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'echo hello' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, toolCallLater);
            expect(result2.messages).toHaveLength(1);
            expect(result2.messages[0].kind).toBe('tool-call');
            if (result2.messages[0].kind !== 'tool-call') return;

            expect(result2.messages[0].tool.state).toBe('completed');
            expect(result2.messages[0].tool.completedAt).toBe(1200);
            expect(result2.messages[0].tool.result).toMatchObject({
                exit_code: 0,
                stdout: 'hello\\n',
            });
        });

        it('should treat streaming tool results as incremental output without completing', () => {
            const state = createReducer();

            const toolCallMessages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'echo hello' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, toolCallMessages);
            expect(result1.messages).toHaveLength(1);
            expect(result1.messages[0].kind).toBe('tool-call');
            if (result1.messages[0].kind === 'tool-call') {
                expect(result1.messages[0].tool.state).toBe('running');
                expect(result1.messages[0].tool.completedAt).toBeNull();
            }

            const streamChunk1: NormalizedMessage[] = [
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 1100,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: { _stream: true, _terminal: true, stdoutChunk: 'hello\\n' },
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, streamChunk1);
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.state).toBe('running');
                expect(result2.messages[0].tool.completedAt).toBeNull();
                expect(result2.messages[0].tool.result).toEqual({ stdout: 'hello\\n' });
            }

            const streamChunk2: NormalizedMessage[] = [
                {
                    id: 'msg-3',
                    localId: null,
                    createdAt: 1150,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: { _stream: true, stdoutChunk: 'world\\n' },
                        is_error: false,
                        uuid: 'result-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result3 = reducer(state, streamChunk2);
            expect(result3.messages).toHaveLength(1);
            if (result3.messages[0].kind === 'tool-call') {
                expect(result3.messages[0].tool.state).toBe('running');
                expect(result3.messages[0].tool.completedAt).toBeNull();
                expect(result3.messages[0].tool.result).toEqual({ stdout: 'hello\\nworld\\n' });
            }

            const finalResult: NormalizedMessage[] = [
                {
                    id: 'msg-4',
                    localId: null,
                    createdAt: 1200,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: { exitCode: 0 },
                        is_error: false,
                        uuid: 'result-uuid-3',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result4 = reducer(state, finalResult);
            expect(result4.messages).toHaveLength(1);
            if (result4.messages[0].kind === 'tool-call') {
                expect(result4.messages[0].tool.state).toBe('completed');
                expect(result4.messages[0].tool.completedAt).toBe(1200);
                expect(result4.messages[0].tool.result).toEqual({ exitCode: 0, stdout: 'hello\\nworld\\n' });
            }
        });

        it('should handle interleaved messages from multiple sources correctly', () => {
            const state = createReducer();

            // Mix of user messages, permissions, and tool calls
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo "hello"' },
                        createdAt: 1500
                    }
                },
                completedRequests: {
                    'tool-2': {
                        tool: 'Read',
                        arguments: { file: 'test.txt' },
                        createdAt: 500,
                        completedAt: 1000,
                        status: 'approved'
                    }
                }
            };

            const messages: NormalizedMessage[] = [
                // User message
                {
                    id: 'user-1',
                    localId: 'local-1',
                    createdAt: 1000,
                    role: 'user',
                    content: { type: 'text', text: 'Do something' },
                    isSidechain: false
                },
                // Agent text
                {
                    id: 'agent-1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    content: [{
                        type: 'text',
                        text: 'I will help you',
                        uuid: 'agent-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                },
                // Tool call
                {
                    id: 'tool-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-new',
                        name: 'Write',
                        input: { file: 'output.txt', content: 'data' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages, agentState);

            // Should create: 1 user, 1 agent text, 1 tool from permission request,
            // 1 tool from completed permission, 1 new tool call
            expect(result.messages).toHaveLength(5);

            const types = result.messages.map(m => m.kind).sort();
            expect(types).toEqual(['agent-text', 'tool-call', 'tool-call', 'tool-call', 'user-text']);

            // Verify each has correct properties
            const userMsg = result.messages.find(m => m.kind === 'user-text');
            expect(userMsg?.createdAt).toBe(1000);

            const pendingPerm = result.messages.find(m =>
                m.kind === 'tool-call' && m.tool.permission?.status === 'pending'
            );
            expect(pendingPerm).toBeDefined();

            const approvedPerm = result.messages.find(m =>
                m.kind === 'tool-call' && m.tool.permission?.status === 'approved'
            );
            expect(approvedPerm).toBeDefined();
        });

        it('should not allow multiple tool results for the same tool ID', () => {
            const state = createReducer();

            // Create a tool call
            const toolMessages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Test',
                        input: {},
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            reducer(state, toolMessages);

            // First result
            const result1Messages: NormalizedMessage[] = [
                {
                    id: 'msg-2',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'First result',
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result1 = reducer(state, result1Messages);
            expect(result1.messages).toHaveLength(1);
            if (result1.messages[0].kind === 'tool-call') {
                expect(result1.messages[0].tool.state).toBe('completed');
                expect(result1.messages[0].tool.result).toBe('First result');
            }

            // Second result (should be ignored)
            const result2Messages: NormalizedMessage[] = [
                {
                    id: 'msg-3',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'Should not override',
                        is_error: true,
                        uuid: 'result-uuid-2',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result2 = reducer(state, result2Messages);
            expect(result2.messages).toHaveLength(0); // No changes

            // Verify original result is preserved
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('First result');
        });

        it('should handle permission updates after tool execution started', () => {
            const state = createReducer();

            // Create approved permission
            const agentState1: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            reducer(state, [], agentState1);

            // Tool call arrives and matches
            const toolMessages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            reducer(state, toolMessages, agentState1);

            // Try to change permission status (should not affect running tool)
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 4000,
                        status: 'denied',
                        reason: 'Changed mind'
                    }
                }
            };

            const result = reducer(state, [], agentState2);
            expect(result.messages).toHaveLength(0); // No changes, tool already started

            // Verify tool is still running
            const permMsgId = state.toolIdToMessageId.get('tool-1');
            const permMsg = state.messages.get(permMsgId!);
            expect(permMsg?.tool?.state).toBe('running');
            expect(permMsg?.tool?.permission?.status).toBe('approved'); // Status unchanged
        });

        it('should handle empty or null AgentState gracefully', () => {
            const state = createReducer();

            // Test with null
            const result1 = reducer(state, [], null);
            expect(result1.messages).toHaveLength(0);

            // Test with undefined
            const result2 = reducer(state, [], undefined);
            expect(result2.messages).toHaveLength(0);

            // Test with empty AgentState
            const emptyState: AgentState = {};
            const result3 = reducer(state, [], emptyState);
            expect(result3.messages).toHaveLength(0);

            // Test with null requests/completedRequests
            const partialState: AgentState = {
                requests: null,
                completedRequests: null
            };
            const result4 = reducer(state, [], partialState);
            expect(result4.messages).toHaveLength(0);
        });

        it('should match completed permissions and tool calls by ID even with different arguments', () => {
            const state = createReducer();

            // AgentState has completed permission for Bash with 'ls' command
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved'
                    }
                }
            };

            // Incoming messages have tool call for Bash with 'pwd' command
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'pwd' },
                        description: null,
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }],
                    isSidechain: false
                }
            ];

            const result = reducer(state, messages, agentState);

            // Should update the existing permission message (ID match)
            expect(result.messages).toHaveLength(1);

            // The message should have the permission's arguments
            const toolMessage = result.messages[0];
            expect(toolMessage.kind).toBe('tool-call');
            if (toolMessage.kind === 'tool-call') {
                expect(toolMessage.tool.name).toBe('Bash');
                // Keeps original permission arguments
                expect(toolMessage.tool.input).toEqual({ command: 'ls' });
                expect(toolMessage.tool.permission?.status).toBe('approved');
            }
        });

        it('should maintain correct state across many operations', () => {
            const state = createReducer();
            let totalMessages = 0;

            // Simulate a long conversation with many operations
            for (let i = 0; i < 10; i++) {
                // Add user message
                const userMsg: NormalizedMessage[] = [
                    {
                        id: `user-${i}`,
                        localId: `local-${i}`,
                        createdAt: i * 1000,
                        role: 'user',
                        content: { type: 'text', text: `Message ${i}` },
                        isSidechain: false
                    }
                ];

                const userResult = reducer(state, userMsg);
                expect(userResult.messages).toHaveLength(1);
                totalMessages++;

                // Add permission
                const agentState: AgentState = {
                    requests: {
                        [`perm-${i}`]: {
                            tool: 'Test',
                            arguments: { index: i },
                            createdAt: i * 1000 + 100
                        }
                    }
                };

                const permResult = reducer(state, [], agentState);
                expect(permResult.messages).toHaveLength(1);
                totalMessages++;

                // Approve permission
                const approvedState: AgentState = {
                    completedRequests: {
                        [`perm-${i}`]: {
                            tool: 'Test',
                            arguments: { index: i },
                            createdAt: i * 1000 + 100,
                            completedAt: i * 1000 + 200,
                            status: 'approved'
                        }
                    }
                };

                reducer(state, [], approvedState);
            }

            // Verify state integrity
            expect(state.messages.size).toBe(totalMessages);
            expect(state.toolIdToMessageId.size).toBe(10);
            expect(state.localIds.size).toBe(10);

            // Try to add duplicates (should not increase count)
            const duplicateUser: NormalizedMessage[] = [
                {
                    id: 'user-0',
                    localId: 'local-0',
                    createdAt: 0,
                    role: 'user',
                    content: { type: 'text', text: 'Duplicate' },
                    isSidechain: false
                }
            ];

            const dupResult = reducer(state, duplicateUser);
            expect(dupResult.messages).toHaveLength(0);
            expect(state.messages.size).toBe(totalMessages); // No increase
        });

        it('should NOT create duplicate messages for pending permission requests', () => {
            const state = createReducer();

            // AgentState with a pending permission request
            const agentState: AgentState = {
                requests: {
                    'tool-pending-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            // Process the pending permission - should create exactly ONE message
            const result1 = reducer(state, [], agentState);
            expect(result1.messages).toHaveLength(1);
            expect(result1.messages[0].kind).toBe('tool-call');

            // Verify only one message exists
            const pendingMessageId = state.toolIdToMessageId.get('tool-pending-1');
            expect(pendingMessageId).toBeDefined();
            expect(state.messages.size).toBe(1);

            // Process again with same state - should not create duplicate
            const sizeBefore = state.messages.size;
            const result2 = reducer(state, [], agentState);
            // Reducer may return updated existing messages, but must not add duplicates.
            expect(state.messages.size).toBe(sizeBefore); // Still only one message

            // Verify the message has correct permission status
            const message = state.messages.get(pendingMessageId!);
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('tool-pending-1');
        });

        it('should match permissions when tool messages are loaded BEFORE AgentState', () => {
            const state = createReducer();

            // First, process the tool call message (as if loaded from storage)
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            const result1 = reducer(state, messages);

            // Should create the tool message
            expect(result1.messages).toHaveLength(1);
            expect(state.messages.size).toBe(1);

            // Now process the AgentState with pending permission
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900  // Permission requested before the tool call
                    }
                }
            };

            const result2 = reducer(state, [], agentState);

            // Should NOT create a new message, but update the existing one
            expect(result2.messages).toHaveLength(1); // The updated message
            expect(state.messages.size).toBe(1); // Still only one message

            // The existing tool message should now have the permission attached
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();

            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('tool-1');
        });

        it('should match permissions when tool messages are loaded AFTER AgentState', () => {
            const state = createReducer();

            // First, process the AgentState with pending permission
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900
                    }
                }
            };

            const result1 = reducer(state, [], agentState);

            // Should create a permission message
            expect(result1.messages).toHaveLength(1);
            expect(state.messages.size).toBe(1);

            // Now process the tool call message
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            const result2 = reducer(state, messages, agentState);

            // Should NOT create a new message, but update the existing permission message
            expect(result2.messages).toHaveLength(1); // The updated message
            expect(state.messages.size).toBe(1); // Still only one message

            // The permission message should now be linked to the tool
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();

            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('tool-1');
            expect(message?.tool?.startedAt).toBe(1000); // From the tool message
        });

        it('should not downgrade approved permission to pending when AgentState has both', () => {
            const state = createReducer();

            // AgentState with both pending and completed for same permission
            // This can happen when server sends stale data
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            // Process tool message
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            const result = reducer(state, messages, agentState);

            // Should create one message
            expect(result.messages).toHaveLength(1);

            // Permission should be approved, NOT pending
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            const message = state.messages.get(messageId!);
            expect(message).toBeDefined();
            expect(message?.tool).toBeDefined();
            expect(message?.tool?.permission).toBeDefined();
            expect(message?.tool?.permission?.status).toBe('approved'); // Not 'pending'!
        });

        it('should update permission status when AgentState changes from pending to approved', () => {
            const state = createReducer();

            // First, create a tool message with pending permission
            const agentState1: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            // Process with pending permission
            const messages = [toolMessage];
            const result1 = reducer(state, messages, agentState1);

            // Should create one message with pending permission
            expect(result1.messages).toHaveLength(1);
            expect(state.messages.size).toBe(1);

            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();

            let message = state.messages.get(messageId!);
            expect(message?.tool?.permission?.status).toBe('pending');

            // Now update AgentState to approved
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            // Process only the new AgentState (simulating applySessions update)
            const result2 = reducer(state, [], agentState2);

            // Should return the updated message
            expect(result2.messages).toHaveLength(1);
            expect(state.messages.size).toBe(1); // Still only one message

            // Check that the permission status was updated
            message = state.messages.get(messageId!);
            expect(message?.tool?.permission?.status).toBe('approved');
            expect(message?.tool?.permission?.id).toBe('tool-1');
        });

        it('should handle app loading flow: tool loaded first, then AgentState with approved permission', () => {
            const state = createReducer();

            // Step 1: Load tool message first (without AgentState) - simulates messages loaded before sessions
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            const result1 = reducer(state, messages); // No AgentState

            // Tool should be created without permission
            expect(result1.messages).toHaveLength(1);
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            expect(toolMsgId).toBeDefined();
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission).toBeUndefined();
            expect(toolMsg?.tool?.state).toBe('running');

            // Step 2: AgentState arrives with both pending and approved (sessions loaded)
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            const result2 = reducer(state, [], agentState);

            // Should update the existing tool with approved permission
            expect(result2.messages).toHaveLength(1); // Updated message
            expect(state.messages.size).toBe(1); // Still only one message

            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission).toBeDefined();
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.permission?.id).toBe('tool-1');
            expect(toolMsg?.tool?.state).toBe('running'); // Should stay running for approved
        });

        it('should handle app loading flow: tool loaded first, then AgentState with denied permission', () => {
            const state = createReducer();

            // Step 1: Load tool message first
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'rm -rf /' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            reducer(state, messages);

            // Step 2: AgentState arrives with denied permission
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm -rf /' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm -rf /' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'Dangerous command'
                    }
                }
            };

            const result2 = reducer(state, [], agentState);

            // Should update the existing tool with denied permission
            expect(result2.messages).toHaveLength(1);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Dangerous command');
            expect(toolMsg?.tool?.state).toBe('error'); // Should change to error
            expect(toolMsg?.tool?.completedAt).toBeDefined();
            expect(toolMsg?.tool?.result).toEqual({ error: 'Dangerous command' });
        });

        it('should handle app loading flow: tool loaded first, then AgentState with canceled permission', () => {
            const state = createReducer();

            // Step 1: Load tool message first
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'sleep 3600' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            const messages = [toolMessage];
            reducer(state, messages);

            // Step 2: AgentState arrives with canceled permission
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 3600' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 3600' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'canceled',
                        reason: 'User canceled'
                    }
                }
            };

            const result2 = reducer(state, [], agentState);

            // Should update the existing tool with canceled permission
            expect(result2.messages).toHaveLength(1);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('canceled');
            expect(toolMsg?.tool?.permission?.reason).toBe('User canceled');
            expect(toolMsg?.tool?.state).toBe('error'); // Should change to error
            expect(toolMsg?.tool?.completedAt).toBeDefined();
            expect(toolMsg?.tool?.result).toEqual({ error: 'User canceled' });
        });

        it('should handle permission state transitions correctly', () => {
            const state = createReducer();

            // Start with pending permission
            const agentState1: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo test' },
                        createdAt: 1000
                    }
                }
            };

            const result1 = reducer(state, [], agentState1);
            expect(result1.messages).toHaveLength(1);

            const permMsgId = state.toolIdToMessageId.get('tool-1');
            let msg = state.messages.get(permMsgId!);
            expect(msg?.tool?.permission?.status).toBe('pending');
            expect(msg?.tool?.state).toBe('running');

            // Transition to approved
            const agentState2: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo test' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };

            const result2 = reducer(state, [], agentState2);
            expect(result2.messages).toHaveLength(1);

            msg = state.messages.get(permMsgId!);
            expect(msg?.tool?.permission?.status).toBe('approved');
            expect(msg?.tool?.state).toBe('completed');
            expect(msg?.tool?.startedAt).toBeNull();
            expect(msg?.tool?.completedAt).toBe(2000);

            // Now simulate a different scenario: transition from pending to denied
            const state2 = createReducer();
            const agentState3: AgentState = {
                requests: {
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'echo denied' },
                        createdAt: 3000
                    }
                }
            };

            reducer(state2, [], agentState3);

            const agentState4: AgentState = {
                completedRequests: {
                    'tool-2': {
                        tool: 'Bash',
                        arguments: { command: 'echo denied' },
                        createdAt: 3000,
                        completedAt: 4000,
                        status: 'denied',
                        reason: 'Not allowed'
                    }
                }
            };

            const result4 = reducer(state2, [], agentState4);
            expect(result4.messages).toHaveLength(1);

            const permMsgId2 = state2.toolIdToMessageId.get('tool-2');
            const msg2 = state2.messages.get(permMsgId2!);
            expect(msg2?.tool?.permission?.status).toBe('denied');
            expect(msg2?.tool?.state).toBe('error'); // Should change to error
            expect(msg2?.tool?.completedAt).toBe(4000);
            expect(msg2?.tool?.result).toEqual({ error: 'Not allowed' });
        });

        it('should handle finished tool: completed successfully, then AgentState with approved permission', () => {
            const state = createReducer();

            // Step 1: Load tool message that's already completed
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'echo success' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            // Tool result message
            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'success\n',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };

            const messages = [toolMessage, resultMessage];
            reducer(state, messages);

            // Verify tool is completed
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('success\n');
            expect(toolMsg?.tool?.permission).toBeUndefined();

            // Step 2: AgentState arrives with approved permission
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo success' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo success' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };

            const result = reducer(state, [], agentState);

            // Permission should be attached but tool should remain completed
            expect(result.messages).toHaveLength(1);
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('completed'); // Should stay completed
            expect(toolMsg?.tool?.result).toBe('success\n'); // Result unchanged
        });

        it('should handle finished tool: completed successfully, then AgentState with denied permission', () => {
            const state = createReducer();

            // Step 1: Load completed tool
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'rm important.txt' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'file removed',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };

            reducer(state, [toolMessage, resultMessage]);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');

            // Step 2: AgentState with denied permission (too late!)
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm important.txt' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm important.txt' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'denied',
                        reason: 'Dangerous operation'
                    }
                }
            };

            reducer(state, [], agentState);

            // Tool should NOT change to error (already executed)
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Dangerous operation');
            expect(toolMsg?.tool?.state).toBe('completed'); // Should stay completed, not error
            expect(toolMsg?.tool?.result).toBe('file removed'); // Result unchanged
        });

        it('should handle finished tool: errored, then AgentState with approved permission', () => {
            const state = createReducer();

            // Step 1: Load tool that errored
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'cat /nonexistent' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            const errorMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'File not found',
                    is_error: true,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };

            reducer(state, [toolMessage, errorMessage]);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('error');
            expect(toolMsg?.tool?.result).toBe('File not found');

            // Step 2: AgentState with approved permission (too late to help)
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'cat /nonexistent' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };

            reducer(state, [], agentState);

            // Permission attached but error state maintained
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('error'); // Should stay error
            expect(toolMsg?.tool?.result).toBe('File not found'); // Error unchanged
        });

        it('should handle finished tool: errored, then AgentState with denied permission', () => {
            const state = createReducer();

            // Step 1: Load tool that errored
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'sudo rm -rf /' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            const errorMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'Permission denied',
                    is_error: true,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };

            reducer(state, [toolMessage, errorMessage]);

            // Step 2: AgentState with denied permission
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sudo rm -rf /' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'denied',
                        reason: 'Extremely dangerous'
                    }
                }
            };

            reducer(state, [], agentState);

            // Both permission and error should be present
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Extremely dangerous');
            expect(toolMsg?.tool?.state).toBe('error');
            expect(toolMsg?.tool?.result).toBe('Permission denied'); // Original error
        });

        it('should handle finished tool: with multiple messages in sequence', () => {
            const state = createReducer();

            // Step 1: Tool call
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            reducer(state, [toolMessage]);

            // Step 2: Tool result arrives
            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'file1.txt\nfile2.txt',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };

            reducer(state, [resultMessage]);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('file1.txt\nfile2.txt');

            // Step 3: AgentState arrives later with permission info
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };

            const result = reducer(state, [], agentState);

            // Permission should be attached to completed tool
            expect(result.messages).toHaveLength(1);
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('file1.txt\nfile2.txt');
        });

        it('should handle real-world scenario: messages and AgentState received simultaneously', () => {
            const state = createReducer();

            // Simulate a tool call message from the agent
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }],
                isSidechain: false
            };

            // AgentState with the pending permission for the same tool
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900  // Permission requested before the tool call
                    }
                }
            };

            // Process both simultaneously (as would happen when loading from storage)
            const messages = [toolMessage];
            const result = reducer(state, messages, agentState);

            // Should create exactly ONE message, not two
            expect(result.messages).toHaveLength(1);
            expect(state.messages.size).toBe(1);

            // The message should be the tool call with the permission attached
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();

            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('tool-1');
        });

        it('should retroactively match permissions when tools are processed without AgentState initially', () => {
            const state = createReducer();

            // Step 1: Process tool messages WITHOUT AgentState (simulating messages loading before session)
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'echo hello' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };

            // Process WITHOUT AgentState (undefined)
            const result1 = reducer(state, [toolMessage], undefined);

            // Should create a tool message WITHOUT permission
            expect(result1.messages).toHaveLength(1);
            expect(result1.messages[0].kind).toBe('tool-call');
            if (result1.messages[0].kind === 'tool-call') {
                expect(result1.messages[0].tool.permission).toBeUndefined();
                expect(result1.messages[0].tool.state).toBe('running');
            }

            // Verify tool is registered in state
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            const toolMsgId = state.toolIdToMessageId.get('tool-1');

            // Step 2: Later, AgentState arrives with permission for this tool
            const agentState: AgentState = {
                requests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo hello' },
                        createdAt: 1000  // Permission was requested BEFORE the tool ran
                    }
                }
            };

            // Process with AgentState but no new messages
            const result2 = reducer(state, [], agentState);

            // The reducer SHOULD match the permission to the existing tool
            expect(result2.messages).toHaveLength(1);
            expect(result2.messages[0].kind).toBe('tool-call');
            if (result2.messages[0].kind === 'tool-call') {
                // The existing tool should now have the permission attached
                expect(result2.messages[0].tool.permission?.status).toBe('pending');
                expect(result2.messages[0].tool.permission?.id).toBe('tool-1');
            }

            // Should still only have ONE message - the tool was updated
            expect(state.messages.size).toBe(1);

            // The original tool message should now have permission
            const originalTool = state.messages.get(toolMsgId!);
            expect(originalTool?.tool?.permission).toBeDefined();
            expect(originalTool?.tool?.permission?.status).toBe('pending');

            // The permission should be linked to the existing tool
            const permMsgId = state.toolIdToMessageId.get('tool-1');
            expect(permMsgId).toBeDefined();
            expect(permMsgId).toBe(toolMsgId); // Same message ID
        });

        it('should handle the full race condition scenario: messages load, then session with AgentState, then new message', () => {
            const state = createReducer();

            // Step 1: Messages load WITHOUT AgentState (session hasn't arrived yet)
            const existingMessages: NormalizedMessage[] = [
                // User message
                {
                    id: 'user-1',
                    localId: 'local-1',
                    createdAt: 1000,
                    role: 'user',
                    isSidechain: false,
                    content: {
                        type: 'text',
                        text: 'Please list files'
                    }
                },
                // Tool call that should have permission
                {
                    id: 'tool-msg-1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls -la' },
                        description: 'List files',
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }]
                },
                // Tool result
                {
                    id: 'result-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'file1.txt\nfile2.txt',
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }]
                }
            ];

            // Process messages WITHOUT AgentState
            const result1 = reducer(state, existingMessages, undefined);

            // Should create user message and tool message
            expect(result1.messages.length).toBeGreaterThanOrEqual(2);

            // Find the tool message
            const toolMsg = result1.messages.find(m => m.kind === 'tool-call');
            expect(toolMsg).toBeDefined();
            if (toolMsg?.kind === 'tool-call') {
                expect(toolMsg.tool.permission).toBeUndefined(); // No permission yet
                expect(toolMsg.tool.state).toBe('completed'); // Tool completed
                expect(toolMsg.tool.result).toBe('file1.txt\nfile2.txt');
            }

            // Step 2: Session arrives with AgentState containing permission info
            const agentState: AgentState = {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1500,
                        completedAt: 1800,
                        status: 'approved'
                    }
                }
            };

            // Process AgentState (simulating session arrival)
            const result2 = reducer(state, [], agentState);

            // Should update the existing tool with permission info
            expect(result2.messages).toHaveLength(1);
            if (result2.messages[0].kind === 'tool-call') {
                expect(result2.messages[0].tool.permission?.status).toBe('approved');
                // The tool should still be completed
                expect(result2.messages[0].tool.state).toBe('completed');
            }

            // Step 3: User sends a new message, triggering a new reducer call
            const newUserMessage: NormalizedMessage = {
                id: 'user-2',
                localId: 'local-2',
                createdAt: 4000,
                role: 'user',
                isSidechain: false,
                content: {
                    type: 'text',
                    text: 'Thanks!'
                }
            };

            // Process new message WITH AgentState (as would happen in real app)
            const result3 = reducer(state, [newUserMessage], agentState);

            // Should only create the new user message
            expect(result3.messages).toHaveLength(1);
            expect(result3.messages[0].kind).toBe('user-text');

            // The tool and permission should be the SAME message (matched correctly)
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);

            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const permMsgId = state.toolIdToMessageId.get('tool-1');
            expect(toolMsgId).toBe(permMsgId); // Same message - properly matched!
        });
    });
});
