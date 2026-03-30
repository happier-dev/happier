import { describe, expect, it } from 'vitest';

import { serializeDerivedSettingEntries } from './serializeDerivedSettingEntries';

describe('serializeDerivedSettingEntries', () => {
    it('serializes derived analytics properties with context using the derived prefix', () => {
        const properties = serializeDerivedSettingEntries(
            {
                analytics: {
                    valueKind: 'boolean',
                    privacy: 'safe',
                    identityScope: 'person',
                    serializeDerivedPropertiesWithContext: (value: unknown) => ({
                        compact_session_view: value === 'cozy' || value === 'narrow',
                        compact_session_view_minimal: value === 'narrow',
                    }),
                },
            },
            'cozy',
            'derived__',
            { sessionListDensity: 'cozy' },
        );

        expect(properties).toEqual({
            derived__compact_session_view: true,
            derived__compact_session_view_minimal: false,
        });
    });

    it('ignores non-scalar derived values', () => {
        const properties = serializeDerivedSettingEntries(
            {
                analytics: {
                    valueKind: 'bucket',
                    privacy: 'bucketed',
                    identityScope: 'device_user',
                    serializeDerivedProperties: () => ({
                        valid: 'large',
                        invalid: { nested: true } as unknown as string,
                    }),
                },
            },
            1.24,
            'local_derived__',
        );

        expect(properties).toEqual({
            local_derived__valid: 'large',
        });
    });
});
