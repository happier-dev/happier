import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { getResolvedBackendCatalogEntries, resolveCatalogAgentIdForBackendTarget } from './getResolvedBackendCatalogEntries';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';
import type { BundledAgentId } from '@/agents/catalog/catalog';

type BackendCatalogParams = Parameters<typeof getResolvedBackendCatalogEntries>[0];

function bundledAgentTarget(agentId: BundledAgentId) {
    return {
        kind: 'agent' as const,
        identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId],
    };
}

function bundledAgentTargetKey(agentId: BundledAgentId): string {
    const identity = BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId];
    return `agent:${identity.pluginId}/${identity.localId}`;
}

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
                backendTarget: bundledAgentTarget('claude'),
                backendTargetKey: bundledAgentTargetKey('claude'),
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

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('claude')]);
    });

    it('omits built-in agents disabled by target key even when enabledAgentIds includes them', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'codex'],
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('claude')]: false,
            },
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('codex')]);
    });

    it('omits discovered built-in agents disabled by target key', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            discoveredBackendIds: ['codex'],
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('codex')]: false,
            },
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('claude')]);
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

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('claude'), 'backend:review-bot:configured:review-bot']);
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

    it('does not fabricate an Agent identity for an unprojected unknown id', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'acme.review.backend'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
        });

        expect(entries.some((entry) => entry.agentId === 'acme.review.backend')).toBe(false);
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
                    identity: { pluginId: 'acme.review', localId: 'provider' },
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
                backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } },
                backendTargetKey: 'agent:acme.review/provider',
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
                    identity: { pluginId: 'acme.review', localId: 'provider' },
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
                backendTargetKey: 'agent:acme.review/provider',
                agentId: 'acme.review.provider',
                catalogAgentId: 'claude',
                iconAgentId: 'codex',
            }),
        ]));
    });

    it('does not materialize an unprojected arbitrary backend from target enablement alone', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            backendEnabledByTargetKey: {
                'backend:acme.review.backend': true,
            },
        });

        expect(entries.some((entry) => entry.backendTargetKey === 'backend:acme.review.backend')).toBe(false);
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
                backendTarget: bundledAgentTarget('antigravity'),
                backendTargetKey: bundledAgentTargetKey('antigravity'),
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

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('antigravity')]);
        expect(entries[0]).toEqual(expect.objectContaining({
            kind: 'builtInAgent',
            backendTarget: bundledAgentTarget('antigravity'),
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
                [bundledAgentTargetKey('antigravity')]: true,
            },
        })).toEqual([
            expect.objectContaining({
                backendTargetKey: bundledAgentTargetKey('antigravity'),
                backendTarget: bundledAgentTarget('antigravity'),
                title: 't:agentInput.agent.antigravity',
            }),
        ]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('antigravity')]: false,
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
                [bundledAgentTargetKey('antigravity')]: false,
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
                    identity: { pluginId: 'acme.runtime', localId: 'provider' },
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
                backendTarget: { kind: 'agent', identity: { pluginId: 'acme.runtime', localId: 'provider' } },
                backendTargetKey: 'agent:acme.runtime/provider',
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
                    identity: { pluginId: 'acme.runtime', localId: 'provider' },
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
    it('makes a standalone installed Session Agent selectable from the current agents projection', () => {
        // The daemon's V2 projection carries no parallel backend registry, so an
        // installed Agent that contributes no configured/settings backend reaches
        // the client only through `agentsById`. `enabledAgentIds` is the closed
        // bundled seed and can never name it.
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            collapseConfiguredBackendProviderSentinels: true,
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                'acme.review': {
                    agentId: 'acme.review',
                    identity: { pluginId: 'acme.review', localId: 'review' },
                    title: 'Acme Review',
                    subtitle: 'Installed review Agent',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
            discoveredBackendIds: [],
        });

        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } },
                backendTargetKey: 'agent:acme.review/review',
                kind: 'pluginBackend',
                agentId: 'acme.review',
                backendId: 'acme.review',
                builtInAgentId: null,
                catalogAgentId: null,
                title: 'Acme Review',
                subtitle: 'Installed review Agent',
            }),
        ]));
    });

    it('keeps an installed plugin Agent neutral when its projected CLI auth metadata is absent', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            collapseConfiguredBackendProviderSentinels: true,
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
            discoveredBackendIds: [],
        });

        expect(entries.find((entry) => entry.agentId === 'claude')).toEqual(expect.objectContaining({
            cliAuthBackgroundCheckSafe: false,
        }));
    });

    it('omits an installed Session Agent the user disabled', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            collapseConfiguredBackendProviderSentinels: true,
            backendEnabledByTargetKey: { 'agent:acme.review/review': false },
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                'acme.review': {
                    agentId: 'acme.review',
                    identity: { pluginId: 'acme.review', localId: 'review' },
                    title: 'Acme Review',
                    channel: 'plugin' as const,
                    isBuiltIn: false,
                },
            },
            discoveredBackendIds: [],
        });

        expect(entries.map((entry) => entry.backendTargetKey)).not.toContain('agent:acme.review/review');
        expect(entries.map((entry) => entry.backendTargetKey)).toContain(bundledAgentTargetKey('claude'));
    });

    it('does not resurrect a bundled Agent the enabled seed filtered out', () => {
        // The bundled seed owns bundled selection policy. Projecting a bundled
        // Agent must not be a second way into the picker.
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            collapseConfiguredBackendProviderSentinels: true,
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {
                claude: { agentId: 'claude', title: 'Claude', isBuiltIn: true },
                codex: { agentId: 'codex', title: 'Codex', isBuiltIn: true },
            },
            discoveredBackendIds: [],
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('claude')]);
    });
});
