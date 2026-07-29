import { describe, it, expect } from 'vitest';

import { readStoredSessionMessage, readStoredSessionRawRecord } from './readStoredSessionContent';

describe('readStoredSessionRawRecord', () => {
    it('parses a plain content envelope', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: { t: 'plain', v: rawRecord } });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a raw record directly (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: rawRecord });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a stringified plain content envelope (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: JSON.stringify({ t: 'plain', v: rawRecord }) });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('parses a stringified raw record (legacy payload)', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: 'Plain string message',
                    },
                    uuid: 'string-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionRawRecord({ content: JSON.stringify(rawRecord) });
        expect(parsed?.role).toBe('agent');
        expect(parsed?.content.type).toBe('output');
    });

    it('preserves stored message role metadata when reading plain messages', async () => {
        const rawRecord = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'No response requested.' }],
                        model: '<synthetic>',
                        stop_reason: 'stop_sequence',
                        stop_sequence: '',
                    },
                    uuid: 'synthetic-uuid',
                },
            },
        } as const;

        const parsed = await readStoredSessionMessage({
            message: {
                id: 'msg-synthetic',
                seq: 12,
                localId: 'claude-jsonl:main:assistant:synthetic-uuid',
                messageRole: 'event',
                content: { t: 'plain', v: rawRecord },
                createdAt: 1_700,
            },
        });

        expect(parsed?.messageRole).toBe('event');
    });
});
