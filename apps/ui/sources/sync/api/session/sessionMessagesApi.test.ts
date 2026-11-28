import { describe, expect, it } from 'vitest';

import {
    buildSessionMessagesPath,
    parseSessionMessagesResponseJson,
} from './sessionMessagesApi';

function readSearchParams(path: string): URLSearchParams {
    const [, query = ''] = path.split('?');
    return new URLSearchParams(query);
}

describe('sessionMessagesApi', () => {
    it('builds the session messages page path with the canonical scope and range params', () => {
        const path = buildSessionMessagesPath({
            sessionId: 's1',
            scope: 'main',
            limit: 50,
            beforeSeq: 101,
        });

        expect(path.startsWith('/v1/sessions/s1/messages?')).toBe(true);
        const params = readSearchParams(path);
        expect(params.get('scope')).toBe('main');
        expect(params.get('limit')).toBe('50');
        expect(params.get('beforeSeq')).toBe('101');
        expect(params.has('afterSeq')).toBe(false);
        expect(params.has('sidechainId')).toBe(false);
    });

    it('includes sidechain id only for sidechain-scoped message pages', () => {
        const path = buildSessionMessagesPath({
            sessionId: 's1',
            scope: 'sidechain',
            sidechainId: 'chain-1',
            limit: 20,
            afterSeq: 100,
        });

        const params = readSearchParams(path);
        expect(params.get('scope')).toBe('sidechain');
        expect(params.get('sidechainId')).toBe('chain-1');
        expect(params.get('afterSeq')).toBe('100');
    });

    it('parses valid message page responses and rejects invalid shapes at the API boundary', () => {
        expect(parseSessionMessagesResponseJson({
            messages: [],
            hasMore: true,
            nextBeforeSeq: 10,
        })).toEqual({
            messages: [],
            hasMore: true,
            nextBeforeSeq: 10,
        });

        expect(() => parseSessionMessagesResponseJson({ messages: 'bad' })).toThrow('Invalid /messages response');
    });
});

