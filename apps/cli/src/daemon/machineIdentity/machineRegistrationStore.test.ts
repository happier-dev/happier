import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { readSettings, updateSettings } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readMachineRegistration, readRegisteredMachineId, updateMachineRegistration } from './machineRegistrationStore';

it('transfers released Machine identity before settings publication and never revives a cleared registration', async () => {
    await withTempDir('happier-registration-upgrade-', async homeDir => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        try {
            env.patch({ HAPPIER_HOME_DIR: homeDir });
            reloadConfiguration();
            const settingsPath = join(homeDir, 'settings.json');
            const released = {
                schemaVersion: 6, onboardingCompleted: false,
                machineIdByServerId: { primary: 'primary-machine', secondary: 'secondary-machine' },
                machineIdByServerIdByAccountId: { primary: { account: 'primary-machine', other: 'other-machine' } },
                lastTokenSubByServerId: { primary: 'account' },
                machineIdConfirmedByServerByServerId: { primary: true },
                machineReplacementCandidatesByServerIdByAccountId: { primary: {
                    account: { machineId: 'predecessor', replacementReason: 'reauth', createdAt: 1 },
                } },
            };
            await writeFile(settingsPath, JSON.stringify(released));
            await updateSettings(current => ({ ...current, onboardingCompleted: true }));
            const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
            for (const key of Object.keys(released).filter(key => /machine|lastToken/.test(key))) {
                expect(persisted).not.toHaveProperty(key);
            }
            expect((await readSettings()).onboardingCompleted).toBe(true);
            expect(await readMachineRegistration('primary')).toEqual({
                machineId: 'primary-machine', machineIdByAccountId: { account: 'primary-machine', other: 'other-machine' },
                accountId: 'account', confirmedByServer: true,
                replacementCandidates: { account: { machineId: 'predecessor', replacementReason: 'reauth', createdAt: 1 } },
            });
            expect(await readRegisteredMachineId('primary', 'missing')).toBeNull();
            expect(await readRegisteredMachineId('secondary', null)).toBe('secondary-machine');
            await updateMachineRegistration(() => ({}), 'primary');
            await writeFile(settingsPath, JSON.stringify(released));
            expect(await readRegisteredMachineId('primary', 'account')).toBeNull();
        } finally {
            env.restore();
            reloadConfiguration();
        }
    });
});
