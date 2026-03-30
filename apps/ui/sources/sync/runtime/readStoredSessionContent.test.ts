import { describe, it, expect } from 'vitest';

import { readStoredSessionRawRecord } from './readStoredSessionContent';

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
});
