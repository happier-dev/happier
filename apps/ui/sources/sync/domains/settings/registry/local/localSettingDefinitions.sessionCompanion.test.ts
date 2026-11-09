import { describe, expect, it } from 'vitest';

import type { SessionCompanionPreferencesV1 } from '@/components/sessions/companion/state/sessionCompanionPreference';

import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

const preference: SessionCompanionPreferencesV1[string] = {
    v: 1,
    edge: 'trailing',
    density: 'compact',
    items: [{ kind: 'builtin', id: 'session_summary' }],
};

describe('LOCAL_SETTING_DEFINITIONS session companion preferences', () => {
    it('registers the viewer-local Companion map with no customized Session by default', () => {
        expect(LOCAL_SETTING_DEFINITIONS.sessionCompanionPreferencesBySessionV1.default).toEqual({});
    });

    it('persists a realm-qualified entry and drops only a malformed sibling', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionCompanionPreferencesBySessionV1.schema;
        const realmKey = 'session-companion:v1:session:13:active-server9:account-a:9:session-1';

        expect(schema.parse({ [realmKey]: preference, 'realm:bad': { v: 1 } }))
            .toEqual({ [realmKey]: preference });
    });

    it('never fails the whole local-settings parse on a malformed root', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.sessionCompanionPreferencesBySessionV1.schema;

        expect(schema.safeParse('not-a-map')).toMatchObject({ success: true, data: {} });
    });

    it('reports only how many Sessions were customized, never their identities', () => {
        const analytics = LOCAL_SETTING_DEFINITIONS.sessionCompanionPreferencesBySessionV1.analytics;

        expect(analytics?.privacy).toBe('count_only');
        expect(analytics?.serializeCurrent?.({ 'realm-a': preference, 'realm-b': preference })).toBe(2);
    });
});
