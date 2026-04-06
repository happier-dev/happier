import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProjectPath } from '../../utils/path';
import { clearClaudeRawJsonlSessionStoreRegistriesForTests } from '../sessionStore';
import { createClaudeScannerMainTranscriptStoreLifecycle } from './createClaudeScannerMainTranscriptStoreLifecycle';

describe('createClaudeScannerMainTranscriptStoreLifecycle', () => {
    let workingDirectory: string;
    let claudeConfigDir: string;
    let projectDir: string;
    let lifecycle: ReturnType<typeof createClaudeScannerMainTranscriptStoreLifecycle> | null = null;

    beforeEach(async () => {
        workingDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-scanner-store-lifecycle-'));
        claudeConfigDir = join(workingDirectory, 'claude-config');
        projectDir = getProjectPath(workingDirectory, claudeConfigDir);
        await mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        if (lifecycle) {
            await lifecycle.cleanup();
            lifecycle = null;
        }
        clearClaudeRawJsonlSessionStoreRegistriesForTests();
        if (existsSync(workingDirectory)) {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('uses the store for canonical main transcripts and fences explicit noncanonical transcript paths as exceptions', async () => {
        const sessionId = '11111111-2222-3333-4444-555555555555';
        const canonicalTranscriptPath = join(projectDir, `${sessionId}.jsonl`);
        await writeFile(
            canonicalTranscriptPath,
            JSON.stringify({ type: 'user', uuid: 'canonical-user', message: { content: 'hello from canonical store path' } }) + '\n',
            'utf8',
        );

        lifecycle = createClaudeScannerMainTranscriptStoreLifecycle({
            workingDirectory,
            claudeConfigDir,
            invalidate: () => {},
        });

        await expect(lifecycle.sync(sessionId, null)).resolves.toBe(true);
        expect(lifecycle.hasStoreLease(sessionId)).toBe(true);

        const canonicalRead = await lifecycle.readNext(sessionId, canonicalTranscriptPath);
        expect(canonicalRead.initialized).toBe(true);
        expect(canonicalRead.items).toHaveLength(1);

        await lifecycle.release(sessionId);
        expect(lifecycle.hasStoreLease(sessionId)).toBe(false);

        await expect(lifecycle.sync(sessionId, canonicalTranscriptPath)).resolves.toBe(true);
        expect(lifecycle.hasStoreLease(sessionId)).toBe(true);

        await lifecycle.release(sessionId);
        expect(lifecycle.hasStoreLease(sessionId)).toBe(false);

        const overrideDir = join(workingDirectory, 'alt-project');
        await mkdir(overrideDir, { recursive: true });
        const overrideTranscriptPath = join(overrideDir, `${sessionId}.jsonl`);
        await writeFile(
            overrideTranscriptPath,
            JSON.stringify({ type: 'user', uuid: 'override-user', message: { content: 'hello from override path' } }) + '\n',
            'utf8',
        );

        await expect(lifecycle.sync(sessionId, overrideTranscriptPath)).resolves.toBe(false);
        expect(lifecycle.hasStoreLease(sessionId)).toBe(false);
    });
});
