import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineSettingDefinitions } from '@happier-dev/protocol';

import { assertProviderSettingKeysCompatible } from './assertProviderSettingKeysCompatible';

describe('assertProviderSettingKeysCompatible', () => {
    it('rejects provider settings that collide with schema metadata keys', () => {
        const plugin = {
            providerId: 'codex',
            title: 'Codex',
            icon: { ionName: 'terminal-outline', color: '#000' },
            settings: defineSettingDefinitions({
                schemaVersion: {
                    schema: z.number(),
                    default: 1,
                    description: 'Invalid provider-owned schemaVersion',
                    storageScope: 'account',
                },
            }),
            uiSections: [],
            buildOutgoingMessageMetaExtras: () => ({}),
        } as const;

        expect(() => assertProviderSettingKeysCompatible({ coreSettingKeys: [], plugins: [plugin] }))
            .toThrow(/schemaVersion/);
    });
});

