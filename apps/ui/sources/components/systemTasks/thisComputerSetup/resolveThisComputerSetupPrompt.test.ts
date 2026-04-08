import { describe, expect, it } from 'vitest';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '../types';

function createSnapshot(promptData: SystemTaskJsonObject): SystemTaskRunState {
    return {
        taskId: 'task-1',
        status: 'running',
        currentStepId: 'setup.thisComputer.preflight.releaseChannel',
        latestMessage: 'Prompt message',
        awaitingInput: true,
        cancelRequested: false,
        events: [{
            protocolVersion: 1,
            taskId: 'task-1',
            tsMs: 100,
            type: 'prompt',
            stepId: 'setup.thisComputer.preflight.releaseChannel',
            message: 'Prompt message',
            data: promptData as SystemTaskJsonObject,
        }],
        result: null,
    };
}

describe('resolveThisComputerSetupPrompt', () => {
    it('parses release-channel switch prompts', async () => {
        const { resolveThisComputerSetupPrompt } = await import('./resolveThisComputerSetupPrompt');

        expect(resolveThisComputerSetupPrompt(createSnapshot({
            kind: 'releaseChannel.switchDefaultForSetup',
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
        const { resolveThisComputerSetupPrompt } = await import('./resolveThisComputerSetupPrompt');

        expect(resolveThisComputerSetupPrompt(createSnapshot({
            kind: 'daemon.replaceLocalBackgroundServices',
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.cli.daemon.preview.default',
                releaseChannel: 'preview',
                targetMode: 'pinned',
                running: true,
                serverUrl: 'https://relay.example.test',
            }],
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
});
