import { describe, expect, it } from 'vitest';

import type { PluginVoiceSpeechRuntimeRegistration } from '@happier-dev/plugin-sdk/runtime';

import { createTargetVoiceSpeechRegistry } from './targetVoiceSpeech';

const runtime = Object.freeze({}) as PluginVoiceSpeechRuntimeRegistration;

describe('target Voice speech registry', () => {
    it('reads only the current speech registration directly from target registrations', () => {
        let current = true;
        const entry = Object.freeze({
            pluginId: 'acme.speech',
            generation: '7',
            registration: Object.freeze({ family: 'voiceProviders.speech' as const, localId: 'main', value: runtime }),
        });
        const targetRegistrations = [entry];
        const registry = createTargetVoiceSpeechRegistry({
            generation: 7,
            targetRegistrations,
            isGenerationActive: () => current,
        });

        const resolved = registry.read({ pluginId: 'acme.speech', localId: 'main' });
        expect(resolved).toMatchObject({ generation: '7', qualifiedId: 'acme.speech/main', runtime });
        expect(resolved?.isCurrent()).toBe(true);

        current = false;
        expect(resolved?.isCurrent()).toBe(false);
    });

    it('does not resolve another generation, family, or local id', () => {
        const registry = createTargetVoiceSpeechRegistry({
            generation: 8,
            targetRegistrations: [{
                pluginId: 'acme.speech',
                generation: '7',
                registration: { family: 'voiceProviders.speech', localId: 'main', value: runtime },
            }],
            isGenerationActive: () => true,
        });
        expect(registry.read({ pluginId: 'acme.speech', localId: 'main' })).toBeNull();
        expect(registry.read({ pluginId: 'acme.speech', localId: 'other' })).toBeNull();
    });
});