it('exports decrypted transcript rows in order with one backward page in flight', async () => {
    const { exportTranscript } = await import('./sessionMessagesApi');
    let active = 0;
    let maxActive = 0;
    const paths: string[] = [];
    const makeMessage = (seq: number) => ({
        id: `m${seq}`, seq, localId: null, createdAt: seq,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Message ${seq}` } } },
    });
    const request = async (path: string) => {
        paths.push(path);
        maxActive = Math.max(maxActive, ++active);
        await Promise.resolve();
        active--;
        return Response.json(paths.length === 1
            ? { messages: [makeMessage(3), makeMessage(2)], hasMore: true, nextBeforeSeq: 2 }
            : { messages: [makeMessage(1)], hasMore: false, nextBeforeSeq: null });
    };
    const progress: unknown[] = [];
    const transcript = await exportTranscript({
        sessionId: 's', format: 'json', encryptionMode: 'plain',
        request, getSessionEncryption: () => null,
        onReadProgress: (current: number, total: number | null) => progress.push([current, total]),
        onFormatting: () => { progress.push('formatting'); },
    });
    expect(transcript && JSON.parse(transcript).map((message: { text: string }) => message.text))
        .toEqual(['Message 1', 'Message 2', 'Message 3']);
    expect(paths).toEqual(['/v1/sessions/s/messages?scope=all', '/v1/sessions/s/messages?scope=all&beforeSeq=2']);
    expect(maxActive).toBe(1);
    expect(progress).toEqual([[2, null], [3, 3], 'formatting']);
});

it('rejects an empty nonterminal export page without chasing its cursor', async () => {
    const { exportTranscript } = await import('./sessionMessagesApi');
    let reads = 0;
    await expect(exportTranscript({
        sessionId: 's',
        format: 'markdown',
        encryptionMode: 'plain',
        getSessionEncryption: () => null,
        request: async () => {
            reads += 1;
            return Response.json({ messages: [], hasMore: reads === 1, nextBeforeSeq: reads === 1 ? 8 : null });
        },
    })).rejects.toThrow('Transcript paging did not advance');
    expect(reads).toBe(1);
});

async function exportSubagentFixture(options: Readonly<{ includeSubagents?: boolean; seqs?: readonly number[] }> = {}) {
    const { exportTranscript } = await import('./sessionMessagesApi');
    const assistant = (seq: number, sidechainId: string | null, block: unknown) => ({
        id: `m${seq}`, seq, localId: null, createdAt: seq, sidechainId,
        content: {
            t: 'plain',
            v: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant', uuid: `step-${seq}`, isSidechain: sidechainId !== null,
                        message: { role: 'assistant', content: [block] },
                    },
                },
            },
        },
    });
    const tool = (id: string) => ({ type: 'tool_use', id, name: 'Task', input: { prompt: 'Inspect' } });
    const message = (text: string) => ({ type: 'text', text });
    return exportTranscript({
        sessionId: 's', format: 'json', encryptionMode: 'plain', getSessionEncryption: () => null,
        ...options,
        request: async () => Response.json({
            messages: [
                assistant(5, 'outer-tool', message('Linked subagent')),
                assistant(4, 'standalone-workflow-sidechain', tool('nested-tool')),
                assistant(3, 'nested-tool', message('Nested standalone subagent')),
                assistant(2, 'standalone-workflow-sidechain', message('Standalone subagent')),
                assistant(1, null, tool('outer-tool')),
            ],
            hasMore: false,
            nextBeforeSeq: null,
        }),
    });
}

it('exports subagent messages once and preserves tool nesting for linked and standalone sidechains', async () => {
    const transcript = await exportSubagentFixture();

    expect(JSON.parse(transcript)).toEqual([
        expect.objectContaining({ role: 'tool', children: [expect.objectContaining({ text: 'Linked subagent' })] }),
        expect.objectContaining({ text: 'Standalone subagent' }),
        expect.objectContaining({ role: 'tool', children: [expect.objectContaining({ text: 'Nested standalone subagent' })] }),
    ]);
});

it('leaves every subagent transcript out when the export excludes them', async () => {
    const records = JSON.parse(await exportSubagentFixture({ includeSubagents: false }));

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({ role: 'tool', tool: expect.objectContaining({ name: 'Task' }) }));
    expect(records[0]).not.toHaveProperty('children');
});

it('exports a fully loaded selection without fetching a transcript page', async () => {
    const { exportTranscript } = await import('./sessionMessagesApi');
    const request = async (): Promise<Response> => { throw new Error('Selection did not need a transcript page'); };
    const records = JSON.parse(await exportTranscript({
        sessionId: 's1',
        seqs: [2],
        loadedMessages: [
            { id: 'm1', kind: 'user-text', seq: 1, localId: null, createdAt: 1, text: 'Other message' },
            { id: 'm2', kind: 'user-text', seq: 2, localId: null, createdAt: 2, text: 'Selected message' },
        ],
        format: 'json',
        encryptionMode: 'plain',
        getSessionEncryption: () => null,
        request,
    }));

    expect(records).toEqual([expect.objectContaining({ seq: 2, text: 'Selected message' })]);
});

it('exports only selected sequences, including standalone subagent messages', async () => {
    const records = JSON.parse(await exportSubagentFixture({ seqs: [1, 3] }));

    expect(records).toEqual([
        expect.objectContaining({ role: 'tool', tool: expect.objectContaining({ name: 'Task' }) }),
        expect.objectContaining({ text: 'Nested standalone subagent' }),
    ]);
    expect(records[0]).not.toHaveProperty('children');
});

it('exports encrypted rows in both formats and fails on a row the device cannot decrypt', async () => {
    const [{ AES256Encryption }, { SessionEncryption }, { EncryptionCache }, { exportTranscript, serializeTranscript }] = await Promise.all([
        import('@/sync/encryption/encryptor'),
        import('@/sync/encryption/sessionEncryption'),
        import('@/sync/encryption/encryptionCache'),
        import('./sessionMessagesApi'),
    ]);
    const correctKey = new Uint8Array(32).fill(4);
    const sessionEncryption = new SessionEncryption('s', new AES256Encryption(correctKey), new EncryptionCache());
    const ciphertext = await sessionEncryption.encryptRaw({
        role: 'user', content: { type: 'text', text: 'Encrypted transcript' },
    });
    const request = async () => Response.json({
        messages: [{ id: 'm1', seq: 1, localId: null, createdAt: 123, content: { t: 'encrypted', c: ciphertext } }],
        hasMore: false,
        nextBeforeSeq: null,
    });
    const params = { sessionId: 's', request, encryptionMode: 'e2ee' as const };
    for (const format of ['markdown', 'json'] as const) {
        const text = await exportTranscript({ ...params, format, getSessionEncryption: () => sessionEncryption });
        const expected = serializeTranscript([{
            kind: 'user-text', id: 'm1', seq: 1, localId: null, createdAt: 123, text: 'Encrypted transcript',
        }], format);
        expect(text).toEqual(expected);
        const { writeTranscriptArchive } = await import('./writeTranscriptArchive');
        const chunks: Uint8Array[] = [];
        await writeTranscriptArchive({
            format, sessions: [{ id: 's', read: () => exportTranscript({ ...params, format, getSessionEncryption: () => sessionEncryption }) }],
            write: async (chunk) => { chunks.push(chunk); },
        });
        const { unzipSync, strFromU8 } = await import('fflate');
        const entries = unzipSync(Buffer.concat(chunks));
        expect(strFromU8(entries[format === 'json' ? 's.json' : 's.md']!)).toBe(expected);
    }
    const wrongEncryption = new SessionEncryption('s', new AES256Encryption(new Uint8Array(32).fill(3)), new EncryptionCache());
    await expect(exportTranscript({ ...params, format: 'json', getSessionEncryption: () => wrongEncryption }))
        .rejects.toThrow('Session message page could not be fully decrypted');
});
