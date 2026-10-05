import { describe, expect, it } from 'vitest';

import { resolveVoiceStartAdmission } from './resolveVoiceStartAdmission';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { BUILT_IN_VOICE_UI_ENTRIES } from '@/voice/registry/builtInEntries';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

const settings = voiceSettingsParse({ providerId: 'local_conversation' });

function registry(supportedPlatforms: readonly ('web' | 'ios' | 'android')[]) {
    return createVoiceProviderRegistry({
        builtIn: BUILT_IN_VOICE_UI_ENTRIES.map((entry) => entry.providerId === 'local_conversation'
            ? { ...entry, supportedPlatforms }
            : entry),
    });
}

describe('resolveVoiceStartAdmission', () => {
    it('fails start admission before runtime lookup when the selected provider does not support this platform', () => {
        expect(resolveVoiceStartAdmission({
            bindingScope: 'global',
            daemonLocalVoiceUnavailable: false,
            globalStartAuthorized: true,
            platform: 'ios',
            providerId: 'local_conversation',
            providerSettings: null,
            registry: registry(['web']),
            startSessionId: null,
            voiceSettings: settings,
        }).canStart).toBe(false);
    });

    it('admits the same selected provider on a declared platform', () => {
        expect(resolveVoiceStartAdmission({
            bindingScope: 'global',
            daemonLocalVoiceUnavailable: false,
            globalStartAuthorized: true,
            platform: 'web',
            providerId: 'local_conversation',
            providerSettings: null,
            registry: registry(['web']),
            startSessionId: null,
            voiceSettings: settings,
        }).canStart).toBe(true);
    });
});
