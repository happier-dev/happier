import { describe, expect, it } from 'vitest';

import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

/**
 * The floating Voice orb is a **per-device presence**, never a synced one: a companion that is
 * welcome on a phone can be unwelcome on a desktop where the pet already owns that corner. These
 * keys therefore live in the local registry (MMKV) and must never appear under the synced
 * `voice.ui.*` tree.
 */
describe('LOCAL_SETTING_DEFINITIONS voice orb', () => {
    it('stores orb presence and expansion as device-local preferences', () => {
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbEnabled.default).toBe(true);
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbEnabled.storageScope).toBe('local');
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbExpanded.default).toBe(false);
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbExpanded.storageScope).toBe('local');
    });

    it('falls back to the default rather than throwing on a corrupt stored value', () => {
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbEnabled.schema.safeParse('yes'))
            .toMatchObject({ success: true, data: true });
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbExpanded.schema.safeParse(null))
            .toMatchObject({ success: true, data: false });
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbEnabled.schema.safeParse(false))
            .toMatchObject({ success: true, data: false });
        expect(LOCAL_SETTING_DEFINITIONS.voiceOrbExpanded.schema.safeParse(true))
            .toMatchObject({ success: true, data: true });
    });
});
