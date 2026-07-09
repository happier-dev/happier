import { describe, expect, expectTypeOf, it } from 'vitest';

import * as sdk from './index.js';
import * as manifestSdk from './manifest.js';
import type {
    PluginAgentContributionV2,
    PluginEventContributionV1,
    PluginManagedDependencyContributionV2,
    PluginManifestV2,
    PluginCapabilityDeclarationV1,
    PluginDeclaredCapabilityV1,
    PluginPermissionDeclarationV1,
    PluginRequestInterceptorContributionV1,
    PluginSettingsContributionV2,
    PluginSystemToolContributionV1,
} from './manifest.js';
import {
    defineAgentSettingsContribution,
    enumArrayAgentSetting,
    jsonObjectStringAgentSetting,
    PluginAgentSettingsContributionV1Schema,
    agentSettingsContributionToUiDescriptor,
    stringRecordAgentSetting,
} from './manifest/agentSettings.js';

describe('definePluginManifest', () => {
    it('preserves manifest literals while using protocol-owned manifest types', () => {
        const input = {
            schemaVersion: 2,
            id: 'acme.sdk-helper',
            version: '1.0.0',
            displayName: 'SDK Helper',
            engines: { happier: '^1.0.0' },
            uses: ['agents', 'managedDependencies'],
            entrypoints: { main: './dist/activate.js' },
            declares: {
                capabilities: [
                    {
                        capability: 'storage.local',
                        reason: 'Stores plugin-local settings.',
                    },
                ],
            },
            permissions: {
                required: [
                    {
                        capability: 'reviews.comments.write.direct',
                        reason: 'Write user-approved review comments directly.',
                    },
                ],
                optional: [],
            },
            contributes: {
                events: [
                    {
                        id: 'review/comment-written',
                        payloadSchema: { type: 'object', additionalProperties: true },
                    },
                ],
                requestInterceptors: [
                    {
                        id: 'plugin-fetch-audit',
                        order: 100,
                        targets: [{ scope: 'plugin-fetch' }],
                    },
                ],
                systemTools: [
                    {
                        toolId: 'acme-tool',
                        displayName: 'Acme Tool',
                        source: 'system',
                        lookupNames: ['acme-tool'],
                        defaultArgs: [],
                    },
                ],
                managedDependencies: [
                    {
                        id: 'acme-tool',
                        key: 'acme-tool',
                        kind: 'dep',
                        version: '1',
                        capabilityId: 'dep.acme-tool',
                        display: { name: 'Acme Tool' },
                        description: 'Acme tool dependency',
                        source: {
                            kind: 'manual_only',
                            setupUrl: 'https://example.com/acme-tool',
                        },
                        binary: {
                            commands: ['acme-tool'],
                            systemFirst: true,
                        },
                        defaultPolicy: {
                            autoInstallWhenNeeded: false,
                            autoUpdateMode: 'notify',
                        },
                        consent: {
                            install: 'required',
                            update: 'required',
                        },
                    },
                ],
                agents: [
                    {
                        id: 'acme.agent',
                        runtime: { kind: 'custom' },
                    },
                ],
            },
        } satisfies PluginManifestV2;

        const definePluginManifest = (sdk as Readonly<{
            definePluginManifest?: <const TManifest extends PluginManifestV2>(manifest: TManifest) => TManifest;
        }>).definePluginManifest;

        expect(definePluginManifest).toBeTypeOf('function');
        const manifest = definePluginManifest!(input);

        expect(manifest).toBe(input);
        expectTypeOf(manifest.id).toEqualTypeOf<'acme.sdk-helper'>();
        expectTypeOf(manifest.contributes.events[0]).toMatchTypeOf<PluginEventContributionV1>();
        expectTypeOf(manifest.contributes.requestInterceptors[0]).toMatchTypeOf<PluginRequestInterceptorContributionV1>();
        expectTypeOf(manifest.contributes.systemTools[0]).toMatchTypeOf<PluginSystemToolContributionV1>();
        expectTypeOf(manifest.contributes.managedDependencies[0]).toMatchTypeOf<PluginManagedDependencyContributionV2>();
        expectTypeOf(manifest.contributes.agents).toMatchTypeOf<readonly PluginAgentContributionV2[]>();
        expectTypeOf(manifest.declares.capabilities[0]).toMatchTypeOf<PluginCapabilityDeclarationV1>();
        expectTypeOf(manifest.declares.capabilities[0].capability).toMatchTypeOf<PluginDeclaredCapabilityV1>();
        expectTypeOf(manifest.permissions.required[0]).toMatchTypeOf<PluginPermissionDeclarationV1>();
    });
});

