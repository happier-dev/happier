import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeJsonlSessionStore } from './createClaudeJsonlSessionStore';

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

describe('createClaudeJsonlSessionStore', () => {
    it('resolves the session title through the shared store contract', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-claude-store-title-')));
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({
                    type: 'summary',
                    leafUuid: 'leaf-1',
                    summary: 'Shared store Claude title',
                }),
            ].join(''),
            'utf8',
        );

        const store = createClaudeJsonlSessionStore({
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'proj-one' },
            remoteSessionId: 'session-one',
        });

        await expect(store.getTitle()).resolves.toBe('Shared store Claude title');
    });

    it('subscribes to appended transcript items via the shared read-after path', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-claude-store-subscribe-')));
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-two');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-two.jsonl');
        await writeFile(
            filePath,
            jsonlLine({
                type: 'assistant',
                uuid: 'assistant-1',
                message: { content: 'initial message' },
            }),
            'utf8',
        );

        const store = createClaudeJsonlSessionStore({
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'proj-two' },
            remoteSessionId: 'session-two',
        });

        const page = await store.pageOlder({ maxBytes: 1024 * 1024, maxItems: 10 });
        expect(page.tailCursor).toBeTruthy();

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            filePath,
            jsonlLine({
                type: 'assistant',
                uuid: 'assistant-2',
                message: { content: 'subscribed follow-up' },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('subscribed follow-up');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('keeps following appended transcript items while the lifecycle is hot_attached even without listeners', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-claude-store-hot-attached-')));
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-hot');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-hot.jsonl');
        await writeFile(
            filePath,
            jsonlLine({
                type: 'assistant',
                uuid: 'assistant-1',
                message: { content: 'initial message' },
            }),
            'utf8',
        );

        const store = createClaudeJsonlSessionStore({
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir, projectId: 'proj-hot' },
            remoteSessionId: 'session-hot',
        });

        const initial = await store.pageOlder({ maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initial.tailCursor).toBeTruthy();

        await store.setLifecycleState('hot_attached');

        await appendFile(
            filePath,
            jsonlLine({
                type: 'assistant',
                uuid: 'assistant-2',
                message: { content: 'lifecycle follow-up' },
            }),
            'utf8',
        );

        const initialTailCursor = store.getTailCursor();
        const deadline = Date.now() + 5_000;
        while (store.getTailCursor() === initialTailCursor && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(store.getTailCursor()).not.toBe(initialTailCursor);
    });
});
