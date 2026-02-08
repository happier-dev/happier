import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deriveServerIdFromUrl(url: string): string {
    let h = 2166136261;
    for (let i = 0; i < url.length; i += 1) {
        h ^= url.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
}

describe('changes cursor persistence', () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    afterEach(() => {
        if (previousHomeDir === undefined) {
            delete process.env.HAPPIER_HOME_DIR;
        } else {
            process.env.HAPPIER_HOME_DIR = previousHomeDir;
        }
        if (previousServerUrl === undefined) {
            delete process.env.HAPPIER_SERVER_URL;
        } else {
            process.env.HAPPIER_SERVER_URL = previousServerUrl;
        }
        if (previousWebappUrl === undefined) {
            delete process.env.HAPPIER_WEBAPP_URL;
        } else {
            process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
        }
    });

    it('roundtrips lastChangesCursorByServerIdByAccountId via settings file', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-changes-cursor-'));

        vi.resetModules();
        process.env.HAPPIER_HOME_DIR = homeDir;
        delete process.env.HAPPIER_SERVER_URL;
        delete process.env.HAPPIER_WEBAPP_URL;

        try {
            const [{ configuration }, { readLastChangesCursor, writeLastChangesCursor }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            expect(await readLastChangesCursor('acc-1')).toBe(0);

            await writeLastChangesCursor('acc-1', 12);
            expect(await readLastChangesCursor('acc-1')).toBe(12);

            const raw = JSON.parse(readFileSync(configuration.settingsFile, 'utf8'));
            expect(raw.lastChangesCursorByServerIdByAccountId).toEqual({ official: { 'acc-1': 12 } });

            // Writing 0 removes the entry to keep settings small.
            await writeLastChangesCursor('acc-1', 0);
            expect(await readLastChangesCursor('acc-1')).toBe(0);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('reads and writes cursor using effective active server id from env override', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-changes-cursor-override-'));
        const serverUrl = 'http://127.0.0.1:12345';
        const envServerId = deriveServerIdFromUrl(serverUrl);

        vi.resetModules();
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_SERVER_URL = serverUrl;
        process.env.HAPPIER_WEBAPP_URL = serverUrl;

        try {
            const settingsPath = join(homeDir, 'settings.json');
            const seed = {
                schemaVersion: 5,
                onboardingCompleted: true,
                activeServerId: 'official',
                servers: {
                    official: {
                        id: 'official',
                        name: 'official',
                        serverUrl: 'https://api.happier.dev',
                        webappUrl: 'https://app.happier.dev',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                },
                machineIdByServerId: {},
                machineIdConfirmedByServerByServerId: {},
                lastChangesCursorByServerIdByAccountId: {
                    official: { 'acc-1': 5 },
                    [envServerId]: { 'acc-1': 9 },
                },
            };
            writeFileSync(settingsPath, JSON.stringify(seed, null, 2), 'utf8');

            const { readLastChangesCursor, writeLastChangesCursor } = await import('./persistence');

            expect(await readLastChangesCursor('acc-1')).toBe(9);

            await writeLastChangesCursor('acc-1', 12);
            const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
            expect(raw.lastChangesCursorByServerIdByAccountId.official['acc-1']).toBe(5);
            expect(raw.lastChangesCursorByServerIdByAccountId[envServerId]['acc-1']).toBe(12);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
