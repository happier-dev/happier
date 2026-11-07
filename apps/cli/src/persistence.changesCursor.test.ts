import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

    it('performs zero settings or checkpoint publications for 100 unchanged consumed pages', async () => {
        await withTempDir('happy-cli-changes-cursor-cost-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            const { writeAccountChangesCursor, updateSettings } = await import('./persistence');
            await updateSettings(settings => ({ ...settings, chromeMode: true }));
            await writeAccountChangesCursor('acc-1', 12);
            const settingsPath = join(homeDir, 'settings.json');
            let previousInode = statSync(settingsPath).ino;
            const checkpointInode = statSync(join(homeDir, 'changes-cursors.json')).ino;
            let publications = 0;
            for (let page = 0; page < 100; page += 1) {
                await writeAccountChangesCursor('acc-1', 12);
                const inode = statSync(settingsPath).ino;
                if (inode !== previousInode) publications += 1;
                previousInode = inode;
                expect(statSync(join(homeDir, 'changes-cursors.json')).ino).toBe(checkpointInode);
            }
            expect(publications).toBe(0);
            let previousCheckpointInode = checkpointInode;
            let checkpointPublications = 0;
            for (let cursor = 13; cursor < 23; cursor += 1) {
                await writeAccountChangesCursor('acc-1', cursor);
                const inode = statSync(join(homeDir, 'changes-cursors.json')).ino;
                if (inode !== previousCheckpointInode) checkpointPublications += 1;
                previousCheckpointInode = inode;
                expect(statSync(settingsPath).ino).toBe(previousInode);
            }
            expect(checkpointPublications).toBe(10);
        });
    });

    it('checkpoints changed pages without writing settings or publishing unchanged cursors', async () => {
        await withTempDir('happy-cli-changes-cursor-', async (homeDir) => {
            vi.resetModules();
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined,
                HAPPIER_ACTIVE_SERVER_ID: undefined,
            });

            const [{ configuration }, { readAccountChangesCursor, writeAccountChangesCursor, updateSettings }] = await Promise.all([
                import('./configuration'),
                import('./persistence'),
            ]);

            await updateSettings(settings => ({ ...settings, chromeMode: true }));
            const settingsBefore = readFileSync(configuration.settingsFile, 'utf8');
            const settingsInode = statSync(configuration.settingsFile).ino;
            expect(await readAccountChangesCursor('acc-1')).toBe(0);

            await writeAccountChangesCursor('acc-1', 12);
            expect(await readAccountChangesCursor('acc-1')).toBe(12);
            expect(readFileSync(configuration.settingsFile, 'utf8')).toBe(settingsBefore);

            const checkpointPath = join(homeDir, 'changes-cursors.json');
            expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toEqual({ cloud: { 'acc-1': 12 } });
            expect(statSync(configuration.settingsFile).ino).toBe(settingsInode);
            expect(readFileSync(configuration.settingsFile, 'utf8')).toBe(settingsBefore);

            // Reset removes the entry from the checkpoint without reviving legacy state.
            await writeAccountChangesCursor('acc-1', 0);
            expect(await readAccountChangesCursor('acc-1')).toBe(0);
            expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toEqual({});
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

            const { readAccountChangesCursor, writeAccountChangesCursor } = await import('./persistence');

            expect(await readAccountChangesCursor('acc-1')).toBe(9);

            await writeAccountChangesCursor('acc-1', 12);
            const raw = JSON.parse(readFileSync(join(homeDir, 'changes-cursors.json'), 'utf8'));
            expect(raw.cloud['acc-1']).toBe(5);
            expect(raw[envServerId]['acc-1']).toBe(12);
        });
    });

    it('imports the pre-v5 single-server cursor once and preserves it across settings updates', async () => {
        await withTempDir('happy-cli-changes-cursor-legacy-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            const settingsPath = join(homeDir, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 4, onboardingCompleted: true,
                lastChangesCursorByAccountId: { 'acc-1': 8 } }));
            const { readAccountChangesCursor, writeAccountChangesCursor, updateSettings, readSettings } = await import('./persistence');
            await updateSettings(settings => ({ ...settings, chromeMode: true }));
            expect(await readAccountChangesCursor('acc-1')).toBe(8);
            expect(await readSettings()).not.toHaveProperty('lastChangesCursorByAccountId');
            expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('lastChangesCursorByServerIdByAccountId');
            await writeAccountChangesCursor('acc-1', 0);
            writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 6, onboardingCompleted: true,
                lastChangesCursorByServerIdByAccountId: { cloud: { 'acc-1': 8 } } }));
            vi.resetModules();
            expect(await (await import('./persistence')).readAccountChangesCursor('acc-1')).toBe(0);
            expect(existsSync(join(homeDir, 'changes-cursors.json'))).toBe(true);
        });
    });

    it('preserves other accounts and settings across concurrent checkpoint advances', async () => {
        await withTempDir('happy-cli-changes-cursor-concurrent-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            const { readAccountChangesCursor, writeAccountChangesCursor, updateSettings, readSettings } = await import('./persistence');
            await Promise.all([
                ...Array.from({ length: 10 }, (_, index) => writeAccountChangesCursor(`account-${index}`, index + 1)),
                updateSettings(settings => ({ ...settings, chromeMode: true })),
            ]);
            for (let index = 0; index < 10; index += 1) {
                expect(await readAccountChangesCursor(`account-${index}`)).toBe(index + 1);
            }
            expect((await readSettings()).chromeMode).toBe(true);
        });
    });

    it('clears only the selected server through auth cleanup and never restores its legacy cursor', async () => {
        await withTempDir('happy-cli-changes-cursor-clear-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({ schemaVersion: 6,
                onboardingCompleted: true, lastChangesCursorByServerIdByAccountId: {
                    cloud: { a: 7 }, other: { b: 9 },
                } }));
            const { clearServerScopedAuthState } = await import('./cli/commands/auth/clearServerScopedAuthState');
            const { readAccountChangesCursors } = await import('./persistence');
            await clearServerScopedAuthState('cloud/unsafe');
            expect(await readAccountChangesCursors()).toEqual({ other: { b: 9 } });
            vi.resetModules();
            expect(await (await import('./persistence')).readAccountChangesCursors()).toEqual({ other: { b: 9 } });
        });
    });

    it('keeps settings recovery independent of an established checkpoint', async () => {
        await withTempDir('happy-cli-changes-cursor-recovery-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            const { updateSettings, readSettings, readAccountChangesCursors } = await import('./persistence');
            await updateSettings(settings => ({ ...settings, chromeMode: true }));
            writeFileSync(join(homeDir, 'changes-cursors.json'), '{');
            await updateSettings(settings => ({ ...settings, chromeMode: false }));
            expect((await readSettings()).chromeMode).toBe(false);
            await expect(readAccountChangesCursors()).rejects.toBeInstanceOf(SyntaxError);
        });
    });

    it('imports predecessor cursors only after malformed settings are repaired', async () => {
        await withTempDir('happy-cli-changes-cursor-settings-repair-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
                HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
            const settingsPath = join(homeDir, 'settings.json');
            writeFileSync(settingsPath, '{');
            const { updateSettings, readSettings, readAccountChangesCursors } = await import('./persistence');
            await expect(updateSettings(settings => ({ ...settings, chromeMode: true }))).rejects.toBeInstanceOf(SyntaxError);
            expect(readFileSync(settingsPath, 'utf8')).toBe('{');
            expect(existsSync(join(homeDir, 'changes-cursors.json'))).toBe(false);

            writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 6,
                onboardingCompleted: true, lastChangesCursorByServerIdByAccountId: { cloud: { account: 42 } } }));
            await updateSettings(settings => ({ ...settings, chromeMode: true }));
            expect(await readSettings()).toMatchObject({ onboardingCompleted: true, chromeMode: true });
            expect(await readAccountChangesCursors()).toEqual({ cloud: { account: 42 } });
            expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('lastChangesCursorByServerIdByAccountId');
        });
    });
});
