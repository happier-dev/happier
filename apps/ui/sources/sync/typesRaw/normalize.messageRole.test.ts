import { describe, expect, it } from 'vitest';

import { hasSyntheticNoResponseMeta } from '../domains/messages/syntheticNoResponseMessageMeta';
import { normalizeDirectTranscriptMessages } from '../runtime/directSessions/normalizeDirectTranscriptMessages';
import { normalizeRawMessage } from './normalize';
import { extractStdStreams } from '@/components/tools/normalization/parse/stdStreams';
import { readBashBackgroundTaskId } from '@/components/tools/normalization/parse/backgroundTask';
import { normalizeToolResultForRendering } from '@/components/tools/normalization/normalize/resultNormalization';

function createProducerShapedSyntheticNoResponseRaw() {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'synthetic-uuid',
                isSidechain: false,
                model: '<synthetic>',
                message: {
                    role: 'assistant',
                    stop_reason: 'end_turn',
                    content: [{ type: 'text', text: 'No response requested.' }],
                },
            },
        },
        meta: { source: 'cli' },
    } as const;
}

describe('normalizeRawMessage messageRole metadata', () => {
    it('renders canonical command and report results with the same native facts as historical stored rows', () => {
        const report = 'Complete report\nwith all findings';
        const command = { stdout: report, stderr: '', exit_code: 0, backgroundTaskId: 'task-1' };
        const task = { content: [{ type: 'text', text: report }], agentId: 'agent-1', structuredPatch: [{ oldStart: 1 }] };
        for (const result of [command, task]) {
            const normalizeResult = (historical: boolean) => {
                const normalized = normalizeRawMessage('result', 'claude-jsonl:main:user:result', 1_701, {
                    role: 'agent', content: { type: 'output', data: {
                        type: 'user', uuid: 'result',
                        ...(historical ? { toolUseResult: result } : {}),
                        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1',
                            content: historical ? report : result, is_error: false }] },
                    } },
                }, { messageRole: 'event' });
                if (normalized?.role !== 'agent' || normalized.content[0]?.type !== 'tool-result') throw new Error('Missing tool result');
                return JSON.parse(normalized.content[0].content);
            };
            const canonical = normalizeResult(false);
            expect(canonical).toEqual(normalizeResult(true));
            expect(canonical).toEqual(result);
            expect(extractStdStreams(canonical)?.stdout).toBe(report);
            if ('backgroundTaskId' in result) expect(readBashBackgroundTaskId(canonical)).toBe('task-1');
            else expect(normalizeToolResultForRendering({ canonicalToolName: 'Task', result: canonical })).toMatchObject(task);
        }
    });

    it('marks Claude synthetic no-response rows for reducer suppression even when stored as events', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        model: '<synthetic>',
                        stop_reason: 'stop_sequence',
                        stop_sequence: '',
                        content: [{ type: 'text', text: 'No response requested.' }],
                    },
                    uuid: 'synthetic-uuid',
                },
            },
            meta: { source: 'cli' },
        } as const;

        const normalized = normalizeRawMessage(
            'msg-synthetic',
            'claude-jsonl:main:assistant:synthetic-uuid',
            1_700,
            raw,
            { seq: 12, messageRole: 'event' },
        );

        expect(normalized?.role).toBe('agent');
        expect(hasSyntheticNoResponseMeta(normalized?.meta)).toBe(true);
    });

    it('marks producer-shaped Claude synthetic no-response rows before event output filtering', () => {
        const normalized = normalizeRawMessage(
            'msg-synthetic',
            'claude-jsonl:main:assistant:synthetic-uuid',
            1_700,
            createProducerShapedSyntheticNoResponseRaw(),
            { seq: 12, messageRole: 'event' },
        );

        expect(normalized?.role).toBe('agent');
        expect(hasSyntheticNoResponseMeta(normalized?.meta)).toBe(true);
    });

    it('marks producer-shaped direct transcript synthetic no-response rows for suppression', () => {
        const [normalized] = normalizeDirectTranscriptMessages([{
            id: 'direct-synthetic',
            localId: 'claude-jsonl:main:assistant:synthetic-uuid',
            createdAtMs: 1_700,
            raw: createProducerShapedSyntheticNoResponseRaw(),
        }]);

        expect(normalized?.role).toBe('agent');
        expect(hasSyntheticNoResponseMeta(normalized?.meta)).toBe(true);
    });

    it('filters non-renderable direct transcript rows using producer role metadata', () => {
        const normalized = normalizeDirectTranscriptMessages([{
            id: 'direct-api-error',
            localId: 'claude-jsonl:main:assistant:assistant-api-error',
            createdAtMs: 1_700,
            messageRole: 'event',
            raw: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', uuid: 'assistant-api-error', isApiErrorMessage: true },
                },
            },
        }]);

        expect(normalized).toEqual([]);
    });

    it('preserves Claude tool calls stored as event-role output rows', () => {
        const normalized = normalizeRawMessage(
            'msg-tool-call',
            'claude-jsonl:main:assistant:tool-call',
            1_700,
            {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-call-uuid',
                        isSidechain: false,
                        message: {
                            role: 'assistant',
                            content: [{
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: {
                                    command: 'echo hi',
                                    description: 'Say hi',
                                },
                            }],
                        },
                    },
                },
            },
            { seq: 13, messageRole: 'event' },
        );

        expect(normalized?.role).toBe('agent');
        expect(normalized?.content).toEqual([
            expect.objectContaining({
                type: 'tool-call',
                id: 'toolu_1',
                name: 'Bash',
                description: 'Say hi',
            }),
        ]);
    });

    it('preserves Claude tool results stored as event-role output rows', () => {
        const normalized = normalizeRawMessage(
            'msg-tool-result',
            'claude-jsonl:main:user:tool-result',
            1_701,
            {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        uuid: 'tool-result-uuid',
                        isSidechain: false,
                        toolUseResult: { stdout: 'hi\n' },
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'toolu_1',
                                content: 'fallback',
                                is_error: false,
                            }],
                        },
                    },
                },
            },
            { seq: 14, messageRole: 'event' },
        );

        expect(normalized?.role).toBe('agent');
        expect(normalized?.content).toEqual([
            expect.objectContaining({
                type: 'tool-result',
                tool_use_id: 'toolu_1',
                content: expect.stringContaining('hi'),
            }),
        ]);
    });

    it('preserves renderable thinking output rows classified as events', () => {
        const normalized = normalizeRawMessage(
            'msg-thinking',
            'claude-jsonl:main:assistant:thinking',
            1_702,
            {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'thinking-uuid',
                        isSidechain: false,
                        message: {
                            role: 'assistant',
                            content: [{
                                type: 'thinking',
                                thinking: 'I need to inspect the repo.',
                            }],
                        },
                    },
                },
            },
            { seq: 15, messageRole: 'event' },
        );

        expect(normalized?.role).toBe('agent');
        expect(normalized?.content).toEqual([
            expect.objectContaining({
                type: 'thinking',
                thinking: 'I need to inspect the repo.',
            }),
        ]);
    });

    it('drops non-structured output rows classified as events', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Transport status' }],
                    },
                    uuid: 'event-uuid',
                },
            },
        } as const;

        expect(normalizeRawMessage('msg-event', null, 1_700, raw, { messageRole: 'event' })).toBeNull();
    });
});
