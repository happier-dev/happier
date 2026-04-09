import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => {
            if (key === 'machine.backgroundServiceModes.defaultFollowing') return 'default background service';
            if (key === 'machine.backgroundServiceModes.legacyPinned') return 'legacy pinned background service';
            if (key === 'machine.backgroundServiceModes.generic') return 'background service';
            if (key === 'machine.backgroundServicePrompt.targetServer') return 'Serveur cible';
            if (key === 'machine.backgroundServicePrompt.targetReleaseChannel') return 'Canal cible';
            if (key === 'machine.backgroundServicePrompt.existingServices') return 'Services existants :';
            if (key === 'machine.backgroundServicePrompt.running') return 'actif';
            return key;
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/forms/MachineSetupTextField', () => ({
    MachineSetupTextField: (props: Record<string, unknown>) => React.createElement('MachineSetupTextField', props),
}));

vi.mock('./styles', () => ({
    remoteSshChecklistStyles: {
        promptCard: { gap: 8 },
        promptTitle: {},
        promptBody: {},
    },
}));

describe('RemoteSshChecklistPromptCard', () => {
    it('humanizes conflicting background service modes for remote replacement prompts', async () => {
        const { RemoteSshChecklistPromptCard } = await import('./RemoteSshChecklistPromptCard');

        const screen = await renderScreen(
            React.createElement(RemoteSshChecklistPromptCard, {
                testID: 'remote-ssh-prompt',
                password: '',
                isStarting: false,
                onChangePassword: () => undefined,
                prompt: {
                    kind: 'daemon.replaceRemoteBackgroundServices',
                    message: 'Replace existing remote background services?',
                    targetServerUrl: 'https://relay.example.test',
                    targetReleaseChannel: 'preview',
                    services: [{
                        label: 'happier-daemon.stable',
                        releaseChannel: 'stable',
                        targetMode: 'pinned',
                        running: true,
                    }],
                },
            }),
        );

        const textNodes = screen.tree.findAllByType('Text' as any);
        const body = textNodes.map((node: any) => node.props.children).filter((value: unknown) => typeof value === 'string').join('\n');
        expect(body).toContain('Serveur cible: https://relay.example.test');
        expect(body).toContain('Canal cible: preview');
        expect(body).toContain('Services existants :');
        expect(body).toContain('legacy pinned background service');
        expect(body).toContain('actif');
        expect(body).not.toContain('default-following');
        expect(body).not.toContain('(stable, pinned)');
    });
});
