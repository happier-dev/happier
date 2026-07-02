import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import type { SettingDefinitionMap } from '@happier-dev/protocol';
import { getAllProviderSettingsDefinitions } from '@happier-dev/agents';

import type { ProviderSettingsBehavior, ProviderSettingsDescriptor, ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';
import { PROVIDER_SETTINGS_DEFAULTS, PROVIDER_SETTINGS_SHAPE } from '@/agents/providers/registry/providerSettingArtifacts';
import * as providerSettingsRegistry from '@/agents/catalog/providerSettingsCatalog';
import {
    PROVIDER_SETTINGS_BEHAVIORS,
    PROVIDER_SETTINGS_DESCRIPTORS,
    PROVIDER_SETTINGS_PLUGINS,
    assertProviderSettingsDescriptorsValid,
    assertProviderSettingsPluginsValid,
    getProviderSettingsBehavior,
    getProviderSettingsDescriptor,
    getProviderSettingsPlugin,
    resolveProviderSettingsRegistryEntry,
} from '@/agents/catalog/providerSettingsCatalog';
import { createProviderSettingsPluginFromDescriptor } from '@/agents/catalog/providerSettingsDescriptorAdapters';
import { BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS } from '@/agents/registry/generatedBundledPluginEntries.providerSettings';
import { assertProviderSettingKeysCompatible } from '@/sync/domains/settings/registry/provider/assertProviderSettingKeysCompatible';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID } from '@/agents/backendCatalog/legacyCompatAgents';

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
        icon: { ionName: 'bug-outline', color: { kind: 'theme', token: 'blue' } },
        settings,
        uiSections: [
            {
                id: 'main',
                title: { key: 'settingsProviders.cliConnection' },
                fields: [{ key: 'foo', kind: 'text', title: { key: 'settingsProviders.targetMachineTitle' } }],
            },
        ],
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

    it('rejects unsupported control kinds', () => {
        const plugin = makePlugin({
            uiSections: [
                {
                    id: 'main',
                    title: { key: 'settingsProviders.cliConnection' },
                    fields: [{
                        key: 'foo',
                        kind: 'providerSpecificToggle' as any,
                        title: { key: 'settingsProviders.targetMachineTitle' },
                    }],
                },
            ],
        });

        expect(() => assertProviderSettingsPluginsValid([plugin])).toThrow(/unsupported control kind/i);
    });

    it('rejects raw icon colors', () => {
        const plugin = makePlugin({
            icon: { ionName: 'bug-outline', color: '#000' },
        });

        expect(() => assertProviderSettingsPluginsValid([plugin])).toThrow(/theme token/i);
    });
});

describe('provider settings descriptor/runtime accessors', () => {
    it('splits descriptor data from runtime behavior', () => {
        const descriptor = getProviderSettingsDescriptor('claude' as any);
        const behavior = getProviderSettingsBehavior('claude' as any);

        expect(descriptor).toBeTruthy();
        expect(behavior).toBeTruthy();
        expect(descriptor).toMatchObject({
            providerId: 'claude',
            title: expect.anything(),
            icon: expect.any(Object),
            settings: expect.any(Object),
            uiSections: expect.any(Array),
        } satisfies Partial<ProviderSettingsDescriptor>);
        expect('buildOutgoingMessageMetaExtras' in (descriptor ?? {})).toBe(false);
        expect('ExtraSectionsComponent' in (descriptor ?? {})).toBe(false);

        expect(behavior).toMatchObject({
            providerId: 'claude',
        } satisfies Partial<ProviderSettingsBehavior>);
        expect('title' in (behavior ?? {})).toBe(false);
        expect('uiSections' in (behavior ?? {})).toBe(false);
        expect('buildOutgoingMessageMetaExtras' in (behavior ?? {})).toBe(false);
    });

    it('exports descriptor-only plugin data for all registry entries', () => {
        expect(PROVIDER_SETTINGS_DESCRIPTORS).toHaveLength(PROVIDER_SETTINGS_PLUGINS.length);
        expect(PROVIDER_SETTINGS_BEHAVIORS).toHaveLength(PROVIDER_SETTINGS_PLUGINS.length);
        for (const descriptor of PROVIDER_SETTINGS_DESCRIPTORS) {
            expect(descriptor).toMatchObject({
                providerId: expect.any(String),
                title: expect.anything(),
                icon: expect.any(Object),
                settings: expect.any(Object),
                uiSections: expect.any(Array),
            });
            expect('buildOutgoingMessageMetaExtras' in descriptor).toBe(false);
            expect('ExtraSectionsComponent' in descriptor).toBe(false);
        }

        for (const behavior of PROVIDER_SETTINGS_BEHAVIORS) {
            expect(behavior).toMatchObject({
                providerId: expect.any(String),
            });
            expect('buildOutgoingMessageMetaExtras' in behavior).toBe(false);
        }
    });

    it('does not expose a separate runtime registry surface alias', () => {
        expect('PROVIDER_SETTINGS_RUNTIMES' in providerSettingsRegistry).toBe(false);
        expect('getProviderSettingsRuntime' in providerSettingsRegistry).toBe(false);
    });
});

