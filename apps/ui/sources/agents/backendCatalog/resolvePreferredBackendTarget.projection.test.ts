import { describe, expect, it } from 'vitest';

import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { publishDaemonMergedProjectionInputs } from './daemonContributionRegistryProjectionAdapters';

const emptyProjectionInputs = publishDaemonMergedProjectionInputs({
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {} }),
});

const CLAUDE_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude };
const ANTIGRAVITY_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.antigravity };
const configuredTarget = (definitionId: string) => ({ kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId });

describe('resolvePreferredBackendTarget', () => {
    it('does not choose a bare Custom ACP container from a legacy Agent default', () => {
        expect(resolvePreferredBackendTarget({ lastUsedAgent: 'custom-acp',
            enabledAgentIds: ['custom-acp', 'codex'],
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
        })).toEqual({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex });
        expect(resolvePreferredBackendTarget({ lastUsedAgent: 'custom-acp', defaultBuiltInAgentId: 'custom-acp' }))
            .toEqual({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[DEFAULT_AGENT_ID] });
    });
    it('gives New Session and workflow authoring an executable default despite a retained bare container target', () => {
        // Both hosts consume this owner. R25 captured custom-acp at the builder;
        // neither its routing reference nor its legacy key is a concrete choice.
        for (const lastUsedBackendTarget of [
            { kind: 'backend', backendId: 'custom-acp' },
            { kind: 'builtInAgent', agentId: 'custom-acp' },
            'backend:custom-acp',
            'agent:custom-acp',
        ]) {
            expect(resolvePreferredBackendTarget({
                lastUsedAgent: 'custom-acp',
                lastUsedBackendTarget,
                enabledAgentIds: ['custom-acp', 'codex'],
                acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            })).toEqual({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex });
        }
    });
    it('retains definition-qualified intent without a parallel daemon backend registry', () => {
        const target = { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' };
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'review-a', name: 'review-a', title: 'Review', launch: { kind: 'command' as const, command: 'review', args: [] },
            createdAt: 1, updatedAt: 1 });
        const inputs = { lastUsedAgent: 'codex', lastUsedBackendTarget: target,
            enabledAgentIds: ['codex'],
            daemonMergedProjectionInputs: { ...emptyProjectionInputs, discoveredBackendIds: [], mergedBackendProjectionById: {},
                mergedProviderProjectionById: {}, pluginProjectionById: {}, pluginProjectionV2: null, registryDiagnostics: [] },
        };
        expect(resolvePreferredBackendTarget({ ...inputs,
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [definition] } },
        })).toEqual(target);
        expect(resolvePreferredBackendTarget({ ...inputs, lastUsedBackendTarget: null,
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [definition] } },
        })).toEqual({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex });
        expect(resolvePreferredBackendTarget({ ...inputs,
            acpCatalogSnapshot: { status: 'ready', revision: 4, record: { v: 1, definitions: [] } },
        })).toEqual(target);
    });
    it('keeps a configured preference from ready destination row facts without a Settings catalog', () => {
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
            launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 });
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' },
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [definition] } },
        })).toEqual(configuredTarget('row-review'));
    });

    it.each([
        { name: 'missing', snapshot: undefined },
        { name: 'loading', snapshot: { status: 'loading' } as const },
        { name: 'unavailable', snapshot: { status: 'unavailable', reason: 'account-mode-mismatch' } as const },
    ])('keeps bundled selection and explicit configured intent when the destination catalog is $name', ({ snapshot }) => {
        expect(resolvePreferredBackendTarget({ lastUsedAgent: 'codex',
            acpCatalogSnapshot: snapshot,
        })).toEqual({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex });
        expect(resolvePreferredBackendTarget({ lastUsedAgent: 'codex',
            lastUsedBackendTarget: configuredTarget('retained-review'), acpCatalogSnapshot: snapshot,
        })).toEqual(configuredTarget('retained-review'));
    });

    it('routes an Antigravity provider default selection to the canonical provider backend', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'antigravity',
            lastUsedBackendTarget: null,
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
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
        })).toEqual(ANTIGRAVITY_TARGET);
    });

    it('normalizes an old persisted Antigravity concrete target to the canonical provider backend', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'antigravity-terminal' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
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
        })).toEqual(ANTIGRAVITY_TARGET);
    });

    it('keeps a private configured definition separate from an Antigravity runtime alias', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'antigravity-localharness',
                configuredBackendId: 'antigravity-localharness',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['antigravity', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [
                    {
                        id: 'antigravity-localharness',
                        name: 'antigravity-localharness',
                        title: 'Antigravity Localharness',
                        description: 'Structured local runtime',
                        launch: { kind: 'command' as const, command: 'agy-localharness', args: [] },
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
                ] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
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
        })).toEqual(configuredTarget('antigravity-localharness'));
    });

    it('keeps a daemon-projected plugin backend as the preferred target when it has no built-in runtime carrier', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
                discoveredBackendIds: ['acme.review.backend'],
                mergedProviderProjectionById: {
                    'acme.review.provider': {
                        agentId: 'acme.review.provider',
                        identity: { pluginId: 'acme.review', localId: 'provider' },
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
        })).toEqual({ kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } });
    });

    it('restores a standalone installed Session Agent as the preferred target', () => {
        // The current daemon V2 projection emits no parallel backend registry,
        // so `agentsById` is the only canonical evidence that this machine
        // offers the Agent. A target it names must stay selectable.
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
                discoveredBackendIds: [],
                mergedProviderProjectionById: {
                    'acme.review': {
                        agentId: 'acme.review',
                        identity: { pluginId: 'acme.review', localId: 'review' },
                        title: 'Acme Review',
                        subtitle: 'Installed review Agent',
                        isBuiltIn: false,
                    },
                },
                mergedBackendProjectionById: {},
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual({ kind: 'agent', identity: { pluginId: 'acme.review', localId: 'review' } });
    });

    it('preserves a configured definition without an obsolete daemon backend registry entry', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'ghost-bot', configuredBackendId: 'ghost-bot' },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [
                AcpBackendDefinitionV1Schema.parse({ id: 'ghost-bot', name: 'ghost-bot', title: 'Ghost Bot',
                    launch: { kind: 'command' as const, command: 'ghost', args: [] }, createdAt: 1, updatedAt: 1 }),
            ] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
                discoveredBackendIds: [],
                mergedProviderProjectionById: {
                    'acme.review': {
                        agentId: 'acme.review',
                        title: 'Acme Review',
                        isBuiltIn: false,
                    },
                },
                mergedBackendProjectionById: {},
                pluginProjectionById: {},
                pluginProjectionV2: null,
                registryDiagnostics: [],
            },
        })).toEqual(configuredTarget('ghost-bot'));
    });

    it('does not let a projected plugin settings backend hijack the built-in fallback for legacy customAcp', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            defaultBuiltInAgentId: 'claude',
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
                discoveredBackendIds: ['acme.review.backend'],
                mergedProviderProjectionById: {
                    'acme.review.provider': {
                        agentId: 'acme.review.provider',
                        identity: { pluginId: 'acme.review', localId: 'provider' },
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
        })).toEqual(CLAUDE_TARGET);
    });

    it('keeps a private definition separate from an unrelated plugin Agent runtime alias', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'plugin-runtime',
                configuredBackendId: 'plugin-runtime',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['plugin-provider', 'claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [
                    {
                        id: 'plugin-runtime',
                        name: 'plugin-runtime',
                        title: 'Plugin Runtime',
                        description: 'Plugin runtime backend',
                        launch: { kind: 'command' as const, command: 'plugin-runtime', args: [] },
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
                ] } },
            daemonMergedProjectionInputs: {
                ...emptyProjectionInputs,
                discoveredBackendIds: ['plugin-runtime'],
                mergedProviderProjectionById: {
                    'plugin-provider': {
                        agentId: 'plugin-provider',
                        identity: { pluginId: 'acme.runtime', localId: 'provider' },
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
        })).toEqual(configuredTarget('plugin-runtime'));
    });

    it('preserves a configured custom backend target when daemon projection inputs are absent', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            },
            defaultBuiltInAgentId: 'claude',
            enabledAgentIds: ['claude'],
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        description: 'Custom review backend',
                        launch: { kind: 'command' as const, command: 'review-bot', args: [] },
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
                ] } },
            daemonMergedProjectionInputs: null,
        })).toEqual(configuredTarget('review-bot'));
    });
});
