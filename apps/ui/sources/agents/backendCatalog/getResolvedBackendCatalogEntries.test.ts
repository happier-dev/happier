import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { getResolvedBackendCatalogEntries, resolveCatalogAgentIdForBackendTarget } from './getResolvedBackendCatalogEntries';

type BackendCatalogParams = Parameters<typeof getResolvedBackendCatalogEntries>[0];

describe('getResolvedBackendCatalogEntries', () => {
    it('does not fabricate a customAcp provider id for non-built-in backend targets', () => {
        expect(resolveCatalogAgentIdForBackendTarget({ kind: 'backend', backendId: 'claude' })).toBe('claude');
        expect(resolveCatalogAgentIdForBackendTarget({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' })).toBeNull();
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
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                title: 't:agentInput.agent.claude',
            }),
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                kind: 'configuredBackend',
                agentId: 'review-bot',
                catalogAgentId: null,
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
            catalogAgentId: null,
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
                    agentId: 'kiro',
                    title: 'Review Bot',
                    subtitle: 'Configured Kiro backend',
                    catalogAgentId: 'kiro',
                    iconAgentId: 'kiro',
                },
            },
            mergedProviderProjectionById: {
                kiro: {
                    agentId: 'kiro',
                    title: 'Kiro',
                    subtitle: 'Built-in provider',
                    isBuiltIn: true,
                    catalogAgentId: 'kiro',
                    iconAgentId: 'kiro',
                },
            },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                kind: 'configuredBackend',
                agentId: 'kiro',
                catalogAgentId: 'kiro',
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
                agentId: 'acme.review.backend',
                backendId: 'acme.review.backend',
                builtInAgentId: null,
                catalogAgentId: null,
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

        const entries = getResolvedBackendCatalogEntries(params);

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                backendTargetKey: 'backend:acme.review.backend',
                kind: 'pluginBackend',
                agentId: 'acme.review.provider',
                backendId: 'acme.review.backend',
                title: 'Acme Review Backend',
                subtitle: 'Plugin-backed review engine',
            }),
        ]));
    });

    it('falls back to provider-level runtime carrier metadata when a plugin backend projection omits catalogAgentId', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['acme.review.backend'],
            acpCatalogSettingsV1: { v: 2 as const, backends: [] },
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
                    catalogAgentId: 'claude',
                    iconAgentId: 'codex',
                },
            },
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTargetKey: 'backend:acme.review.backend',
                agentId: 'acme.review.provider',
                catalogAgentId: 'claude',
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

    it('collapses discovered provider-owned concrete backends behind the canonical provider row', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['antigravity'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            discoveredBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
            mergedProviderProjectionById: {
                antigravity: {
                    agentId: 'antigravity',
                    title: 'Antigravity',
                    subtitle: 'Antigravity CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
            },
            mergedBackendProjectionById: {
                'antigravity-localharness': {
                    backendId: 'antigravity-localharness',
                    agentId: 'antigravity',
                    title: 'Antigravity Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
                'antigravity-terminal': {
                    backendId: 'antigravity-terminal',
                    agentId: 'antigravity',
                    title: 'Antigravity Terminal',
                    subtitle: 'Terminal runtime',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
            },
        });

        expect(entries).toEqual([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'antigravity' },
                backendTargetKey: 'backend:antigravity',
                kind: 'builtInAgent',
                backendId: 'antigravity',
                agentId: 'antigravity',
                catalogAgentId: 'antigravity',
                builtInAgentId: 'antigravity',
                iconAgentId: 'antigravity',
                title: 't:agentInput.agent.antigravity',
            }),
        ]);
    });

    it('collapses configured provider-owned concrete backends behind the canonical provider row', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['antigravity'],
            collapseConfiguredBackendProviderSentinels: true,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'antigravity-localharness',
                        name: 'antigravity-localharness',
                        title: 'Antigravity Localharness',
                        description: 'Structured local runtime',
                        command: 'agy-localharness',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'default',
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
                    {
                        id: 'antigravity-terminal',
                        name: 'antigravity-terminal',
                        title: 'Antigravity Terminal',
                        description: 'Terminal runtime',
                        command: 'antigravity',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'default',
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
            mergedProviderProjectionById: {
                antigravity: {
                    agentId: 'antigravity',
                    title: 'Antigravity',
                    subtitle: 'Antigravity CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
            },
            mergedBackendProjectionById: {
                'antigravity-localharness': {
                    backendId: 'antigravity-localharness',
                    agentId: 'antigravity',
                    title: 'Antigravity Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                    capabilities: { session: { supported: true } },
                },
                'antigravity-terminal': {
                    backendId: 'antigravity-terminal',
                    agentId: 'antigravity',
                    title: 'Antigravity Terminal',
                    subtitle: 'Terminal runtime',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                    capabilities: { session: { supported: true } },
                },
            },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual(['backend:antigravity']);
        expect(entries[0]).toEqual(expect.objectContaining({
            kind: 'builtInAgent',
            backendTarget: { kind: 'backend', backendId: 'antigravity' },
            builtInAgentId: 'antigravity',
            title: 't:agentInput.agent.antigravity',
        }));
    });

    it('uses provider-level enablement for collapsed provider-owned settings backend rows', () => {
        const baseParams = {
            enabledAgentIds: ['antigravity'],
            acpCatalogSettingsV1: { v: 2 as const, backends: [] },
            mergedProviderProjectionById: {
                antigravity: {
                    agentId: 'antigravity',
                    title: 'Antigravity',
                    subtitle: 'Antigravity CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
            },
            mergedBackendProjectionById: {
                'antigravity-localharness': {
                    backendId: 'antigravity-localharness',
                    agentId: 'antigravity',
                    title: 'Antigravity Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
            },
        } satisfies Omit<BackendCatalogParams, 'backendEnabledByTargetKey'>;

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:antigravity': true,
            },
        })).toEqual([
            expect.objectContaining({
                backendTargetKey: 'backend:antigravity',
                backendTarget: { kind: 'backend', backendId: 'antigravity' },
                title: 't:agentInput.agent.antigravity',
            }),
        ]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:antigravity': false,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:antigravity-localharness': false,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            enabledAgentIds: [],
            backendEnabledByTargetKey: {
                'backend:antigravity': false,
                'backend:antigravity-localharness': true,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:antigravity-localharness:configured:antigravity-localharness': false,
            },
        })).toEqual([]);
    });

    it('collapses configured plugin provider-owned concrete backends behind the provider settings backend row', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: [],
            collapseConfiguredBackendProviderSentinels: true,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'plugin-runtime',
                        name: 'plugin-runtime',
                        title: 'Plugin Runtime',
                        description: 'Plugin runtime backend',
                        command: 'plugin-runtime',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'default',
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
            mergedProviderProjectionById: {
                'plugin-provider': {
                    agentId: 'plugin-provider',
                    title: 'Plugin Provider',
                    subtitle: 'Provider settings',
                    settingsBackendId: 'plugin-runtime',
                },
            },
            mergedBackendProjectionById: {
                'plugin-runtime': {
                    backendId: 'plugin-runtime',
                    agentId: 'plugin-provider',
                    title: 'Plugin Runtime',
                    subtitle: 'Runtime backend',
                },
            },
        });

        expect(entries).toEqual([
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'plugin-runtime' },
                backendTargetKey: 'backend:plugin-runtime',
                kind: 'pluginBackend',
                backendId: 'plugin-runtime',
                agentId: 'plugin-provider',
                builtInAgentId: null,
                title: 'Plugin Provider',
            }),
        ]);
    });

    it('honors legacy configured-target enablement for collapsed plugin provider-owned settings backend rows', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: [],
            collapseConfiguredBackendProviderSentinels: true,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'plugin-runtime',
                        name: 'plugin-runtime',
                        title: 'Plugin Runtime',
                        description: 'Plugin runtime backend',
                        command: 'plugin-runtime',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        defaultMode: 'plan',
                        defaultModel: 'default',
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
            backendEnabledByTargetKey: {
                'backend:plugin-runtime:configured:plugin-runtime': false,
            },
            mergedProviderProjectionById: {
                'plugin-provider': {
                    agentId: 'plugin-provider',
                    title: 'Plugin Provider',
                    subtitle: 'Provider settings',
                    settingsBackendId: 'plugin-runtime',
                },
            },
            mergedBackendProjectionById: {
                'plugin-runtime': {
                    backendId: 'plugin-runtime',
                    agentId: 'plugin-provider',
                    title: 'Plugin Runtime',
                    subtitle: 'Runtime backend',
                },
            },
        });

        expect(entries).toEqual([]);
    });
});
