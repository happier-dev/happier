import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readVoiceDiagnosticsSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

describe('Diagnostic recording settings declarations', () => {
    it('turns recording off and revokes consent when its final capture direction is disabled', () => {
        const setting = Object.values(VOICE_PRIVACY_SETTINGS.settings)
            .find((candidate) => candidate.anchor === 'voicePrivacy.diagnosticsSttInput');
        expect(setting).toBeDefined();
        const binding = setting?.storage;
        if (!binding || !('kind' in binding) || binding.kind !== 'owner') throw new Error('Expected diagnostics owner');
        const voice = voiceSettingsParse({ diagnostics: { enabled: true, consentVersion: 1, captureSttInput: true, captureTtsOutput: false } });
        const next = binding.mutate({ ...settingsDefaults, voice }, false);
        expect(next?.voice && readVoiceDiagnosticsSettings(next.voice)).toMatchObject({
            enabled: false, consentVersion: null, captureSttInput: false, captureTtsOutput: false,
        });
        expect(next?.voice?.providers).toEqual(voice.providers);
        expect(binding.parse('false').success).toBe(false);
    });

    it('keeps enablement and artifact deletion behind their human interaction owner', () => {
        const setting = Object.values(VOICE_PRIVACY_SETTINGS.settings)
            .find((candidate) => candidate.anchor === 'voicePrivacy.diagnosticsEnabled');
        expect(setting).toBeDefined();
        expect(setting?.storage?.access).toBe('read_only');
        expect(setting?.operation).toMatchObject({ kind: 'interaction', requiresHumanInteraction: true });
        const deletion = Object.values(VOICE_PRIVACY_SETTINGS.settings)
            .find((candidate) => candidate.anchor === 'voicePrivacy.diagnosticsDelete');
        expect(deletion?.operation).toMatchObject({ kind: 'interaction', requiresHumanInteraction: true });
        expect(deletion?.storage).toBeUndefined();
    });
});
