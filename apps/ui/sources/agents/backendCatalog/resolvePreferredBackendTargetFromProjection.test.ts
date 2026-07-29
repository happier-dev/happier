import { describe, expect, it } from 'vitest';

import { resolvePreferredBackendTargetFromProjection } from './resolvePreferredBackendTargetFromProjection';

describe('resolvePreferredBackendTargetFromProjection', () => {
    it('routes an Antigravity provider default selection to the canonical provider backend', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'antigravity',
            lastUsedBackendTarget: null,
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
            daemonMergedProjectionInputs: {
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
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'antigravity' });
    });

    it('normalizes an old persisted Antigravity concrete target to the canonical provider backend', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'antigravity-terminal' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
            daemonMergedProjectionInputs: {
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
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'antigravity' });
    });

    it('normalizes an old persisted configured Antigravity target to the canonical provider backend', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'antigravity-localharness',
                configuredBackendId: 'antigravity-localharness',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
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
                ],
            },
            daemonMergedProjectionInputs: {
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
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'antigravity' });
    });

    it('keeps a daemon-projected plugin backend as the preferred target when it has no built-in runtime carrier', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['acme.review.backend'],
                mergedProviderProjectionById: {
                    'acme.review.provider': {
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Provider',
                        subtitle: 'Plugin provider',
                        isBuiltIn: false,
                    },
                },
                mergedBackendProjectionById: {
                    'acme.review.backend': {
                        backendId: 'acme.review.backend',
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Backend',
                        subtitle: 'Plugin-backed review engine',
                        capabilities: { session: { supported: true } },
                    },
                },
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'acme.review.backend' });
    });

    it('does not let a projected plugin settings backend hijack the built-in fallback for legacy customAcp', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            defaultBuiltInAgentId: 'claude',
            acpCatalogSettingsV1: { v: 2, backends: [] },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['acme.review.backend'],
                mergedProviderProjectionById: {
                    'acme.review.provider': {
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Provider',
                        subtitle: 'Plugin provider',
                        isBuiltIn: false,
                        settingsBackendId: 'acme.review.backend',
                    },
                },
                mergedBackendProjectionById: {
                    'acme.review.backend': {
                        backendId: 'acme.review.backend',
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Backend',
                        subtitle: 'Plugin-backed review engine',
                        capabilities: { session: { supported: true } },
                    },
                },
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'claude' });
    });

    it('normalizes an old configured plugin provider-owned target to the collapsed provider settings backend', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'plugin-runtime',
                configuredBackendId: 'plugin-runtime',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['plugin-provider', 'claude'],
            backendEnabledByTargetKey: {},
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
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['plugin-runtime'],
                mergedProviderProjectionById: {
                    'plugin-provider': {
                        agentId: 'plugin-provider',
                        title: 'Plugin Provider',
                        subtitle: 'Provider settings',
                        isBuiltIn: false,
                        settingsBackendId: 'plugin-runtime',
                    },
                },
                mergedBackendProjectionById: {
                    'plugin-runtime': {
                        backendId: 'plugin-runtime',
                        agentId: 'plugin-provider',
                        title: 'Plugin Runtime',
                        subtitle: 'Runtime backend',
                        capabilities: { session: { supported: true } },
                    },
                },
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'backend', backendId: 'plugin-runtime' });
    });

    it('preserves a configured custom backend target when daemon projection inputs are absent', () => {
        expect(resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        command: 'review-bot',
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
            daemonMergedProjectionInputs: null,
        })).toEqual({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
        });
    });
});
