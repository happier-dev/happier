import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `t:${key}`,
    });
});

import { getResolvedBackendCatalogEntries as readBackendCatalog, resolveCatalogAgentIdForBackendTarget } from './getResolvedBackendCatalogEntries';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import type { BundledAgentId } from '@/agents/catalog/catalog';
import { AcpBackendDefinitionV1Schema, type AcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

type BackendCatalogParams = Parameters<typeof readBackendCatalog>[0] & { acpCatalogSettingsV1?: AcpCatalogSettingsV1 };
// Existing definition vectors are fixture inputs, not Account Settings authority.
function getResolvedBackendCatalogEntries({ acpCatalogSettingsV1, ...params }: BackendCatalogParams) {
    return readBackendCatalog({ ...params, ...(params.acpCatalogSnapshot || !acpCatalogSettingsV1 ? {} : {
        acpCatalogSnapshot: { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: acpCatalogSettingsV1.backends } },
    }) });
}

function bundledAgentTarget(agentId: BundledAgentId) {
    return {
        kind: 'agent' as const,
        identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId],
    };
}

function bundledAgentTargetKey(agentId: BundledAgentId): string {
    const identity = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId];
    return `agent:${identity.pluginId}/${identity.localId}`;
}

function configuredAgentTarget(definitionId: string) {
    return { kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId };
}

function configuredAgentTargetKey(definitionId: string) {
    return `agent:happier.agent.custom-acp/custom-acp:definition:${definitionId}`;
}

