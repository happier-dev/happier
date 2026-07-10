import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.hoisted(() => vi.fn(() => {
    throw new Error('readFileSync should not be used for agent CLI header checks');
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        readFileSync: readFileSyncMock,
    };
});

import { agentCliPathRequiresJavaScriptRuntime } from './resolution.js';

afterEach(() => {
    readFileSyncMock.mockClear();
});

describe('agentCliPathRequiresJavaScriptRuntime', () => {
    it('detects unix node shebang without calling readFileSync on the full file', async () => {
        if (process.platform === 'win32') return;

        const fixtureDir = await mkdtemp(join(tmpdir(), 'happier-provider-cli-shebang-'));
        try {
            const scriptPath = join(fixtureDir, 'claude');
            await writeFile(scriptPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');

            expect(agentCliPathRequiresJavaScriptRuntime(scriptPath)).toBe(true);
            expect(readFileSyncMock).not.toHaveBeenCalled();
        } finally {
            await rm(fixtureDir, { recursive: true, force: true });
        }
    });
});