describe('getProviderSettingsPlugin', () => {
    it('resolves plugins case-insensitively', () => {
        expect(getProviderSettingsPlugin('CLAUDE' as any)).not.toBeNull();
    });

    it('does not treat legacy compat providers as provider settings plugins', () => {
        expect(PROVIDER_SETTINGS_PLUGINS.map((plugin) => plugin.providerId)).not.toContain(LEGACY_COMPAT_PRIMARY_AGENT_ID);
        expect(PROVIDER_SETTINGS_DESCRIPTORS.map((descriptor) => descriptor.providerId)).not.toContain(LEGACY_COMPAT_PRIMARY_AGENT_ID);
        expect(PROVIDER_SETTINGS_BEHAVIORS.map((behavior) => behavior.providerId)).not.toContain(LEGACY_COMPAT_PRIMARY_AGENT_ID);
        expect(getProviderSettingsPlugin(LEGACY_COMPAT_PRIMARY_AGENT_ID)).toBeNull();
        expect(resolveProviderSettingsRegistryEntry(LEGACY_COMPAT_PRIMARY_AGENT_ID)).toEqual({
            providerId: LEGACY_COMPAT_PRIMARY_AGENT_ID,
            plugin: null,
            descriptor: null,
            behavior: null,
            registered: false,
        });
    });

    it('exposes a stable registry projection for unknown provider ids', () => {
        expect(resolveProviderSettingsRegistryEntry('acme.review.provider')).toEqual({
            providerId: 'acme.review.provider',
            plugin: null,
            descriptor: null,
            behavior: null,
            registered: false,
        });
    });

    it('covers shared provider-settings definitions from @happier-dev/agents', () => {
        for (const def of getAllProviderSettingsDefinitions()) {
            const plugin = getProviderSettingsPlugin(def.providerId);
            expect(plugin, `missing UI provider settings plugin for ${def.providerId}`).not.toBeNull();
            if (!plugin) continue;

            const pluginKeys = new Set(Object.keys(plugin.settings));
            for (const key of Object.keys(def.fields)) {
                expect(pluginKeys.has(key), `missing provider setting "${key}" for ${def.providerId}`).toBe(true);
            }
        }
    });

    it('has a runtime entry for every provider settings descriptor', () => {
        for (const descriptor of PROVIDER_SETTINGS_DESCRIPTORS) {
            expect(getProviderSettingsPlugin(descriptor.providerId)).not.toBeNull();
            expect(getProviderSettingsBehavior(descriptor.providerId)).not.toBeNull();
        }
    });

    it('materializes provider settings from generated inert descriptor data', () => {
        const plugin = createProviderSettingsPluginFromDescriptor({
            agentId: 'acme',
            descriptor: {
                kind: 'providerSettings.v1',
                descriptorId: 'acme.providerSettings.v1',
                providerId: 'acme',
                title: { key: 'settingsProviders.plugins.opencode.title' },
                icon: { ionName: 'code-slash-outline', color: { kind: 'theme', token: 'blue' } },
                settings: {
                    acmeEnabled: {
                        schema: { kind: 'boolean' },
                        default: true,
                        description: 'Enable Acme',
                        storageScope: 'account',
                    },
                    acmeMode: {
                        schema: { kind: 'enum', values: ['server', 'acp'] },
                        default: 'server',
                        description: 'Preferred Acme backend mode',
                        storageScope: 'account',
                    },
                    acmeParallelism: {
                        schema: { kind: 'number', int: true, min: 1 },
                        default: 2,
                        description: 'Acme parallelism',
                        storageScope: 'account',
                    },
                    acmeSelectedSources: {
                        schema: { kind: 'array', element: { kind: 'enum', values: ['user', 'project'] }, max: 2 },
                        default: ['user'],
                        description: 'Acme selected sources',
                        storageScope: 'account',
                    },
                    acmeUrlsByServerId: {
                        schema: { kind: 'stringRecord' },
                        default: {},
                        description: 'Per-server Acme URLs',
                        storageScope: 'account',
                    },
                },
                uiSections: [
                    {
                        id: 'acmeMode',
                        title: { key: 'settingsProviders.plugins.opencode.sections.backendMode.title' },
                        fields: [
                            {
                                key: 'acmeMode',
                                kind: 'enum',
                                title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.title' },
                                enumOptions: [
                                    {
                                        id: 'server',
                                        title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.server.title' },
                                    },
                                    {
                                        id: 'acp',
                                        title: { key: 'settingsProviders.plugins.opencode.fields.opencodeBackendMode.options.acp.title' },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        });

        expect(plugin?.providerId).toBe('acme');
        expect(plugin?.settings.acmeEnabled?.schema.safeParse(true).success).toBe(true);
        expect(plugin?.settings.acmeEnabled?.schema.safeParse('true').success).toBe(false);
        expect(plugin?.settings.acmeMode?.schema.safeParse('server').success).toBe(true);
        expect(plugin?.settings.acmeMode?.schema.safeParse('other').success).toBe(false);
        expect(plugin?.settings.acmeParallelism?.schema.safeParse(2).success).toBe(true);
        expect(plugin?.settings.acmeParallelism?.schema.safeParse(0).success).toBe(false);
        expect(plugin?.settings.acmeParallelism?.schema.safeParse(1.5).success).toBe(false);
        expect(plugin?.settings.acmeSelectedSources?.schema.safeParse(['user', 'project']).success).toBe(true);
        expect(plugin?.settings.acmeSelectedSources?.schema.safeParse(['invalid']).success).toBe(false);
        expect(plugin?.settings.acmeUrlsByServerId?.schema.parse({
            serverA: 'http://127.0.0.1:4096',
            '': 'ignored',
            serverB: 42,
        })).toEqual({ serverA: 'http://127.0.0.1:4096' });
    });

    it('uses full generated inert settings data for OpenCode', () => {
        const generated = BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS.find((entry) => entry.agentId === 'opencode');
        expect(generated?.descriptor).toMatchObject({
            kind: 'providerSettings.v1',
            descriptorId: 'opencode.providerSettings.v1',
            providerId: 'opencode',
            settings: {
                opencodeBackendMode: {
                    schema: { kind: 'enum', values: ['server', 'acp'] },
                    default: 'server',
                    storageScope: 'account',
                },
                opencodeServerBaseUrl: {
                    schema: { kind: 'string' },
                    default: '',
                    storageScope: 'account',
                },
                opencodeServerBaseUrlByServerIdV1: {
                    schema: { kind: 'stringRecord' },
                    default: {},
                    storageScope: 'account',
                },
            },
            uiSections: expect.arrayContaining([
                expect.objectContaining({
                    id: 'opencodeBackendMode',
                    fields: expect.arrayContaining([
                        expect.objectContaining({ key: 'opencodeBackendMode', kind: 'enum' }),
                    ]),
                }),
            ]),
        });

        const plugin = getProviderSettingsPlugin('opencode');
        expect(plugin?.settings.opencodeBackendMode?.schema.safeParse('server').success).toBe(true);
        expect(plugin?.settings.opencodeBackendMode?.schema.safeParse('invalid').success).toBe(false);
    });

    it('uses full generated inert settings data for Claude', () => {
        const generated = BUNDLED_PROVIDER_SETTINGS_DESCRIPTORS.find((entry) => entry.agentId === 'claude');
        expect(generated?.descriptor).toMatchObject({
            kind: 'providerSettings.v1',
            descriptorId: 'claude.providerSettings.v1',
            providerId: 'claude',
            settings: {
                claudeRemoteAgentSdkEnabled: {
                    schema: { kind: 'boolean' },
                    default: true,
                    storageScope: 'account',
                },
                claudeUnifiedTerminalHost: {
                    schema: { kind: 'enum', values: ['auto', 'tmux', 'zellij'] },
                    default: 'auto',
                    storageScope: 'account',
                },
                claudeRemoteSettingSourcesV2: {
                    schema: { kind: 'array', element: { kind: 'enum', values: ['user', 'project', 'local'] }, max: 3 },
                    default: ['user', 'project', 'local'],
                    storageScope: 'account',
                },
                claudeRemoteMaxThinkingTokens: {
                    schema: { kind: 'number', int: true, min: 1, nullable: true },
                    default: null,
                    storageScope: 'account',
                },
            },
            uiSections: expect.arrayContaining([
                expect.objectContaining({
                    id: 'claudeUnifiedTerminal',
                    fields: expect.arrayContaining([
                        expect.objectContaining({ key: 'claudeUnifiedTerminalEnabled', kind: 'boolean' }),
                        expect.objectContaining({ key: 'claudeUnifiedTerminalHost', kind: 'enum' }),
                    ]),
                }),
            ]),
        });

        const plugin = getProviderSettingsPlugin('claude');
        expect(plugin?.settings.claudeUnifiedTerminalHost?.schema.safeParse('tmux').success).toBe(true);
        expect(plugin?.settings.claudeUnifiedTerminalHost?.schema.safeParse('screen').success).toBe(false);
        expect(plugin?.settings.claudeRemoteSettingSourcesV2?.schema.safeParse(['user', 'local']).success).toBe(true);
        expect(plugin?.settings.claudeRemoteSettingSourcesV2?.schema.safeParse(['invalid']).success).toBe(false);
        expect(plugin?.settings.claudeRemoteMaxThinkingTokens?.schema.safeParse(null).success).toBe(true);
        expect(plugin?.settings.claudeRemoteMaxThinkingTokens?.schema.safeParse(10).success).toBe(true);
        expect(plugin?.settings.claudeRemoteMaxThinkingTokens?.schema.safeParse(0).success).toBe(false);
    });

    it('uses translation refs for first-party provider settings UI text', () => {
        const expectTranslationRef = (value: unknown) => {
            expect(value).toEqual({ key: expect.any(String) });
        };

        for (const plugin of PROVIDER_SETTINGS_PLUGINS) {
            const descriptor: ProviderSettingsDescriptor = plugin;
            expectTranslationRef(descriptor.title);

            for (const section of descriptor.uiSections) {
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

            for (const section of descriptor.subagentSettingsSections ?? []) {
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
        expect(PROVIDER_SETTINGS_DEFAULTS.kimiAcpPythonSelector).toBe('auto');
    });
});

describe('assertProviderSettingsDescriptorsValid', () => {
    it('rejects duplicate descriptor provider ids', () => {
        const descriptor: ProviderSettingsDescriptor = makePlugin({ providerId: 'claude' as any });
        expect(() => assertProviderSettingsDescriptorsValid([descriptor, descriptor])).toThrow(/duplicate providerId/i);
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
