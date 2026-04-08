import { describe, expect, it } from 'vitest';

import type { ManagedReleaseChannelInventory } from '../../happierRuntime/deriveManagedReleaseChannelInventory.js';
import type { HappierService } from '../../happierRuntime/types.js';

describe('buildBackgroundServiceSetupGuidance', () => {
    it('flags default release-channel drift and conflicting background services for guided setup', async () => {
        const services: HappierService[] = [
            {
                id: 'launchd:com.happier.cli.daemon.default',
                serviceType: 'daemon',
                platform: 'darwin',
                backend: 'launchd',
                label: 'com.happier.cli.daemon.default',
                targetMode: 'default-following',
                verification: 'verified',
                ring: 'stable',
                instanceId: null,
                scope: 'user',
                definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
                executablePath: '/Users/tester/.happier/cli/current/happier',
                installed: true,
                running: true,
            },
        ];
        const managedReleaseChannels: ManagedReleaseChannelInventory = {
            defaultReleaseChannel: 'stable',
            managedReleaseChannels: [
                {
                    releaseChannel: 'stable',
                    label: 'stable',
                    version: '0.2.2',
                    installationId: 'stable-install',
                    installationPath: '/Users/tester/.happier/cli/current',
                    invokerName: 'happier',
                    isDefault: true,
                    onPath: true,
                },
                {
                    releaseChannel: 'preview',
                    label: 'preview',
                    version: '0.2.3-preview.1',
                    installationId: 'preview-install',
                    installationPath: '/Users/tester/.happier/cli-preview/current',
                    invokerName: 'hprev',
                    isDefault: false,
                    onPath: true,
                },
            ],
        };

        const { buildBackgroundServiceSetupGuidance } = await import('./buildBackgroundServiceSetupGuidance.js');
        expect(buildBackgroundServiceSetupGuidance({
            services,
            managedReleaseChannelInventory: managedReleaseChannels,
            platform: 'darwin',
            mode: 'user',
            targetReleaseChannel: 'preview',
        })).toEqual(expect.objectContaining({
            currentDefaultReleaseChannel: 'stable',
            shouldOfferDefaultReleaseChannelSwitch: true,
            shouldPromptForServiceReplacement: false,
            exactDefaultServiceExists: true,
            conflictingServices: [],
        }));
    });

    it('keeps setup quiet when the default release-channel already matches and no conflicting services exist', async () => {
        const managedReleaseChannels: ManagedReleaseChannelInventory = {
            defaultReleaseChannel: 'preview',
            managedReleaseChannels: [
                {
                    releaseChannel: 'preview',
                    label: 'preview',
                    version: '0.2.3-preview.1',
                    installationId: 'preview-install',
                    installationPath: '/Users/tester/.happier/cli-preview/current',
                    invokerName: 'hprev',
                    isDefault: true,
                    onPath: true,
                },
            ],
        };

        const { buildBackgroundServiceSetupGuidance } = await import('./buildBackgroundServiceSetupGuidance.js');
        expect(buildBackgroundServiceSetupGuidance({
            services: [],
            managedReleaseChannelInventory: managedReleaseChannels,
            platform: 'darwin',
            mode: 'user',
            targetReleaseChannel: 'preview',
        })).toEqual(expect.objectContaining({
            currentDefaultReleaseChannel: 'preview',
            exactDefaultServiceExists: false,
            shouldOfferDefaultReleaseChannelSwitch: false,
            shouldPromptForServiceReplacement: false,
            conflictingServices: [],
        }));
    });
});
