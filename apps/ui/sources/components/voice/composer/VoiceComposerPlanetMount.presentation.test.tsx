import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookCalls = vi.hoisted(() => ({ energy: 0, control: 0 }));

vi.mock('@/components/voice/light/useVoiceEnergy', () => ({
    useVoiceEnergyIfMounted: () => {
        hookCalls.energy += 1;
        React.useState(0);
        React.useState(0);
        return { luminosity: 0, energized: false, direction: 'none' };
    },
}));

vi.mock('@/components/voice/attempt/useVoiceAttemptControl', () => ({
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: { kind: 'global' },
    useVoiceAttemptControl: () => {
        hookCalls.control += 1;
        React.useState(0);
        return {
            availability: 'available',
            canStop: false,
            muted: false,
            primaryAction: 'start',
            primaryActionHint: 'hint',
            primaryActionLabel: 'label',
            stop: vi.fn(),
            onPrimaryAction: vi.fn(),
        };
    },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./VoiceComposerPlanet', () => ({
    VoiceComposerPlanet: () => React.createElement('VoiceComposerPlanet'),
}));

import { VoiceComposerPlanetMount } from './VoiceComposerPlanetMount';

describe('VoiceComposerPlanetMount retained presentation', () => {
    beforeEach(() => {
        hookCalls.energy = 0;
        hookCalls.control = 0;
    });

    it('unmounts energy and attempt subscriptions across presented → hidden → presented', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<VoiceComposerPlanetMount sessionId="session-1" isPresented />);
        });

        expect(hookCalls).toEqual({ energy: 1, control: 1 });
        expect(tree!.root.findByType('VoiceComposerPlanet')).toBeTruthy();

        act(() => {
            tree!.update(<VoiceComposerPlanetMount sessionId="session-1" isPresented={false} />);
        });

        expect(hookCalls).toEqual({ energy: 1, control: 1 });
        expect(tree!.toJSON()).toBeNull();

        act(() => {
            tree!.update(<VoiceComposerPlanetMount sessionId="session-1" isPresented />);
        });

        expect(hookCalls).toEqual({ energy: 2, control: 2 });
        expect(tree!.root.findByType('VoiceComposerPlanet')).toBeTruthy();

        act(() => tree!.unmount());
    });
});
