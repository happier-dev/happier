import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    isAgentId: (agentId: string) => agentId === 'codex' || agentId === 'claude',
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agent.${agentId}`,
        availability: { experimental: false },
        ui: {
            agentPickerIconName: agentId === 'claude' ? 'sparkles-outline' : 'code-slash-outline',
        },
    }),
}));

vi.mock('@/agents/providers/catalog/providerLocalAuthCatalog', () => ({
    getProviderLocalAuthPlugin: (providerId: string) => (providerId === 'claude' ? { providerId: 'claude' } : null),
}));

vi.mock('@/agents/catalog/providerSettingsCatalog', () => ({
    PROVIDER_SETTINGS_DESCRIPTORS: [],
    getProviderSettingsDescriptor: (providerId: string) => (
        providerId === 'claude'
            ? {
                providerId: 'claude',
                title: 'Claude',
                icon: { ionName: 'sparkles-outline', color: 'blue' },
                settings: {},
                uiSections: [],
            }
            : null
    ),
    getProviderSettingsBehavior: (providerId: string) => (providerId === 'claude' ? { providerId: 'claude' } : null),
}));

import { getAgentCore } from '@/agents/catalog/catalog';

import {
    getResolvedProviderCatalogEntries,
    resolveProviderCatalogProjection,
} from './providerCatalogProjection';

describe('providerCatalogProjection', () => {
    it('derives plugin providers from merged backend truth instead of treating plugin backend ids as provider ids', () => {
        const params = {
            enabledAgentIds: ['claude', 'acme.review.backend'],
            mergedBackendProjectionById: {
                'acme.review.backend': {
                    backendId: 'acme.review.backend',
                    providerId: 'acme.review.provider',
                    title: 'Acme Review Backend',
                    subtitle: 'Plugin-backed review engine',
                },
            },
            mergedProviderProjectionById: {
                'acme.review.provider': {
                    providerId: 'acme.review.provider',
                    title: 'Acme Review Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
        };

        const entries = getResolvedProviderCatalogEntries(params);

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                providerId: 'acme.review.provider',
                title: 'Acme Review Provider',
                subtitle: 'Plugin provider',
                channel: 'plugin',
                isBuiltIn: false,
            }),
        ]));
        expect(entries.find((entry) => entry.providerId === 'acme.review.backend')).toBeUndefined();

        expect(resolveProviderCatalogProjection('acme.review.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.review.provider',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
        }));
    });

    it('reuses the backing built-in provider settings/auth behavior for a projected plugin provider without collapsing its identity', () => {
        const params = {
            enabledAgentIds: ['acme.review.backend'],
            mergedBackendProjectionById: {
                'acme.review.backend': {
                    backendId: 'acme.review.backend',
                    providerId: 'acme.review.provider',
                    title: 'Acme Review Backend',
                    subtitle: 'Plugin-backed review engine',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
            },
            mergedProviderProjectionById: {
                'acme.review.provider': {
                    providerId: 'acme.review.provider',
                    title: 'Acme Review Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    settingsBackendId: 'acme.review.backend',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveProviderCatalogProjection('acme.review.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.review.provider',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
            providerAgentId: 'claude',
            iconAgentId: 'codex',
            iconName: getAgentCore('codex').ui.agentPickerIconName,
            backendTargetKey: 'backend:acme.review.backend',
            descriptor: expect.objectContaining({ providerId: 'claude' }),
            behavior: expect.objectContaining({ providerId: 'claude' }),
            authPlugin: expect.objectContaining({ providerId: 'claude' }),
        }));
    });

    it('preserves projected icon/runtime metadata even when a plugin provider has no built-in runtime carrier', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.headless.provider': {
                    providerId: 'acme.headless.provider',
                    title: 'Acme Headless Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    providerAgentId: null,
                    iconAgentId: 'claude' as const,
                },
            },
            mergedBackendProjectionById: {
                'acme.headless.backend': {
                    backendId: 'acme.headless.backend',
                    providerId: 'acme.headless.provider',
                    title: 'Acme Headless Backend',
                    subtitle: 'Plugin backend',
                    providerAgentId: null,
                    iconAgentId: 'claude' as const,
                },
            },
        };

        expect(resolveProviderCatalogProjection('acme.headless.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.headless.provider',
            providerAgentId: null,
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
                    providerId: 'acme.backend.provider',
                    title: 'Acme Backend Only',
                    subtitle: 'Projected from backend truth',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveProviderCatalogProjection('acme.backend.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.backend.provider',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
            title: 'Acme Backend Only',
            subtitle: 'Projected from backend truth',
            channel: 'plugin',
            isBuiltIn: false,
            backendTargetKey: 'backend:acme.backend.only',
            descriptor: expect.objectContaining({ providerId: 'claude' }),
            behavior: expect.objectContaining({ providerId: 'claude' }),
            authPlugin: expect.objectContaining({ providerId: 'claude' }),
        }));
    });

    it('uses the explicit provider settings backend binding from merged daemon projection when a plugin provider owns multiple backends', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.multi.provider': {
                    providerId: 'acme.multi.provider',
                    title: 'Acme Multi Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                    settingsBackendId: 'acme.multi.secondary',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
            mergedBackendProjectionById: {
                'acme.multi.primary': {
                    backendId: 'acme.multi.primary',
                    providerId: 'acme.multi.provider',
                    title: 'Acme Primary Backend',
                    subtitle: 'Primary backend',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
                'acme.multi.secondary': {
                    backendId: 'acme.multi.secondary',
                    providerId: 'acme.multi.provider',
                    title: 'Acme Secondary Backend',
                    subtitle: 'Secondary backend',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveProviderCatalogProjection('acme.multi.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.multi.provider',
            title: 'Acme Multi Provider',
            subtitle: 'Plugin provider',
            backendTargetKey: 'backend:acme.multi.secondary',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
        }));
    });

    it('does not guess a writable backend target for multi-backend plugin providers when no explicit settings binding exists', () => {
        const params = {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                'acme.ambiguous.provider': {
                    providerId: 'acme.ambiguous.provider',
                    title: 'Acme Ambiguous Provider',
                    subtitle: 'Plugin provider',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
            mergedBackendProjectionById: {
                'acme.ambiguous.primary': {
                    backendId: 'acme.ambiguous.primary',
                    providerId: 'acme.ambiguous.provider',
                    title: 'Acme Primary Backend',
                    subtitle: 'Primary backend',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'claude' as const,
                },
                'acme.ambiguous.secondary': {
                    backendId: 'acme.ambiguous.secondary',
                    providerId: 'acme.ambiguous.provider',
                    title: 'Acme Secondary Backend',
                    subtitle: 'Secondary backend',
                    providerAgentId: 'claude' as const,
                    iconAgentId: 'codex' as const,
                },
            },
        };

        expect(resolveProviderCatalogProjection('acme.ambiguous.provider', params)).toEqual(expect.objectContaining({
            providerId: 'acme.ambiguous.provider',
            title: 'Acme Ambiguous Provider',
            subtitle: 'Plugin provider',
            backendTargetKey: null,
        }));
    });
});
