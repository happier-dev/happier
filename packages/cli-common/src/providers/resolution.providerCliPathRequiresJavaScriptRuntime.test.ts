import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn(() => {
    throw new Error('readFileSync should not be used for provider CLI header checks');
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        readFileSync: readFileSyncMock,
    };
});

afterEach(() => {
    readFileSyncMock.mockClear();
});

describe('providerCliPathRequiresJavaScriptRuntime', () => {
    it('detects unix node shebang without calling readFileSync on the full file', async () => {
        if (process.platform === 'win32') return;

        const fixtureDir = await mkdtemp(join(tmpdir(), 'happier-provider-cli-shebang-'));
        try {
            const scriptPath = join(fixtureDir, 'claude');
            await writeFile(scriptPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');

            vi.resetModules();
            const { providerCliPathRequiresJavaScriptRuntime } = await import('./resolution');

            expect(providerCliPathRequiresJavaScriptRuntime(scriptPath)).toBe(true);
            expect(readFileSyncMock).not.toHaveBeenCalled();
        } finally {
            await rm(fixtureDir, { recursive: true, force: true });
        }
    });
});
