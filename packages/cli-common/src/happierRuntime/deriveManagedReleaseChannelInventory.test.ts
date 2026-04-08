import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { HappierInstallationInventory } from './types';

describe('deriveManagedReleaseChannelInventory', () => {
    it('derives installed managed release channels from the canonical installation inventory', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-release-channel-inventory-'));
        const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };
        await writeFile(
            join(homeDir, 'default-cli-release-channel.json'),
            `${JSON.stringify({ releaseChannel: 'preview' })}\n`,
            'utf8',
        );

        const inventory: HappierInstallationInventory = {
            activeInvocation: null,
            installations: [
                {
                    id: 'managed:stable:/Users/tester/.happier/cli/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '0.2.0',
                    path: '/Users/tester/.happier/cli/current',
                    realPath: '/Users/tester/.happier/cli/versions/0.2.0',
                    shimName: 'happier',
                    onPath: true,
                    managedRoot: '/Users/tester/.happier/cli',
                },
                {
                    id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'preview',
                    version: '0.2.3-preview.1',
                    path: '/Users/tester/.happier/cli-preview/current',
                    realPath: '/Users/tester/.happier/cli-preview/versions/0.2.3-preview.1',
                    shimName: 'hprev',
                    onPath: true,
                    managedRoot: '/Users/tester/.happier/cli-preview',
                },
                {
                    id: 'npm-global:@happier-dev/cli',
                    source: 'npmGlobal',
                    components: ['happier-cli'],
                    ring: null,
                    version: '0.2.1',
                    path: '/usr/local/lib/node_modules/@happier-dev/cli',
                    realPath: '/usr/local/lib/node_modules/@happier-dev/cli',
                    shimName: 'happier',
                    onPath: true,
                    managedRoot: null,
                },
            ],
        };

        const { deriveManagedReleaseChannelInventory } = await import('./deriveManagedReleaseChannelInventory.js');
        await expect(deriveManagedReleaseChannelInventory({ inventory, processEnv })).resolves.toEqual({
            defaultReleaseChannel: 'preview',
            managedReleaseChannels: [
                {
                    releaseChannel: 'stable',
                    label: 'stable',
                    version: '0.2.0',
                    installationId: 'managed:stable:/Users/tester/.happier/cli/current',
                    installationPath: '/Users/tester/.happier/cli/current',
                    invokerName: 'happier',
                    isDefault: false,
                    onPath: true,
                },
                {
                    releaseChannel: 'preview',
                    label: 'preview',
                    version: '0.2.3-preview.1',
                    installationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    installationPath: '/Users/tester/.happier/cli-preview/current',
                    invokerName: 'hprev',
                    isDefault: true,
                    onPath: true,
                },
            ],
        });

        await rm(homeDir, { recursive: true, force: true });
    });
});
