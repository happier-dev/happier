import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSessionScanner } from './sessionScanner';
import { getProjectPath } from './path';
import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';
import { clearClaudeRawJsonlSessionStoreRegistriesForTests } from '../transcripts/sessionStore';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('sessionScanner — informational system subtypes', () => {
    let testDir: string;
    let projectDir: string;
    let collected: RawJSONLines[];
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null;
    let originalClaudeConfigDir: string | undefined;

    beforeEach(async () => {
        testDir = join(tmpdir(), `scanner-system-filter-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(testDir, 'claude-config');
        projectDir = getProjectPath(testDir);
        await mkdir(projectDir, { recursive: true });
        collected = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
        clearClaudeRawJsonlSessionStoreRegistriesForTests();
    });

    it('drops stop_hook_summary and away_summary system messages but forwards user/assistant messages', async () => {
        scanner = await createSessionScanner({
            sessionId: null,
            workingDirectory: testDir,
            onMessage: (msg) => collected.push(msg),
        });

        const sessionId = 'session-informational-system-1';
        const sessionFile = join(projectDir, `${sessionId}.jsonl`);

        const lines = [
            { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
            {
                type: 'system',
                subtype: 'stop_hook_summary',
                uuid: 'sys-stop-1',
                hookCount: 1,
                hookInfos: [],
                hookErrors: [],
                preventedContinuation: false,
                stopReason: '',
            },
            {
                type: 'system',
                subtype: 'away_summary',
                uuid: 'sys-away-1',
                content: 'session recap',
            },
            { type: 'user', uuid: 'u2', message: { role: 'user', content: 'follow up' } },
        ];

        await writeFile(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        scanner.onNewSession(sessionId);

        await waitFor(() => collected.length >= 3);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const types = collected.map((m) => m.type);
        expect(types).toEqual(['user', 'assistant', 'user']);
        expect(collected.some((m) => m.type === 'system')).toBe(false);
    });

    it('drops system messages regardless of subtype (including previously unknown ones)', async () => {
        scanner = await createSessionScanner({
            sessionId: null,
            workingDirectory: testDir,
            onMessage: (msg) => collected.push(msg),
        });

        const sessionId = 'session-informational-system-2';
        const sessionFile = join(projectDir, `${sessionId}.jsonl`);

        const lines = [
            { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
            {
                type: 'system',
                subtype: 'init',
                uuid: 'sys-init-1',
                session_id: sessionId,
                tools: [],
            },
            {
                type: 'system',
                subtype: 'some_future_subtype',
                uuid: 'sys-future-1',
            },
        ];

        await writeFile(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        scanner.onNewSession(sessionId);

        await waitFor(() => collected.length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 100));

        // All `type: system` messages are informational side-channels and are filtered here so the
        // server/UI never have to classify them. If a future subtype needs to render, opt it in
        // explicitly — do not relax this default.
        expect(collected.map((m) => m.type)).toEqual(['user']);
        expect(collected.some((m) => m.type === 'system')).toBe(false);
    });
});
