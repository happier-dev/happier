import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { getResolvedBackendCatalogEntries, resolveProviderAgentIdForBackendTarget } from './getResolvedBackendCatalogEntries';

describe('getResolvedBackendCatalogEntries', () => {
    it('does not fabricate a customAcp provider id for non-built-in backend targets', () => {
        expect(resolveProviderAgentIdForBackendTarget({ kind: 'backend', backendId: 'claude' })).toBe('claude');
        expect(resolveProviderAgentIdForBackendTarget({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' })).toBeNull();
    });

    it('returns built-in agents followed by configured ACP backends without surfacing the custom ACP container backend', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'customAcp'],
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        command: 'kiro-cli',
                        args: ['acp', '--agent', 'review'],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        });

        expect(entries).toEqual([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'claude' },
                backendTargetKey: 'backend:claude',
                kind: 'builtInAgent',
                providerAgentId: 'claude',
                iconAgentId: 'claude',
                title: 't:agentInput.agent.claude',
            }),
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                kind: 'configuredBackend',
                providerId: 'review-bot',
                providerAgentId: null,
                iconAgentId: null,
                title: 'Review Bot',
                subtitle: 'review-bot',
            }),
        ]);
    });

    it('omits configured ACP backends disabled by target key', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'customAcp'],
            backendEnabledByTargetKey: {
                'backend:review-bot:configured:review-bot': false,
            },
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        command: 'kiro-cli',
                        args: ['acp', '--agent', 'review'],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual(['backend:claude']);
    });

    it('omits built-in agents disabled by target key even when enabledAgentIds includes them', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'codex'],
            backendEnabledByTargetKey: {
                'backend:claude': false,
            },
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual(['backend:codex']);
    });

    it('omits discovered built-in agents disabled by target key', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            discoveredBackendIds: ['codex'],
            backendEnabledByTargetKey: {
                'backend:codex': false,
            },
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual(['backend:claude']);
    });

    it('keeps configured ACP backends visible when sentinel collapsing is enabled', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'customAcp'],
            collapseConfiguredBackendProviderSentinels: true,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        command: 'kiro-cli',
                        args: ['acp', '--agent', 'review'],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual(['backend:claude', 'backend:review-bot:configured:review-bot']);
        expect(entries[1]).toEqual(expect.objectContaining({
            kind: 'configuredBackend',
            providerAgentId: null,
        }));
    });

    it('uses merged configured-backend projection truth instead of leaving configured ACP entries on the customAcp carrier', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'customAcp'],
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        command: 'kiro-cli',
                        args: ['acp', '--agent', 'review'],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'sonnet',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            mergedBackendProjectionById: {
                'review-bot': {
                    backendId: 'review-bot',
                    providerId: 'kiro',
                    title: 'Review Bot',
                    subtitle: 'Configured Kiro backend',
                    providerAgentId: 'kiro',
                    iconAgentId: 'kiro',
                },
            },
            mergedProviderProjectionById: {
                kiro: {
                    providerId: 'kiro',
                    title: 'Kiro',
                    subtitle: 'Built-in provider',
                    isBuiltIn: true,
                    providerAgentId: 'kiro',
                    iconAgentId: 'kiro',
                },
            },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                kind: 'configuredBackend',
                providerId: 'kiro',
                providerAgentId: 'kiro',
                iconAgentId: 'kiro',
                title: 'Review Bot',
                subtitle: 'Configured Kiro backend',
            }),
        ]));
    });

    it('surfaces unknown backend ids as first-class plugin backend entries instead of collapsing to custom ACP', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'acme.review.backend'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                providerId: 'acme.review.backend',
                backendId: 'acme.review.backend',
                builtInAgentId: null,
                providerAgentId: null,
                iconAgentId: null,
                title: 'Acme Review Backend',
                subtitle: 'acme.review.backend',
            }),
        ]));
    });

    it('uses merged plugin backend truth when provided instead of fabricating a custom ACP provider identity', () => {
        const params = {
            enabledAgentIds: ['claude', 'acme.review.backend'],
            acpCatalogSettingsV1: { v: 2 as const, backends: [] },
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

        const entries = getResolvedBackendCatalogEntries(params);

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                providerId: 'acme.review.provider',
                backendId: 'acme.review.backend',
                title: 'Acme Review Backend',
                subtitle: 'Plugin-backed review engine',
            }),
        ]));
    });

    it('falls back to provider-level runtime carrier metadata when a plugin backend projection omits providerAgentId', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['acme.review.backend'],
            acpCatalogSettingsV1: { v: 2 as const, backends: [] },
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
                    providerAgentId: 'claude',
                    iconAgentId: 'codex',
                },
            },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTargetKey: 'backend:acme.review.backend',
                providerId: 'acme.review.provider',
                providerAgentId: 'claude',
                iconAgentId: 'codex',
            }),
        ]));
    });

    it('materializes backend-target-native discovered ids from canonical v2 backend target keys', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            backendEnabledByTargetKey: {
                'backend:acme.review.backend': true,
            },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
            }),
        ]));
    });
});
