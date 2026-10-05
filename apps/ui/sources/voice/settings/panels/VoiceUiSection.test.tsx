import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { VoiceUiSection } from './VoiceUiSection';

// Icons are a native rendering boundary; settings controls and declarations remain real.
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('VoiceUiSection synced siblings', () => {
    it('changes the transcript preference through the synced Voice owner', async () => {
        const setVoice = vi.fn();
        const voice = { ...voiceSettingsDefaults, ui: { ...voiceSettingsDefaults.ui, activityFeedEnabled: false } };
        const screen = await renderScreen(<VoiceUiSection voice={voice} setVoice={setVoice}
            voicePresenceContainer="top_bar" setVoicePresenceContainer={() => {}} />);
        const toggle = screen.root.findAll((node) => node.props.testID === 'settings.voice.ui.activityFeedEnabled'
            && typeof node.props.onValueChange === 'function')[0];
        expect(toggle).toBeDefined();
        await act(async () => { toggle?.props.onValueChange(true); });
        expect(setVoice).toHaveBeenCalledWith({ ...voice, ui: { ...voice.ui, activityFeedEnabled: true } });
    });

    it('retains both start-scope choices without treating scope as placement', async () => {
        const setVoice = vi.fn();
        const voice = { ...voiceSettingsDefaults, ui: { ...voiceSettingsDefaults.ui, scopeDefault: 'global' as const } };
        const screen = await renderScreen(<VoiceUiSection voice={voice} setVoice={setVoice}
            voicePresenceContainer="island" setVoicePresenceContainer={() => {}} />);
        const scope = screen.root.findAll((node) => node.props.testIDPrefix === 'settings.voice.ui.scopeDefault')[0];
        expect(scope?.props.options.map((option: { id: string }) => option.id)).toEqual(['global', 'session']);
        await act(async () => { scope?.props.onChange('session'); });
        expect(setVoice).toHaveBeenCalledWith({ ...voice, ui: { ...voice.ui, scopeDefault: 'session' } });
    });

    it('keeps "Open it when a conversation starts" visible but locked while the transcript is hidden', async () => {
        const voice = { ...voiceSettingsDefaults, ui: { ...voiceSettingsDefaults.ui, activityFeedEnabled: false } };
        const screen = await renderScreen(<VoiceUiSection voice={voice} setVoice={vi.fn()}
            voicePresenceContainer="top_bar" setVoicePresenceContainer={() => {}} />);
        const autoOpen = screen.root.findAll((node) => node.props.testID === 'settings.voice.ui.activityFeedAutoExpandOnStart');
        expect(autoOpen.length).toBeGreaterThan(0);
        expect(autoOpen.some((node) => node.props.disabled === true)).toBe(true);
    });
});