describe('agent-account settings manifest helpers', () => {
    it('authors generic plugin settings contributions through the public SDK', () => {
        const sdkSurface = sdk as Readonly<{
            definePluginSettingsContribution?: <TContribution>(contribution: TContribution) => TContribution;
        }>;

        expect(sdkSurface.definePluginSettingsContribution).toBeTypeOf('function');

        const contribution = sdkSurface.definePluginSettingsContribution!({
            id: 'acme.plugin.settings',
            fields: [
                {
                    id: 'showDiagnostics',
                    kind: 'settings.field',
                    version: '1',
                    valueSchema: { type: 'boolean' },
                    control: 'switch',
                    displayKey: 'acme.settings.showDiagnostics',
                    defaultBooleanValue: true,
                    clearWhenEmpty: 'persist',
                    redaction: 'none',
                    hidden: false,
                    order: 10,
                },
            ],
        });

        expect(contribution).toMatchObject({
            id: 'acme.plugin.settings',
            fields: [expect.objectContaining({ id: 'showDiagnostics', control: 'switch' })],
        });
        expectTypeOf(contribution).toMatchTypeOf<PluginSettingsContributionV2>();
    });

    it('authors agent-settings contributions through the public SDK without provider-branded exports', () => {
        const sdkSurface = sdk as Readonly<{
            defineAgentSettingsContribution?: <TContribution>(contribution: TContribution) => TContribution;
            enumAgentSetting?: (input: Readonly<{
                id: string;
                values: readonly string[];
                default: string;
                description: string;
                storageScope?: 'account';
            }>) => unknown;
            stringRecordAgentSetting?: (input: Readonly<{
                id: string;
                default: Readonly<Record<string, string>>;
                description: string;
            }>) => unknown;
        }>;

        expect(sdkSurface.defineAgentSettingsContribution).toBeTypeOf('function');
        expect(sdkSurface.enumAgentSetting).toBeTypeOf('function');
        expect(sdkSurface.stringRecordAgentSetting).toBeTypeOf('function');
        expect(manifestSdk.stringRecordAgentSetting).toBeTypeOf('function');

        const contribution = sdkSurface.defineAgentSettingsContribution!({
            id: 'acme.agentSettings.v1',
            agentId: 'acme',
            fields: [
                sdkSurface.enumAgentSetting!({
                    id: 'acmeBackendMode',
                    values: ['managed', 'external'],
                    default: 'managed',
                    description: 'Preferred Acme backend mode',
                }),
            ],
        });

        expect(contribution).toEqual({
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            version: 1,
            storageScope: 'agentAccount',
            fields: [
                {
                    id: 'acmeBackendMode',
                    schema: { kind: 'enum', values: ['managed', 'external'] },
                    default: 'managed',
                    description: 'Preferred Acme backend mode',
                    storageScope: 'account',
                },
            ],
            ui: {
                sections: [],
                subagentSettingsSections: [],
            },
        });
        expect(JSON.parse(JSON.stringify(contribution))).toEqual(contribution);
        expect('defineClaudeAgentSettingsContribution' in sdk).toBe(false);
    });

    it('preserves explicit invalid numeric limits so schema validation fails closed', () => {
        const contribution = defineAgentSettingsContribution({
            id: 'acme.agentSettings.v1',
            agentId: 'acme',
            fields: [
                jsonObjectStringAgentSetting({
                    id: 'advancedJson',
                    default: '',
                    maxLength: 0,
                    description: 'Advanced JSON object',
                }),
                enumArrayAgentSetting({
                    id: 'sources',
                    values: ['user', 'project'],
                    default: ['user'],
                    max: 0,
                    description: 'Source order',
                }),
            ],
        });

        expect(PluginAgentSettingsContributionV1Schema.safeParse(contribution).success).toBe(false);
    });

    it('allows provider-owned descriptor contributions with no settings fields', () => {
        const contribution = defineAgentSettingsContribution({
            id: 'acme.agentSettings.v1',
            agentId: 'acme',
            fields: [],
            ui: {
                title: { key: 'settingsProviders.plugins.acme.title' },
                icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'green' } },
                sections: [],
                subagentSettingsSections: [],
            },
        });

        expect(PluginAgentSettingsContributionV1Schema.safeParse(contribution).success).toBe(true);
        expect(agentSettingsContributionToUiDescriptor(contribution)).toEqual({
            kind: 'agentSettings.v1',
            descriptorId: 'acme.agentSettings.v1',
            agentId: 'acme',
            title: { key: 'settingsProviders.plugins.acme.title' },
            icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'green' } },
            settings: {},
            subagentSettingsSections: [],
            uiSections: [],
        });
    });

    it('projects string-record agent settings and per-server UI bindings', () => {
        const contribution = defineAgentSettingsContribution({
            id: 'acme.agentSettings.v1',
            agentId: 'acme',
            fields: [
                stringRecordAgentSetting({
                    id: 'acmeServerBaseUrlByServerIdV1',
                    default: {},
                    description: 'Per-server Acme server URL overrides',
                    ui: {
                        kind: 'text',
                        title: { key: 'settingsProviders.plugins.acme.fields.serverBaseUrl.title' },
                        binding: {
                            kind: 'perActiveServer',
                            fallbackSettingKey: 'acmeServerBaseUrl',
                            byServerIdSettingKey: 'acmeServerBaseUrlByServerIdV1',
                        },
                    },
                }),
            ],
            ui: {
                sections: [
                    {
                        id: 'acmeServer',
                        title: { key: 'settingsProviders.plugins.acme.sections.server.title' },
                        fields: ['acmeServerBaseUrlByServerIdV1'],
                    },
                ],
                subagentSettingsSections: [],
            },
        });

        expect(PluginAgentSettingsContributionV1Schema.safeParse(contribution).success).toBe(true);
        expect(agentSettingsContributionToUiDescriptor(contribution)).toMatchObject({
            settings: {
                acmeServerBaseUrlByServerIdV1: {
                    schema: { kind: 'stringRecord' },
                    default: {},
                },
            },
            uiSections: [
                {
                    id: 'acmeServer',
                    fields: [
                        {
                            key: 'acmeServerBaseUrlByServerIdV1',
                            kind: 'text',
                            binding: {
                                kind: 'perActiveServer',
                                fallbackSettingKey: 'acmeServerBaseUrl',
                                byServerIdSettingKey: 'acmeServerBaseUrlByServerIdV1',
                            },
                        },
                    ],
                },
            ],
        });
    });
});
