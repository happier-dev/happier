import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { VoiceUiSection } from './VoiceUiSection';
import { VoicePresenceContainerPreview } from '@/components/voice/presence/VoicePresenceContainerPreview';

const device = vi.hoisted(() => ({ width: 1440 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: device.width, height: 844, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: device.width, height: 844, scale: 1, fontScale: 1 }) },
    });
});

// Icons are a native rendering boundary; settings controls and declarations remain real.
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('device-local Voice container selection', () => {
    it('makes real decorative preview controls browser-inert', async () => {
        // HTMLElement.inert is a browser boundary; the preview and real container/transport renderers stay real.
        const host = { inert: false };
        const screen = await renderScreen(<VoicePresenceContainerPreview container="top_bar" testID="decorative-voice-preview" />, {
            createNodeMock: (element) => {
                const props = element.props;
                return typeof props === 'object' && props !== null && 'testID' in props && props.testID === 'decorative-voice-preview'
                    ? host : null;
            },
        });
        try { expect(host.inert).toBe(true); } finally { await screen.unmount(); }
    });

    it('offers only phone containers and presents a stored Top bar as Island without writing it', async () => {
        device.width = 390;
        const setVoicePresenceContainer = vi.fn();
        const screen = await renderScreen(<VoiceUiSection voice={voiceSettingsDefaults} setVoice={vi.fn()}
            voicePresenceContainer="top_bar" setVoicePresenceContainer={setVoicePresenceContainer} />);
        try {
            const choice = screen.root.findAll((node) => node.props.testIdPrefix === 'settings.voice.ui.presenceContainer')[0];
            expect(choice?.props.options.map((option: { id: string }) => option.id)).toEqual(['island', 'orb']);
            expect(choice?.props.value).toBe('island');
            expect(setVoicePresenceContainer).not.toHaveBeenCalled();
        } finally { await screen.unmount(); device.width = 1440; }
    });
    it('sends an explicit placement choice to the local owner without mutating synced Voice settings', async () => {
        const setVoice = vi.fn();
        const setVoicePresenceContainer = vi.fn();
        const screen = await renderScreen(<VoiceUiSection voice={voiceSettingsDefaults} setVoice={setVoice}
            voicePresenceContainer="top_bar" setVoicePresenceContainer={setVoicePresenceContainer} />);
        const choice = screen.root.findAll((node) => node.props.testIdPrefix === 'settings.voice.ui.presenceContainer')[0];
        expect(choice).toBeDefined();
        expect(choice?.props.options.map((option: { id: string }) => option.id)).toEqual(['top_bar', 'island', 'orb']);
        // "Show live Voice as" shows each container itself, drawn by the real presence primitives.
        expect(choice?.props.variant).toBe('visual');
        expect(screen.root.findAll((node) => node.props.container === 'island' && node.props.testID === undefined
            && typeof node.type !== 'string').length).toBeGreaterThan(0);
        await act(async () => { choice?.props.onChange('island'); });
        expect(setVoicePresenceContainer).toHaveBeenCalledWith('island');
        expect(setVoice).not.toHaveBeenCalled();
    });
});