describe('getResolvedBackendCatalogEntries', () => {
    it('projects a declared Custom ACP container only as definition-qualified selectable instances', () => {
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'review-a', name: 'review-a', title: 'Review', command: 'review',
            args: [], env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1 });
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['custom-acp'],
            mergedProviderProjectionById: { 'custom-acp': { agentId: 'custom-acp',
                identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, isBuiltIn: true } },
            acpCatalogSnapshot: { status: 'ready', revision: 4, record: { v: 1, definitions: [definition] } },
        });
        expect(entries.map((entry) => entry.backendTarget)).toEqual([configuredAgentTarget('review-a')]);
    });
    it('projects two configured definitions as distinct selections of one declared Custom ACP Agent', () => {
        const definitions = ['review-a', 'review-b'].map((id) => AcpBackendDefinitionV1Schema.parse({
            id, name: id, title: id, command: id, args: [], env: {},
            capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
        }));
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: [],
            acpCatalogSnapshot: { status: 'ready', revision: 4, record: { v: 1, definitions } } });
        expect(entries.map((entry) => entry.backendTarget)).toEqual(definitions.map(({ id }) => ({
            kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: id,
        })));
        expect(new Set(entries.map((entry) => entry.backendTargetKey)).size).toBe(2);
        expect(entries.map((entry) => entry.agentCatalogEntry.identity)).toEqual(definitions.map(() => ({
            pluginId: 'happier.agent.custom-acp', localId: 'custom-acp',
        })));
    });
    it('keeps bundled Agents available while ACP rows load or are unavailable, and adds configured rows only when ready', () => {
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review', command: 'review',
            args: [], env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1 });
        const readyEntries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude'],
            acpCatalogSnapshot: { status: 'ready', revision: 4, record: { v: 1, definitions: [definition] } } });
        expect(readyEntries).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'builtInAgent', builtInAgentId: 'claude' }),
            expect.objectContaining({ kind: 'configuredBackend', backendId: 'row-review', title: 'Row review' }),
        ]));
        for (const acpCatalogSnapshot of [
            undefined,
            { status: 'loading' as const },
            { status: 'unavailable' as const, reason: 'source-transfer-required' },
        ]) {
            expect(getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude'], acpCatalogSnapshot })).toEqual([
                expect.objectContaining({ kind: 'builtInAgent', builtInAgentId: 'claude' }),
            ]);
        }
    });
    it('keeps missing Agent subtitles absent instead of displaying routing ids', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            mergedProviderProjectionById: {
                'acme.review': {
                    agentId: 'acme.review',
                    identity: { pluginId: 'acme.review', localId: 'review' },
                    title: 'Acme Review',
                    channel: 'plugin',
                    isBuiltIn: false,
                },
            },
        });
        expect(entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'claude', subtitle: null }),
            expect.objectContaining({ agentId: 'acme.review', subtitle: null }),
        ]));
    });
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
                backendTarget: configuredAgentTarget('review-bot'),
                backendTargetKey: configuredAgentTargetKey('review-bot'),
                kind: 'configuredBackend',
                agentId: 'custom-acp',
                title: 'Review Bot',
                subtitle: null,
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

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('claude'), configuredAgentTargetKey('review-bot')]);
        expect(entries[1]).toEqual(expect.objectContaining({
            kind: 'configuredBackend',
            agentId: 'custom-acp',
        }));
    });

    it('keeps configured ACP definitions on their declared contribution despite stale unrelated backend projections', () => {
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
                backendTarget: configuredAgentTarget('review-bot'),
                backendTargetKey: configuredAgentTargetKey('review-bot'),
                kind: 'configuredBackend',
                agentId: 'custom-acp',
                title: 'Review Bot',
                subtitle: null,
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
            enabledAgentIds: ['codex'],
            acpCatalogSettingsV1: { v: 2, backends: [] },
            discoveredBackendIds: ['codex-localharness', 'codex-terminal'],
            mergedProviderProjectionById: {
                codex: {
                    agentId: 'codex',
                    title: 'Codex',
                    subtitle: 'Codex CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'codex-localharness',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
            },
            mergedBackendProjectionById: {
                'codex-localharness': {
                    backendId: 'codex-localharness',
                    agentId: 'codex',
                    title: 'Codex Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
                'codex-terminal': {
                    backendId: 'codex-terminal',
                    agentId: 'codex',
                    title: 'Codex Terminal',
                    subtitle: 'Terminal runtime',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
            },
        });

        expect(entries).toEqual([
            expect.objectContaining({
                backendTarget: bundledAgentTarget('codex'),
                backendTargetKey: bundledAgentTargetKey('codex'),
                kind: 'builtInAgent',
                backendId: 'codex',
                agentId: 'codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
                title: 't:agentInput.agent.codex',
            }),
        ]);
    });

    it('retains private definitions independently of bundled Agent settings backend aliases', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['codex'],
            collapseConfiguredBackendProviderSentinels: true,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'codex-localharness',
                        name: 'codex-localharness',
                        title: 'Codex Localharness',
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
                        id: 'codex-terminal',
                        name: 'codex-terminal',
                        title: 'Codex Terminal',
                        description: 'Terminal runtime',
                        command: 'codex',
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
                codex: {
                    agentId: 'codex',
                    title: 'Codex',
                    subtitle: 'Codex CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'codex-localharness',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
            },
            mergedBackendProjectionById: {
                'codex-localharness': {
                    backendId: 'codex-localharness',
                    agentId: 'codex',
                    title: 'Codex Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                    capabilities: { session: { supported: true } },
                },
                'codex-terminal': {
                    backendId: 'codex-terminal',
                    agentId: 'codex',
                    title: 'Codex Terminal',
                    subtitle: 'Terminal runtime',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                    capabilities: { session: { supported: true } },
                },
            },
        });

        expect(entries.map((entry) => entry.backendTargetKey)).toEqual([bundledAgentTargetKey('codex'),
            configuredAgentTargetKey('codex-localharness'), configuredAgentTargetKey('codex-terminal')]);
        expect(entries[0]).toEqual(expect.objectContaining({
            kind: 'builtInAgent',
            backendTarget: bundledAgentTarget('codex'),
            builtInAgentId: 'codex',
            title: 't:agentInput.agent.codex',
        }));
    });

    it('uses provider-level enablement for collapsed provider-owned settings backend rows', () => {
        const baseParams = {
            enabledAgentIds: ['codex'],
            acpCatalogSettingsV1: { v: 2 as const, backends: [] },
            mergedProviderProjectionById: {
                codex: {
                    agentId: 'codex',
                    title: 'Codex',
                    subtitle: 'Codex CLI',
                    isBuiltIn: true,
                    settingsBackendId: 'codex-localharness',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
            },
            mergedBackendProjectionById: {
                'codex-localharness': {
                    backendId: 'codex-localharness',
                    agentId: 'codex',
                    title: 'Codex Localharness',
                    subtitle: 'Structured local runtime',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                },
            },
        } satisfies Omit<BackendCatalogParams, 'backendEnabledByTargetKey'>;

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('codex')]: true,
            },
        })).toEqual([
            expect.objectContaining({
                backendTargetKey: bundledAgentTargetKey('codex'),
                backendTarget: bundledAgentTarget('codex'),
                title: 't:agentInput.agent.codex',
            }),
        ]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('codex')]: false,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:codex-localharness': false,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            enabledAgentIds: [],
            backendEnabledByTargetKey: {
                [bundledAgentTargetKey('codex')]: false,
                'backend:codex-localharness': true,
            },
        })).toEqual([]);

        expect(getResolvedBackendCatalogEntries({
            ...baseParams,
            backendEnabledByTargetKey: {
                'backend:codex-localharness:configured:codex-localharness': false,
            },
        })).toEqual([expect.objectContaining({ backendTarget: bundledAgentTarget('codex') })]);
    });

    it('retains a private definition independently of an installed Agent settings backend alias', () => {
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
            expect.objectContaining({ backendTarget: configuredAgentTarget('plugin-runtime'),
                backendTargetKey: configuredAgentTargetKey('plugin-runtime'), kind: 'configuredBackend',
                agentId: 'custom-acp', title: 'Plugin Runtime' }),
        ]);
    });

    it('keeps private configured-definition enablement independent of an unrelated Agent settings backend alias', () => {
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

        expect(entries.map((entry) => entry.backendTarget)).toEqual([
            { kind: 'agent', identity: { pluginId: 'acme.runtime', localId: 'provider' } },
        ]);
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
