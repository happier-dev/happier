import { describe, expect, it } from 'vitest';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';

import type { SystemTaskPromptEnvelope } from './readLatestSystemTaskPrompt';

function createPromptEnvelope(params: Readonly<{
    kind: string;
    data: SystemTaskJsonObject;
}>): SystemTaskPromptEnvelope {
    return {
        kind: params.kind,
        message: 'Prompt message',
        data: params.data,
    };
}

describe('resolveBackgroundServiceSetupPrompt', () => {
    it('parses release-channel switch prompts', async () => {
        const { resolveReleaseChannelSwitchSetupPrompt } = await import('./resolveBackgroundServiceSetupPrompt');

        expect(resolveReleaseChannelSwitchSetupPrompt(createPromptEnvelope({
            kind: 'releaseChannel.switchDefaultForSetup',
            data: {
                targetReleaseChannel: 'preview',
                currentDefaultReleaseChannel: 'stable',
                targetServerUrl: 'https://relay.example.test',
                managedReleaseChannels: [{
                    releaseChannel: 'preview',
                    label: 'preview',
                    version: '0.2.3-preview.1',
                    installationId: 'preview-install',
                    installationPath: '/managed/preview',
                    invokerName: 'hprev',
                    isDefault: false,
                    onPath: true,
                }],
            },
        }))).toEqual({
            kind: 'releaseChannel.switchDefaultForSetup',
            message: 'Prompt message',
            targetReleaseChannel: 'preview',
            currentDefaultReleaseChannel: 'stable',
            targetServerUrl: 'https://relay.example.test',
            managedReleaseChannels: [{
                releaseChannel: 'preview',
                label: 'preview',
                version: '0.2.3-preview.1',
                installationId: 'preview-install',
                installationPath: '/managed/preview',
                invokerName: 'hprev',
                isDefault: false,
                onPath: true,
            }],
        });
    });

    it('parses local background-service replacement prompts', async () => {
        const { resolveBackgroundServiceReplacementPrompt } = await import('./resolveBackgroundServiceSetupPrompt');

        expect(resolveBackgroundServiceReplacementPrompt(createPromptEnvelope({
            kind: 'daemon.replaceLocalBackgroundServices',
            data: {
                targetServerUrl: 'https://relay.example.test',
                targetReleaseChannel: 'preview',
                services: [{
                    label: 'com.happier.cli.daemon.preview.default',
                    releaseChannel: 'preview',
                    targetMode: 'pinned',
                    running: true,
                    serverUrl: 'https://relay.example.test',
                }],
            },
        }))).toEqual({
            kind: 'daemon.replaceLocalBackgroundServices',
            message: 'Prompt message',
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.cli.daemon.preview.default',
                releaseChannel: 'preview',
                targetMode: 'pinned',
                running: true,
                serverUrl: 'https://relay.example.test',
            }],
        });
    });

    it('parses remote background-service replacement prompts', async () => {
        const { resolveBackgroundServiceReplacementPrompt } = await import('./resolveBackgroundServiceSetupPrompt');

        expect(resolveBackgroundServiceReplacementPrompt(createPromptEnvelope({
            kind: 'daemon.replaceRemoteBackgroundServices',
            data: {
                targetServerUrl: 'https://relay.example.test',
                targetReleaseChannel: 'preview',
                services: [{
                    label: 'com.happier.remote.preview.default',
                    releaseChannel: 'preview',
                    targetMode: 'default-following',
                    running: false,
                }],
            },
        }))).toEqual({
            kind: 'daemon.replaceRemoteBackgroundServices',
            message: 'Prompt message',
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.remote.preview.default',
                releaseChannel: 'preview',
                targetMode: 'default-following',
                running: false,
            }],
        });
    });
});
