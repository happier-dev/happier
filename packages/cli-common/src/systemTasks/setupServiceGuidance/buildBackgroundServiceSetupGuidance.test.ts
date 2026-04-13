import { describe, expect, it } from 'vitest';

import type { ManagedReleaseChannelInventory } from '../../happierRuntime/deriveManagedReleaseChannelInventory.js';
import type { HappierService } from '../../happierRuntime/types.js';
import { buildBackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

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

    it('treats verified pinned daemon services as conflicting with a default-following setup target', async () => {
        const services: HappierService[] = [
            {
                id: 'launchd:com.happier.cli.daemon.company',
                serviceType: 'daemon',
                platform: 'darwin',
                backend: 'launchd',
                label: 'com.happier.cli.daemon.company',
                targetMode: 'pinned',
                verification: 'verified',
                ring: 'stable',
                instanceId: 'company',
                scope: 'user',
                definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.company.plist',
                executablePath: '/Users/tester/.happier/cli/current/happier',
                serverUrl: 'https://company.example.test',
                publicServerUrl: 'https://company.example.test',
                installed: true,
                running: true,
            },
        ];

        expect(buildBackgroundServiceSetupGuidance({
            services,
            managedReleaseChannelInventory: {
                defaultReleaseChannel: 'stable',
                managedReleaseChannels: [],
            },
            platform: 'darwin',
            mode: 'user',
            targetReleaseChannel: 'stable',
        })).toEqual(expect.objectContaining({
            exactDefaultServiceExists: false,
            shouldPromptForServiceReplacement: true,
            conflictingServices: [
                expect.objectContaining({
                    label: 'com.happier.cli.daemon.company',
                    targetMode: 'pinned',
                    serverUrl: 'https://company.example.test',
                }),
            ],
        }));
    });

    it('flags a running manual relay owner so setup can prompt for takeover before installing the background service', async () => {
        expect(buildBackgroundServiceSetupGuidance({
            services: [],
            managedReleaseChannelInventory: {
                defaultReleaseChannel: 'stable',
                managedReleaseChannels: [],
            },
            currentRelayOwner: {
                serviceManaged: false,
                publicReleaseChannel: 'stable',
                cliVersion: '0.2.0',
            },
            platform: 'darwin',
            mode: 'user',
            targetReleaseChannel: 'stable',
            targetServerUrl: 'https://relay.example.test',
        })).toEqual(expect.objectContaining({
            shouldPromptForManualRelayTakeover: true,
            manualRelayOwner: {
                currentReleaseChannel: 'stable',
                currentCliVersion: '0.2.0',
            },
        }));
    });
});
