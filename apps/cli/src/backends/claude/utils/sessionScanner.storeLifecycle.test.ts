import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';
import { getProjectPath } from './path';

vi.mock('@/integrations/watcher/startFileWatcher', () => ({
    startFileWatcher: vi.fn(() => () => {}),
}));

import { createSessionScanner } from './sessionScanner';

async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 25): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('sessionScanner store lifecycle', () => {
    let testDir: string | null = null;
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null;

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
            testDir = null;
        }
    });

    it('replays canonical appends through the raw-message store even when watcher callbacks do not fire', async () => {
        testDir = await mkdtemp(join(tmpdir(), 'happier-claude-scanner-store-'));
        const claudeConfigDir = join(testDir, '.claude');
        const projectDir = getProjectPath(testDir, claudeConfigDir);
        await mkdir(projectDir, { recursive: true });

        const sessionId = 'session-store-lifecycle';
        const sessionFile = join(projectDir, `${sessionId}.jsonl`);
        const collectedMessages: RawJSONLines[] = [];

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'user',
                uuid: 'user-1',
                message: { content: 'canonical history' },
            }) + '\n',
            'utf8',
        );

        scanner = await createSessionScanner({
            sessionId: null,
            workingDirectory: testDir,
            claudeConfigDir,
            onMessage: (message) => {
                collectedMessages.push(message);
            },
        });

        scanner.onNewSession(sessionId);
        await waitFor(() => collectedMessages.length === 1);

        await appendFile(
            sessionFile,
            JSON.stringify({
                type: 'assistant',
                uuid: 'assistant-2',
                message: { content: 'store-backed follow-up' },
            }) + '\n',
            'utf8',
        );

        await waitFor(() => collectedMessages.length === 2);

        expect(collectedMessages[0]).toMatchObject({
            type: 'user',
            uuid: 'user-1',
        });
        expect(collectedMessages[1]).toMatchObject({
            type: 'assistant',
            uuid: 'assistant-2',
        });
    });
});
