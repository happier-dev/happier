import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeRawJsonlSessionStore } from './createClaudeRawJsonlSessionStore';

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
    tempDirs.add(path);
    return path;
}

afterEach(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('createClaudeRawJsonlSessionStore', () => {
    it('warms full raw history in order on first readAfter call', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-claude-raw-store-history-')));
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-raw-history');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-raw-history.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({ type: 'summary', leafUuid: 'leaf-1', summary: 'history summary' }),
                jsonlLine({ type: 'user', uuid: 'user-1', message: { content: 'hello raw' } }),
                jsonlLine({
                    type: 'assistant',
                    uuid: 'assistant-1',
                    message: { model: 'm', content: [{ type: 'text', text: 'raw reply' }] },
                }),
            ].join(''),
            'utf8',
        );

        const store = createClaudeRawJsonlSessionStore({
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'proj-raw-history' },
            remoteSessionId: 'session-raw-history',
        });

        const first = await store.readAfter({ cursor: null, maxBytes: 1024 * 1024, maxItems: 100 });

        expect(first.truncated).toBe(false);
        expect(first.nextCursor).toBeTruthy();
        expect(first.items.map((item) => item.type)).toEqual(['summary', 'user', 'assistant']);
        expect(first.items[1]).toMatchObject({
            type: 'user',
            uuid: 'user-1',
        });
        expect(first.items[2]).toMatchObject({
            type: 'assistant',
            uuid: 'assistant-1',
        });
    });

    it('subscribes to appended raw transcript items through the shared store lifecycle', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-claude-raw-store-subscribe-')));
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-raw-subscribe');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-raw-subscribe.jsonl');
        await writeFile(
            filePath,
            jsonlLine({ type: 'user', uuid: 'user-1', message: { content: 'hello raw' } }),
            'utf8',
        );

        const store = createClaudeRawJsonlSessionStore({
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'proj-raw-subscribe' },
            remoteSessionId: 'session-raw-subscribe',
        });

        await store.readAfter({ cursor: null, maxBytes: 1024 * 1024, maxItems: 100 });

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            filePath,
            jsonlLine({
                type: 'assistant',
                uuid: 'assistant-2',
                message: { model: 'm', content: [{ type: 'text', text: 'appended raw reply' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.truncated).toBe(false);
        expect(events[0]?.items).toHaveLength(1);
        expect(events[0]?.items[0]).toMatchObject({
            type: 'assistant',
            uuid: 'assistant-2',
        });
    });
});
