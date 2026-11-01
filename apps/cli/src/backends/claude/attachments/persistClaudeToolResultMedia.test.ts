import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { persistClaudeToolResultMedia } from './persistClaudeToolResultMedia';
import type { RawJSONLines } from '../types';

describe('Claude tool-result media', () => {
    it('removes unsupported image payloads and their native metadata copies before transcript storage', async () => {
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
        expect(JSON.stringify(result)).not.toContain(data);
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
            expect(JSON.stringify(result)).not.toContain(data);
            expect(JSON.stringify(body)).toContain(data);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
