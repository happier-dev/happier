import { describe, expect, it } from 'vitest';

import type { PluginProjectedSettingsV2, PluginProjectionV2 } from '@happier-dev/protocol';
import { createProjectedAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    mapV2EditableSettingsGroup,
    type DaemonContributionRegistryProjectionV1Like,
} from './daemonContributionRegistryProjectionAdapters';

describe('daemon contribution registry projection adapters', () => {
    it('preserves projected secret custody for the Settings presentation dispatcher', () => {
        const settings: PluginProjectedSettingsV2 = {
            id: 'acme.review.settings',
            pluginId: 'acme.review',
            version: 1,
            title: 'Review settings',
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields: [{
                id: 'machine-only-token',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                valueType: 'string',
                control: 'password',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
                displayKey: 'Machine-only token',
                redaction: 'secret',
                clearWhenEmpty: 'omit',
                capabilityGates: [],
                permissionGates: [],
            }],
        };

        expect(mapV2EditableSettingsGroup(settings).fields).toEqual([
            expect.objectContaining({
                key: 'machine-only-token',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
            }),
        ]);
    });

    it('adapts daemon projection v1 into merged backend/provider projection maps', () => {
        const projection: DaemonContributionRegistryProjectionV1Like = {
            v: 1,
            generationId: 'registry:plugin-provider|ui:p1.settings',
            agentsById: {
                p1: {
                    id: 'p1',
                    title: 'P1',
                    subtitle: 'sub',
                    channel: 'plugin',
                    settingsBackendId: 'b1',
                    catalogAgentId: 'claude',
                    iconAgentId: 'codex',
                },
            },
            backendsById: {
                b1: {
                    id: 'b1',
                    agentId: 'p1',
                    catalogAgentId: 'claude',
                    iconAgentId: 'codex',
                    capabilities: {
                        executionRun: { supported: true },
                        session: { supported: false },
                    },
                },
            },
            actionsById: {
                'p1.refresh': {
                    id: 'p1.refresh',
                    pluginId: 'p1',
                    title: 'Refresh P1',
                    description: 'Refresh P1 resources',
                    safety: 'safe',
                    surfaces: {
                        settings: true,
                    },
                },
                'p1.write': {
                    id: 'p1.write',
                    pluginId: 'p1',
                    title: 'Write P1',
                    safety: 'danger',
                    surfaces: { settings: true },
                },
            },
            resourcesById: {
                'p1.prompt': {
                    id: 'p1.prompt',
                    pluginId: 'p1',
                    type: 'prompt',
                    path: 'resources/prompt.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
            },
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.mergedProviderProjectionById?.p1).toEqual(expect.objectContaining({
            agentId: 'p1',
            title: 'P1',
            subtitle: 'sub',
            channel: 'plugin',
            settingsBackendId: 'b1',
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
        }));
        expect(adapted.mergedBackendProjectionById?.b1).toEqual(expect.objectContaining({
            backendId: 'b1',
            agentId: 'p1',
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
            capabilities: expect.objectContaining({
                session: expect.objectContaining({ supported: false }),
            }),
        }));
        expect(adapted.pluginProjectionById?.p1).toEqual(expect.objectContaining({
            pluginId: 'p1',
            generation: null,
            generationLabel: 'registry:plugin-provider|ui:p1.settings',
            actions: [
                expect.objectContaining({
                    id: 'p1.refresh',
                    title: 'Refresh P1',
                    surfaces: ['settings'],
                    dangerLevel: 'safe',
                }),
                expect.objectContaining({
                    id: 'p1.write',
                    dangerLevel: 'writesLocal',
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'p1.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/prompt.md',
                }),
            ],
        }));
    });

    it('adapts plugin projection v2 registry metadata', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'acme.review': {
                    id: 'acme.review',
                    displayName: 'Acme Review',
                    version: '1.2.3',
                    enabled: true,
                    source: {
                        kind: 'path',
                        locator: '/plugins/acme-review',
                    },
                },
            },
            agentsById: {
                'acme.native': {
                    id: 'acme.native',
                    identity: {
                        pluginId: 'acme.review',
                        localId: 'acme-native',
                    },
                    channel: 'plugin',
                    isBuiltIn: false,
                    providerOwnedEnvironmentKeys: [],
                    cli: {
                        executable: { binaryName: 'acme', sourcePreference: 'system-first' },
                        install: { manual: { kind: 'none' } },
                        auth: {
                            support: 'login_terminal',
                            probe: { parser: 'unknown', backgroundChecks: 'safe' },
                            loginLaunches: [
                                { kind: 'primary', args: ['login'] },
                                { kind: 'device_code', args: ['login', '--device-code'] },
                            ],
                        },
                    },
                },
            },
            backendsById: {},
            actionsById: {
                'acme.review.refresh': {
                    id: 'acme.review.refresh',
                    pluginId: 'acme.review',
                    title: 'Refresh Acme',
                    description: 'Refresh Acme resources',
                    scopes: ['settings'],
                    surfaces: ['agent'],
                    placementBindings: ['detailsPanel'],
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                    available: true,
                },
                'acme.review.refresh-provider-state': {
                    id: 'acme.review.refresh-provider-state',
                    pluginId: 'acme.review',
                    title: 'Refresh provider state',
                    scopes: ['session'],
                    surfaces: ['plugin'],
                    inputSchema: {
                        type: 'object',
                        properties: { repository: { type: 'string' } },
                        additionalProperties: false,
                    },
                    dangerLevel: 'writesRemote',
                },
            },
            familiesById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {
                'acme.review.prompt': {
                    id: 'acme.review.prompt',
                    pluginId: 'acme.review',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
            },
            settingsById: {
                'acme.review.settings': {
                    id: 'settings',
                    pluginId: 'acme.review',
                    version: 1,
                    title: 'Review settings',
                    scope: { kind: 'daemon' },
                    presentation: { sections: [], subagentSections: [] },
                    target: { kind: 'plugin' },
                    fields: [],
                },
            },
            diagnostics: [
                {
                    version: 1,
                    id: 'acme.review:normalization:plugin:0',
                    data: {
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'normalization',
                    generation: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 1,
                    resolution: { state: 'current' },
                },
                {
                    version: 1,
                    id: 'acme.review:activation:plugin:0',
                    data: {
                        severity: 'info',
                        code: 'plugin.activated',
                        message: 'Activation completed',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'activation',
                    generation: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 2,
                    resolution: { state: 'current' },
                },
            ],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.mergedProviderProjectionById['acme.native']?.identity).toEqual({
            pluginId: 'acme.review',
            localId: 'acme-native',
        });

        expect(adapted.mergedProviderProjectionById['acme.native']?.cli?.auth.loginLaunches).toEqual([
            { kind: 'primary', args: ['login'] },
            { kind: 'device_code', args: ['login', '--device-code'] },
        ]);
        const projectedCli = adapted.mergedProviderProjectionById['acme.native']?.cli;
        if (!projectedCli) throw new Error('expected native Agent CLI/auth projection');
        const authPlugin = createProjectedAgentLocalAuthPlugin({
            agentId: 'acme.native',
            cli: projectedCli,
        });
        expect(authPlugin.loginLaunchKinds).toEqual(['primary', 'device_code']);
        expect(authPlugin.buildLoginLaunch?.({
            kind: 'device_code',
            resolvedCommand: "'/opt/runtime/bun' '/opt/acme/acme.js'",
        })).toEqual({
            initialCommand: "'/opt/runtime/bun' '/opt/acme/acme.js' login --device-code",
        });

        expect(adapted.pluginProjectionById?.['acme.review']).toEqual(expect.objectContaining({
            pluginId: 'acme.review',
            title: 'Acme Review',
            version: '1.2.3',
            enabled: true,
            generation: 42,
            generationLabel: '42',
            provenance: expect.objectContaining({
                sourceKind: 'path',
                sourceLabel: '/plugins/acme-review',
            }),
            diagnostics: [
                { code: 'registry.warning', message: 'Registry rebuilt with warnings', severity: 'warning' },
                { code: 'plugin.activated', message: 'Activation completed', severity: 'info' },
            ],
            actions: [
                expect.objectContaining({
                    id: 'acme.review.refresh',
                    title: 'Refresh Acme',
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                }),
                expect.objectContaining({
                    id: 'acme.review.refresh-provider-state',
                    placementBindings: [],
                    inputSchema: {
                        type: 'object',
                        properties: { repository: { type: 'string' } },
                        additionalProperties: false,
                    },
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'acme.review.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                }),
            ],
            editableSettingsGroups: [
                expect.objectContaining({
                    id: 'settings',
                    scope: { kind: 'daemon' },
                }),
            ],
        }));
        expect(adapted.registryDiagnostics).toEqual([]);
    });

    it('keeps a target semantic diagnostic on the target Settings entry', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'happier.channels': {
                    id: 'happier.channels',
                    displayName: 'Channels',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channels' },
                },
                'happier.channel.telegram': {
                    id: 'happier.channel.telegram',
                    displayName: 'Telegram',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channel.telegram' },
                },
                'happier.scm.forge.github': {
                    id: 'happier.scm.forge.github',
                    displayName: 'GitHub',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.scm.forge.github' },
                },
            },
            agentsById: {},
            backendsById: {},
            actionsById: {},
            familiesById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [{
                version: 1,
                id: 'happier.channels:runtime:happier.channels/providers:0',
                data: {
                    severity: 'error',
                    code: 'target_semantics_unavailable',
                    message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
                    details: {
                        targetPluginId: 'happier.channels',
                        pointId: 'providers',
                        protocol: { id: 'happier.channels/providers', version: 1 },
                    },
                },
                plugin: { id: 'happier.channels', version: '0.0.0', source: 'bundled' },
                contribution: { pluginId: 'happier.channels', localId: 'providers' },
                stage: 'runtime',
                generation: 'channels-generation-a',
                host: 'daemon',
                platform: 'test',
                occurredAtMs: 1,
                resolution: { state: 'current' },
            }],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById['happier.channels']?.diagnostics).toEqual([{
            code: 'target_semantics_unavailable',
            message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
            severity: 'error',
        }]);
        expect(adapted.pluginProjectionById['happier.channel.telegram']?.diagnostics).toEqual([]);
        expect(adapted.pluginProjectionById['happier.scm.forge.github']?.diagnostics).toEqual([]);
    });

});
