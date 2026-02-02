import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('changes cursor persistence', () => {
    const previousHomeDir = process.env.HAPPY_HOME_DIR;

    afterEach(() => {
        process.env.HAPPY_HOME_DIR = previousHomeDir;
    });

    it('roundtrips lastChangesCursorByAccountId via settings file', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-changes-cursor-'));

        vi.resetModules();
        process.env.HAPPY_HOME_DIR = homeDir;

        const [{ configuration }, { readLastChangesCursor, writeLastChangesCursor }] = await Promise.all([
            import('./configuration'),
            import('./persistence'),
        ]);

        expect(await readLastChangesCursor('acc-1')).toBe(0);

        await writeLastChangesCursor('acc-1', 12);
        expect(await readLastChangesCursor('acc-1')).toBe(12);

        const raw = JSON.parse(readFileSync(configuration.settingsFile, 'utf8'));
        expect(raw.lastChangesCursorByAccountId).toEqual({ 'acc-1': 12 });

        // Writing 0 removes the entry to keep settings small.
        await writeLastChangesCursor('acc-1', 0);
        expect(await readLastChangesCursor('acc-1')).toBe(0);
    });
});

