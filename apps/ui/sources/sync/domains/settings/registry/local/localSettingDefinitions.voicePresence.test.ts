import { describe, expect, it } from 'vitest';

import { ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS as LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.activitySurfaces';

describe('device-local Voice presence', () => {
    it('keeps an absent or corrupt preference unset so the responsive owner chooses its default', () => {
        const definition = LOCAL_SETTING_DEFINITIONS.voicePresenceContainer;
        expect(definition?.default).toBe(null);
        expect(definition?.storageScope).toBe('local');
        expect(definition?.schema.parse('unknown')).toBe(null);
        expect(definition?.schema.parse(undefined)).toBe(null);
    });

    it.each(['top_bar', 'island', 'orb'] as const)('retains an explicit %s choice', (value) => {
        expect(LOCAL_SETTING_DEFINITIONS.voicePresenceContainer?.schema.parse(value)).toBe(value);
    });
});
