import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['antigravity', 'codex', 'claude', 'ohMyPi'],
    isBundledAgentId: (agentId: string) => agentId === 'antigravity' || agentId === 'codex' || agentId === 'claude' || agentId === 'ohMyPi',
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agent.${agentId}`,
        availability: { experimental: false },
        ui: {
            agentPickerIconName: agentId === 'claude' ? 'sparkles-outline' : 'code-slash-outline',
        },
    }),
}));

vi.mock('@/agents/catalog/localAuth/agentLocalAuthCatalog', () => ({
    getAgentLocalAuthPlugin: (agentId: string) => (agentId === 'claude' ? { agentId: 'claude' } : null),
}));

vi.mock('@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin', () => ({
    createProjectedAgentLocalAuthPlugin: ({ agentId, cli }: { agentId: string; cli: { auth: { loginLaunches: Array<{ kind: string }> } } }) => ({
        agentId,
        support: 'login_terminal',
        loginLaunchKinds: cli.auth.loginLaunches.map((launch) => launch.kind),
    }),
}));

import { getAgentCore } from '@/agents/catalog/catalog';

import {
    getResolvedAgentCatalogEntries,
    resolveAgentCatalogProjection,
} from './agentCatalogProjection';

describe('agentCatalogProjection', () => {
    it('uses native projected CLI/auth metadata for an external Agent with no legacy catalog carrier', () => {
        const projection = resolveAgentCatalogProjection('acme.native', {
            enabledAgentIds: ['acme.native'],
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                'acme.native': {
                    agentId: 'acme.native',
                    channel: 'plugin',
                    isBuiltIn: false,
                    cli: {
                        executable: { binaryName: 'acme', sourcePreference: 'system-first' },
                        install: { manual: { kind: 'none' } },
                        auth: {
                            support: 'login_terminal',
                            nonInteractiveStatusProbe: true,
                            loginLaunches: [
                                { kind: 'primary', args: ['login'] },
                                { kind: 'device_code', args: ['login', '--device-code'] },
                            ],
                        },
                    },
                },
            },
        });

        expect(projection.authPlugin).toEqual({
            agentId: 'acme.native',
            support: 'login_terminal',
            loginLaunchKinds: ['primary', 'device_code'],
        });
        expect(projection.cli).toEqual(expect.objectContaining({
            executable: expect.objectContaining({ binaryName: 'acme' }),
        }));
        expect(projection.cliAuthBackgroundCheckSafe).toBe(true);
    });

    it('retains exact qualified Connected Account purposes for external Agent settings', () => {
        const projection = resolveAgentCatalogProjection('acme.native', {
            enabledAgentIds: ['acme.native'],
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                'acme.native': {
                    agentId: 'acme.native',
                    identity: { pluginId: 'acme.agent', localId: 'native' },
                    connectedAccounts: [{
                        purpose: 'primary',
                        service: { pluginId: 'acme.agent', localId: 'account' },
                        required: false,
                    }],
                },
            },
        });

        expect(projection.connectedAccounts).toEqual([{
            purpose: 'primary',
            service: { pluginId: 'acme.agent', localId: 'account' },
            required: false,
        }]);
    });

    it('does not inherit bundled auth-probe safety for an installed plugin Agent with a colliding local id', () => {
        const projection = resolveAgentCatalogProjection('claude', {
            enabledAgentIds: ['claude'],
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                claude: {
                    agentId: 'claude',
                    identity: { pluginId: 'acme.voice', localId: 'claude' },
                    channel: 'plugin',
                    isBuiltIn: false,
                    cli: null,
                },
            },
        });

        expect(projection.identity).toEqual({ pluginId: 'acme.voice', localId: 'claude' });
        expect(projection.cliAuthBackgroundCheckSafe).toBe(false);
    });

    it('retains the exact qualified V2 identity, package brand, and generation for host presentation', () => {
        const installedPackage = {
            id: 'acme.voice',
            displayName: 'Acme Voice',
            version: '1.0.0',
            enabled: true,
            immutableGenerationId: 'generation-12',
            source: { kind: 'localPath', locator: '/plugins/acme-voice' },
            brand: { state: 'missing' as const },
        };
        const projection = resolveAgentCatalogProjection('acme.voice.claude', {
            enabledAgentIds: [],
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                'acme.voice.claude': {
                    agentId: 'acme.voice.claude',
                    qualifiedId: 'acme.voice.claude',
                    identity: { pluginId: 'acme.voice', localId: 'claude' },
                    installedPackage,
                    projectionGeneration: 12,
                    channel: 'plugin',
                    isBuiltIn: false,
                },
            },
        });

        expect(projection).toEqual(expect.objectContaining({
            agentId: 'acme.voice.claude',
            qualifiedId: 'acme.voice.claude',
            identity: { pluginId: 'acme.voice', localId: 'claude' },
            installedPackage,
            projectionGeneration: 12,
        }));
    });

    it('derives plugin providers from merged backend truth instead of treating plugin backend ids as provider ids', () => {
        const params = {
            enabledAgentIds: ['claude', 'acme.review.backend'],
            mergedBackendProjectionById: {
                'acme.review.backend': {
                    backendId: 'acme.review.backend',
                    agentId: 'acme.review.provider',
                    title: 'Acme Review Backend',
                    subtitle: 'Plugin-backed review engine',
                },
            },
            mergedProviderProjectionById: {
                'acme.review.provider': {
                    agentId: 'acme.review.provider',
                    title: 'Acme Review Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
        };

        const entries = getResolvedAgentCatalogEntries(params);

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                agentId: 'acme.review.provider',
                title: 'Acme Review Provider',
                subtitle: 'Plugin provider',
                channel: 'plugin',
                isBuiltIn: false,
            }),
        ]));
        expect(entries.find((entry) => entry.agentId === 'acme.review.backend')).toBeUndefined();

        expect(resolveAgentCatalogProjection('acme.review.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.review.provider',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
        }));
    });

    it('projects bundled UI behavior from an explicit backing Agent without collapsing an external identity', () => {
        const params = {
            enabledAgentIds: ['acme.agent.backend'],
            mergedBackendProjectionById: {
                'acme.agent.backend': {
                    backendId: 'acme.agent.backend',
                    agentId: 'acme.agent',
                    title: 'Acme Review Backend',
                    subtitle: 'Plugin-backed review engine',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
            },
            mergedProviderProjectionById: {
                'acme.agent': {
                    agentId: 'acme.agent',
                    title: 'Acme Review Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    settingsBackendId: 'acme.agent.backend',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveAgentCatalogProjection('acme.agent', params)).toEqual(expect.objectContaining({
            agentId: 'acme.agent',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
            iconName: getAgentCore('codex').ui.agentPickerIconName,
            backendTargetKey: 'backend:acme.agent.backend',
            descriptor: expect.objectContaining({ agentId: 'claude' }),
            behavior: expect.objectContaining({ agentId: 'claude' }),
            authPlugin: expect.objectContaining({ agentId: 'claude' }),
        }));
    });

    it('preserves projected icon/runtime metadata even when a plugin provider has no built-in runtime carrier', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.headless.provider': {
                    agentId: 'acme.headless.provider',
                    title: 'Acme Headless Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    catalogAgentId: null,
                    iconAgentId: 'claude' as const,
                },
            },
            mergedBackendProjectionById: {
                'acme.headless.backend': {
                    backendId: 'acme.headless.backend',
                    agentId: 'acme.headless.provider',
                    title: 'Acme Headless Backend',
                    subtitle: 'Plugin backend',
                    catalogAgentId: null,
                    iconAgentId: 'claude' as const,
                },
            },
        };

        expect(resolveAgentCatalogProjection('acme.headless.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.headless.provider',
            catalogAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
        }));
    });

    it('materializes a first-class provider projection from backend-only merged daemon truth', () => {
        const params = {
            enabledAgentIds: [],
            mergedBackendProjectionById: {
                'acme.backend.only': {
                    backendId: 'acme.backend.only',
                    agentId: 'acme.backend.provider',
                    title: 'Acme Backend Only',
                    subtitle: 'Projected from backend truth',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveAgentCatalogProjection('acme.backend.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.backend.provider',
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
            title: 'Acme Backend Only',
            subtitle: 'Projected from backend truth',
            channel: 'plugin',
            isBuiltIn: false,
            backendTargetKey: 'backend:acme.backend.only',
            descriptor: expect.objectContaining({ agentId: 'claude' }),
            behavior: expect.objectContaining({ agentId: 'claude' }),
            authPlugin: expect.objectContaining({ agentId: 'claude' }),
        }));
    });

    it('uses the explicit provider settings backend binding from merged daemon projection when a plugin provider owns multiple backends', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.multi.provider': {
                    agentId: 'acme.multi.provider',
                    title: 'Acme Multi Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    settingsBackendId: 'acme.multi.secondary',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
            mergedBackendProjectionById: {
                'acme.multi.primary': {
                    backendId: 'acme.multi.primary',
                    agentId: 'acme.multi.provider',
                    title: 'Acme Primary Backend',
                    subtitle: 'Primary backend',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
                'acme.multi.secondary': {
                    backendId: 'acme.multi.secondary',
                    agentId: 'acme.multi.provider',
                    title: 'Acme Secondary Backend',
                    subtitle: 'Secondary backend',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveAgentCatalogProjection('acme.multi.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.multi.provider',
            title: 'Acme Multi Provider',
            subtitle: 'Plugin provider',
            backendTargetKey: 'backend:acme.multi.secondary',
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
        }));
    });

    it('does not guess a writable backend target for multi-backend plugin providers when no explicit settings binding exists', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.ambiguous.provider': {
                    agentId: 'acme.ambiguous.provider',
                    title: 'Acme Ambiguous Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
            mergedBackendProjectionById: {
                'acme.ambiguous.primary': {
                    backendId: 'acme.ambiguous.primary',
                    agentId: 'acme.ambiguous.provider',
                    title: 'Acme Primary Backend',
                    subtitle: 'Primary backend',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
                'acme.ambiguous.secondary': {
                    backendId: 'acme.ambiguous.secondary',
                    agentId: 'acme.ambiguous.provider',
                    title: 'Acme Secondary Backend',
                    subtitle: 'Secondary backend',
                    catalogAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveAgentCatalogProjection('acme.ambiguous.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.ambiguous.provider',
            title: 'Acme Ambiguous Provider',
            subtitle: 'Plugin provider',
            backendTargetKey: null,
        }));
    });

    it('keeps built-in provider settings enablement on the canonical target while reading legacy Antigravity target state', () => {
        const params = {
            enabledAgentIds: ['antigravity'],
            mergedProviderProjectionById: {
                antigravity: {
                    agentId: 'antigravity',
                    title: 'Antigravity',
                    subtitle: 'Antigravity CLI',
                    channel: 'experimental' as const,
                    isBuiltIn: true,
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity' as const,
                    iconAgentId: 'antigravity' as const,
                },
            },
            mergedBackendProjectionById: {
                'antigravity-localharness': {
                    backendId: 'antigravity-localharness',
                    agentId: 'antigravity',
                    title: 'Antigravity Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'antigravity' as const,
                    iconAgentId: 'antigravity' as const,
                },
            },
            backendEnabledByTargetKey: {
                'backend:antigravity-localharness': false,
            },
        };

        expect(resolveAgentCatalogProjection('antigravity', params)).toEqual(expect.objectContaining({
            agentId: 'antigravity',
            backendTargetKey: 'agent:happier.agent.antigravity/antigravity',
            enabled: false,
        }));

        expect(resolveAgentCatalogProjection('antigravity', {
            ...params,
            backendEnabledByTargetKey: {
                'agent:happier.agent.antigravity/antigravity': true,
                'backend:antigravity-localharness': false,
            },
        })).toEqual(expect.objectContaining({
            agentId: 'antigravity',
            backendTargetKey: 'agent:happier.agent.antigravity/antigravity',
            enabled: true,
        }));
    });

    it('preserves canonical built-in provider casing for camel-case agent ids', () => {
        const params = {
            enabledAgentIds: ['ohMyPi'],
        };

        expect(getResolvedAgentCatalogEntries(params)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                agentId: 'ohMyPi',
                catalogAgentId: 'ohMyPi',
                backendTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
                channel: 'stable',
                isBuiltIn: true,
            }),
        ]));

        expect(resolveAgentCatalogProjection('ohMyPi', params)).toEqual(expect.objectContaining({
            agentId: 'ohMyPi',
            catalogAgentId: 'ohMyPi',
            backendTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
            channel: 'stable',
            isBuiltIn: true,
        }));
    });

    it('falls back to provider identity when merged projection channel is null', () => {
        const params = {
            enabledAgentIds: ['codex'],
            mergedProviderProjectionById: {
                codex: {
                    agentId: 'codex',
                    title: 'Codex',
                    subtitle: 'OpenAI Codex',
                    channel: null,
                    isBuiltIn: true,
                },
                'acme.null.channel.provider': {
                    agentId: 'acme.null.channel.provider',
                    title: 'Acme Null Channel',
                    subtitle: 'Plugin provider',
                    channel: null,
                    isBuiltIn: false,
                },
            },
        };

        expect(resolveAgentCatalogProjection('codex', params)).toEqual(expect.objectContaining({
            agentId: 'codex',
            channel: 'stable',
        }));
        expect(resolveAgentCatalogProjection('acme.null.channel.provider', params)).toEqual(expect.objectContaining({
            agentId: 'acme.null.channel.provider',
            channel: 'plugin',
        }));
    });
});
