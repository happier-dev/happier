import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('changes cursor persistence', () => {
    const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
    let envScope = createEnvKeyScope(envKeys);

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
    });

    it('roundtrips lastChangesCursorByServerIdByAccountId via settings file', async () => {
        await withTempDir('happy-cli-changes-cursor-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_ACTIVE_SERVER_ID: undefined,
            });

            const [{ configuration }, { readLastChangesCursor, writeLastChangesCursor }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            expect(await readLastChangesCursor('acc-1')).toBe(0);

            await writeLastChangesCursor('acc-1', 12);
            expect(await readLastChangesCursor('acc-1')).toBe(12);

            const raw = JSON.parse(readFileSync(configuration.settingsFile, 'utf8'));
            expect(raw.lastChangesCursorByServerIdByAccountId).toEqual({ cloud: { 'acc-1': 12 } });

            // Writing 0 removes the entry to keep settings small.
            await writeLastChangesCursor('acc-1', 0);
            expect(await readLastChangesCursor('acc-1')).toBe(0);
        });
    });

    it('reads and writes cursor using effective active server id from env override', async () => {
        await withTempDir('happy-cli-changes-cursor-override-', async (homeDir) => {
            const serverUrl = 'http://127.0.0.1:12345';

            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_SERVER_URL: serverUrl,
                HAPPIER_WEBAPP_URL: serverUrl,
                HAPPIER_ACTIVE_SERVER_ID: undefined,
            });

            const { configuration } = await import('./configuration');
            const envServerId = configuration.activeServerId;
            expect(envServerId).not.toBe('cloud');

            const settingsPath = join(homeDir, 'settings.json');
            const seed = {
                schemaVersion: 5,
                onboardingCompleted: true,
                activeServerId: 'cloud',
                servers: {
                    cloud: {
                        id: 'cloud',
                        name: 'cloud',
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
                    cloud: { 'acc-1': 5 },
                    [envServerId]: { 'acc-1': 9 },
                },
            };
            writeFileSync(settingsPath, JSON.stringify(seed, null, 2), 'utf8');

            const { readLastChangesCursor, writeLastChangesCursor } = await import('./persistence');

            expect(await readLastChangesCursor('acc-1')).toBe(9);

            await writeLastChangesCursor('acc-1', 12);
            const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
            expect(raw.lastChangesCursorByServerIdByAccountId.cloud['acc-1']).toBe(5);
            expect(raw.lastChangesCursorByServerIdByAccountId[envServerId]['acc-1']).toBe(12);
        });
    });
});
