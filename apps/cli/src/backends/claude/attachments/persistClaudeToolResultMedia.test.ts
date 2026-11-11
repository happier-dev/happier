import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { persistClaudeToolResultMedia } from './persistClaudeToolResultMedia';
import type { RawJSONLines } from '../types';
import { SessionMediaMessageMetaEnvelopeV1Schema } from '@happier-dev/protocol';

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe('Claude tool-result media', () => {
    it('retains the failed image when another image in the same tool result persisted', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-claude-media-partial-'));
        const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
        const failedBytes = Buffer.concat([Buffer.from(data, 'base64'), Buffer.from('failed write')]);
        const failedData = failedBytes.toString('base64');
        const originalWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
        // The OS write boundary fails for one source; extraction and media persistence remain real.
        const writes = vi.mocked(filesystem.writeFile).mockImplementation(async (file, contents, options) => {
            if (Buffer.isBuffer(contents) && contents.equals(failedBytes)) throw new Error('fixture write failure');
            return await originalWriteFile(file, contents, options);
        });
        try {
            const body: RawJSONLines = { type: 'user', uuid: 'partial-image', message: { content: [{
                type: 'tool_result', tool_use_id: 'read-1', content: [data, failedData].map(image => ({
                    type: 'image', source: { type: 'base64', media_type: 'image/png', data: image },
                })),
            }] }, toolUseResult: { files: [{ base64: data }, { base64: failedData }] } };
            const result = await persistClaudeToolResultMedia({ body, workingDirectory: directory, sessionId: 's1' });
            const envelope = SessionMediaMessageMetaEnvelopeV1Schema.parse(result.meta?.happier);
            expect(envelope.payload.media).toHaveLength(1);
            expect(envelope.payload.unavailable).toMatchObject([{ code: 'persistence_failed' }]);
            expect(result.body.toolUseResult).toEqual({ files: [{ base64: '[session media]' }, { base64: failedData }] });
        } finally {
            writes.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('removes persisted image copies while preserving unpersisted bytes and native facts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-claude-media-success-'));
        try {
            const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
            const unsupported = Buffer.from('unrecognized image encoding').toString('base64');
            const body: RawJSONLines = { type: 'user', uuid: 'persisted-image',
                message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: unsupported } },
                ] }] }, toolUseResult: { type: 'image', file: { base64: data }, status: 'completed' } };
            const result = await persistClaudeToolResultMedia({ body, workingDirectory: directory, sessionId: 's1' });
            const media = SessionMediaMessageMetaEnvelopeV1Schema.parse(result.meta?.happier).payload.media[0]!;
            expect(await readFile(join(directory, media.path))).toEqual(Buffer.from(data, 'base64'));
            expect(JSON.stringify(result)).not.toContain(data);
            expect(JSON.stringify(result)).toContain(unsupported);
            expect(result.body.toolUseResult).toMatchObject({ type: 'image', status: 'completed' });
            expect(JSON.stringify(body)).toContain(data);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('retains unsupported image payloads when the media owner cannot persist them', async () => {
        const data = Buffer.from('unrecognized image encoding').toString('base64');
        const body: RawJSONLines = {
            type: 'user', uuid: 'unsupported-image',
            message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
                { type: 'text', text: 'comparison' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ` ${data}\n` } },
            ] }] },
            toolUseResult: { type: 'image', file: { base64: data } },
        };
        const result = await persistClaudeToolResultMedia({ body, workingDirectory: tmpdir(), sessionId: 's1' });
        expect(JSON.stringify(result)).toContain(data);
        expect(result.body).toMatchObject({ message: { content: [{ tool_use_id: 'read-1', content: [{ type: 'text', text: 'comparison' }, expect.anything()] }] } });
        expect(JSON.stringify(body)).toContain(data);
    });

    it('retains tool text and status with an unavailable item when media storage fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-claude-media-failure-'));
        try {
            await writeFile(join(directory, '.happier'), 'blocks the media directory');
            const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
            const body: RawJSONLines = { type: 'user', uuid: 'read-image-result', message: { content: [{
                type: 'tool_result', tool_use_id: 'read-1', is_error: false,
                content: [{ type: 'text', text: 'comparison' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
            }] } };
            const result = await persistClaudeToolResultMedia({ body, workingDirectory: directory, sessionId: 's1' });
            expect(result.body).toMatchObject({ type: 'user', uuid: 'read-image-result', message: { content: [{ tool_use_id: 'read-1', is_error: false, content: [{ type: 'text', text: 'comparison' }, expect.anything()] }] } });
            expect(result.meta).toMatchObject({ happier: { kind: 'session_media.v1', payload: {
                media: [], unavailable: [{ code: 'persistence_failed', category: 'tool-artifact' }],
            } } });
            expect(JSON.stringify(result)).toContain(data);
            expect(JSON.stringify(body)).toContain(data);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
