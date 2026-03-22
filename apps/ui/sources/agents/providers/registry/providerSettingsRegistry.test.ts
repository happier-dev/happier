import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';
import { PROVIDER_SETTINGS_DEFAULTS, PROVIDER_SETTINGS_SHAPE } from '@/agents/providers/registry/providerSettingArtifacts';
import { PROVIDER_SETTINGS_PLUGINS, assertProviderSettingsPluginsValid, getProviderSettingsPlugin } from '@/agents/providers/registry/providerSettingsRegistry';
import { assertProviderSettingKeysCompatible } from '@/sync/domains/settings/registry/provider/assertProviderSettingKeysCompatible';

function makePlugin(overrides: Partial<ProviderSettingsPlugin>): ProviderSettingsPlugin {
    const settings = {
        foo: {
            schema: z.string(),
            default: '',
            description: 'Foo',
            storageScope: 'account',
        },
    } satisfies SettingDefinitionMap;
    const base: ProviderSettingsPlugin = {
        providerId: 'claude',
        title: { key: 'settingsProviders.notFoundTitle' },
        icon: { ionName: 'bug-outline', color: '#000' },
        settings,
        uiSections: [
            {
                id: 'main',
                title: { key: 'settingsProviders.cliConnection' },
                fields: [{ key: 'foo', kind: 'text', title: { key: 'settingsProviders.targetMachineTitle' } }],
            },
        ],
        buildOutgoingMessageMetaExtras: () => ({}),
    };
    return { ...base, ...overrides };
}

describe('assertProviderSettingsPluginsValid', () => {
    it('rejects duplicate provider ids', () => {
        const a = makePlugin({ providerId: 'claude' as any });
        const b = makePlugin({
            providerId: 'claude' as any,
            settings: {
                b: {
                    schema: z.string(),
                    default: '',
                    description: 'B',
                    storageScope: 'account',
                },
            },
        });
        expect(() => assertProviderSettingsPluginsValid([a, b])).toThrow(/duplicate providerId/i);
    });

    it('rejects fields referenced by UI sections that are missing from provider settings', () => {
        const a = makePlugin({
            providerId: 'claude' as any,
            settings: {
                a: {
                    schema: z.string(),
                    default: '',
                    description: 'A',
                    storageScope: 'account',
                },
            },
            uiSections: [
                {
                    id: 'main',
                    title: 'Main',
                    fields: [{ key: 'b', kind: 'text', title: 'B' }],
                },
            ],
        });
        expect(() => assertProviderSettingsPluginsValid([a])).toThrow(/missing from settings/i);
    });

    it('rejects json fields that accept invalid JSON', () => {
        const a = makePlugin({
            providerId: 'claude' as any,
            settings: {
                jsonData: {
                    schema: z.string(),
                    default: '',
                    description: 'JSON data',
                    storageScope: 'account',
                },
            },
            uiSections: [
                {
                    id: 'main',
                    title: 'Main',
                    fields: [{ key: 'jsonData', kind: 'json', title: 'JSON data' }],
                },
            ],
        });
        expect(() => assertProviderSettingsPluginsValid([a])).toThrow(/json/i);
    });

    it('rejects raw strings for user-visible provider settings text', () => {
        const plugin = makePlugin({
            title: 'Raw title',
            uiSections: [
                {
                    id: 'main',
                    title: { key: 'settingsProviders.cliConnection' },
                    fields: [{ key: 'foo', kind: 'text', title: 'Raw field title' }],
                },
            ],
        });

        expect(() => assertProviderSettingsPluginsValid([plugin])).toThrow(/translation key/i);
    });

    it('rejects raw textual number placeholders', () => {
        const plugin = makePlugin({
            uiSections: [
                {
                    id: 'main',
                    title: { key: 'settingsProviders.cliConnection' },
                    fields: [{
                        key: 'foo',
                        kind: 'number',
                        title: { key: 'settingsProviders.targetMachineTitle' },
                        numberSpec: {
                            placeholder: 'Default',
                        },
                    }],
                },
            ],
        });

        expect(() => assertProviderSettingsPluginsValid([plugin])).toThrow(/translation key/i);
    });
});

describe('getProviderSettingsPlugin', () => {
    it('resolves plugins case-insensitively', () => {
        expect(getProviderSettingsPlugin('CLAUDE' as any)).not.toBeNull();
    });

    it('has a plugin entry for every registered backend', () => {
        for (const agentId of AGENT_IDS) {
            expect(getProviderSettingsPlugin(agentId)).not.toBeNull();
        }
    });

    it('uses translation refs for first-party provider settings UI text', () => {
        const expectTranslationRef = (value: unknown) => {
            expect(value).toEqual({ key: expect.any(String) });
        };

        for (const plugin of PROVIDER_SETTINGS_PLUGINS) {
            expectTranslationRef(plugin.title);

            for (const section of plugin.uiSections) {
                expectTranslationRef(section.title);
                if (section.footer) expectTranslationRef(section.footer);

                for (const field of section.fields) {
                    expectTranslationRef(field.title);
                    if (field.subtitle) expectTranslationRef(field.subtitle);

                    for (const option of field.enumOptions ?? []) {
                        expectTranslationRef(option.title);
                        if (option.subtitle) expectTranslationRef(option.subtitle);
                    }
                }
            }

            for (const section of plugin.subagentSettingsSections ?? []) {
                expectTranslationRef(section.title);
                if (section.footer) expectTranslationRef(section.footer);

                for (const item of section.items) {
                    expectTranslationRef(item.title);
                    if (item.subtitle) expectTranslationRef(item.subtitle);
                }
            }
        }
    });

    it('exposes provider setting artifacts without a registry initialization cycle', () => {
        expect(PROVIDER_SETTINGS_SHAPE).toBeTruthy();
        expect(PROVIDER_SETTINGS_DEFAULTS).toBeTruthy();
    });
});

describe('assertProviderSettingKeysCompatible', () => {
    it('rejects provider settings that collide with canonical core account settings', () => {
        const plugin = makePlugin({
            settings: {
                analyticsOptOut: {
                    schema: z.boolean(),
                    default: false,
                    description: 'Shadowed key',
                    storageScope: 'account',
                },
            },
            uiSections: [
                {
                    id: 'main',
                    title: 'Main',
                    fields: [{ key: 'analyticsOptOut', kind: 'boolean', title: 'Analytics opt-out' }],
                },
            ],
        });

        expect(() =>
            assertProviderSettingKeysCompatible({
                coreSettingKeys: ['analyticsOptOut'],
                plugins: [plugin],
            }),
        ).toThrow(/collides with core setting/i);
    });
});
