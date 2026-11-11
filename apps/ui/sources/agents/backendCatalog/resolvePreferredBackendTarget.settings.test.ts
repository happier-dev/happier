import { describe, expect, it } from 'vitest';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

const CLAUDE_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude };
const CODEX_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex };
const GROK_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.grok };
const REVIEW_BOT_TARGET = { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-bot' };
const REVIEW_BOT_ACP_BACKEND = {
    id: 'review-bot',
    name: 'review-bot',
    title: 'Review Bot',
    launch: { kind: 'command' as const, command: 'review-bot', args: [] },
    env: {},
    capabilities: {
        supportsLoadSession: false,
        supportsModes: 'unknown',
        supportsModels: 'unknown',
        supportsConfigOptions: 'unknown',
        promptImageSupport: 'unknown',
    },
    createdAt: 1,
    updatedAt: 1,
} satisfies AcpBackendDefinitionV1;

function configuredAcpBackend(id: string) {
    return {
        id,
        name: id,
        title: 'Review Bot',
        description: 'Custom review backend',
        launch: { kind: 'command' as const, command: 'review-bot', args: [] },
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
    } as const;
}

describe('resolvePreferredBackendTarget', () => {
    it('prefers a parseable lastUsedBackendTarget from settings', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('does not revive a stored built-in customAcp target as a canonical backend target', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to a built-in target from lastUsedAgent when no backend target is stored', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'claude',
        })).toEqual(CLAUDE_TARGET);
    });

    it('does not treat legacy customAcp as a selectable built-in target when no backend target is stored', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'customAcp',
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to the default built-in agent when settings contain no valid preference', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'not-a-real-agent',
            lastUsedBackendTarget: { kind: 'bad-target' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('preserves the stored configured definition for repair when it is no longer available', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
        })).toEqual({ ...REVIEW_BOT_TARGET, definitionId: 'stale-review-bot' });
    });

    it('keeps a stored configured backend target when ACP catalog availability exists without merged projection', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('preserves configured preference intent without claiming availability in an empty catalog', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('does not treat an externally qualified Agent id as a settings-only built-in default', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'acme.review.agent',
            defaultBuiltInAgentId: 'codex',
            enabledAgentIds: ['acme.review.agent', 'codex'],
            backendEnabledByTargetKey: { 'backend:acme.review.backend': true },
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
        })).toEqual(CODEX_TARGET);
    });

    it('does not turn a legacy customAcp carrier into a preference for a configured definition', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'customAcp',
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['review-bot'],
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {
                    'review-bot': {
                        backendId: 'review-bot',
                        agentId: 'review-bot',
                        providerId: 'acp:review-bot',
                        title: 'Review Bot',
                    },
                },
            } as any,
        })).toEqual(CLAUDE_TARGET);
    });

    it('preserves an explicit configured preference when the machine projection has no executable row', () => {
        expect(resolvePreferredBackendTarget({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: [],
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {},
            } as any,
        } as any)).toEqual(REVIEW_BOT_TARGET);
    });

    it('does not use the legacy customAcp carrier as permission to select a discovered plugin backend from merged projection truth by default', () => {
        expect(resolvePreferredBackendTarget({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'customAcp',
            enabledAgentIds: ['claude', 'acme.review.backend'],
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['acme.review.backend'],
                mergedProviderProjectionById: {
                    'plugin:acme.review': {
                        providerId: 'plugin:acme.review',
                        title: 'Acme Review',
                        channel: 'plugin',
                        isBuiltIn: false,
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
                mergedBackendProjectionById: {
                    'acme.review.backend': {
                        backendId: 'acme.review.backend',
                        providerId: 'plugin:acme.review',
                        title: 'Acme Review Backend',
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            } as any,
        })).toEqual(CLAUDE_TARGET);
    });
});

describe('resolvePreferredBackendTarget', () => {
    it.each(['held', 'catalog'] as const)('requires ready automatic defaults while preserving explicit choices (%s targets)', (source) => {
        const params = {
            ...(source === 'held' ? { availableBackendTargets: [GROK_TARGET, CODEX_TARGET] }
                : { enabledAgentIds: ['grok', 'codex'] }),
            lastUsedAgent: 'grok',
            lastUsedBackendTarget: GROK_TARGET,
            machineAgents: [
                { agentId: 'grok', state: 'needsSignIn' as const, stale: false },
                { agentId: 'codex', state: 'ready' as const, stale: false },
            ],
        };
        expect(resolvePreferredBackendTarget(params)).toEqual(CODEX_TARGET);
        expect(resolvePreferredBackendTarget({ ...params, candidateBackendTargets: [GROK_TARGET] })).toEqual(GROK_TARGET);
        expect(resolvePreferredBackendTarget({ ...params, candidateBackendTargets: [GROK_TARGET], machineAgents: [] })).toEqual(GROK_TARGET);
        expect(resolvePreferredBackendTarget({ ...params, machineAgents: [] })).toBeNull();
        expect(resolvePreferredBackendTarget({ ...params,
            machineAgents: params.machineAgents.map(agent => ({ ...agent, state: 'needsSignIn' as const })),
        })).toBeNull();
        expect(resolvePreferredBackendTarget({ ...params,
            machineAgents: params.machineAgents.map(agent => ({ ...agent, stale: true })),
        })).toBeNull();
        expect(resolvePreferredBackendTarget({ ...params, machineAgents: undefined })).toEqual(GROK_TARGET);
    });

    it('can automatically select a ready qualified external Agent without collapsing its identity', () => {
        const external = { kind: 'agent' as const, identity: { pluginId: 'example.review', localId: 'review' } };
        expect(resolvePreferredBackendTarget({ lastUsedAgent: 'claude', availableBackendTargets: [CLAUDE_TARGET, external],
            machineAgents: [{ agentId: 'example.review/review', state: 'ready', stale: false }],
        })).toEqual(external);
    });

    it('matches held readiness to the exact configured Agent definition', () => {
        const params = { lastUsedAgent: 'claude', availableBackendTargets: [CLAUDE_TARGET, REVIEW_BOT_TARGET] };
        expect(resolvePreferredBackendTarget({ ...params,
            machineAgents: [{ agentId: 'custom-acp', definitionId: 'another-bot', state: 'ready', stale: false }],
        })).toBeNull();
        expect(resolvePreferredBackendTarget({ ...params,
            machineAgents: [{ agentId: 'custom-acp', definitionId: 'review-bot', state: 'ready', stale: false }],
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('keeps the first explicit configured candidate for repair before settings or available defaults', () => {
        expect(resolvePreferredBackendTarget({
            candidateBackendTargets: [
                { kind: 'backend', backendId: 'missing-review-bot', configuredBackendId: 'missing-review-bot' },
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            availableBackendTargets: [
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'legacy-review-bot', configuredBackendId: 'legacy-review-bot' },
        })).toEqual({ ...REVIEW_BOT_TARGET, definitionId: 'missing-review-bot' });
    });

    it('preserves explicit configured intent ahead of preferred built-in defaults when unavailable', () => {
        expect(resolvePreferredBackendTarget({
            candidateBackendTargets: [{ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }],
            preferredBuiltInAgentIds: ['codex'],
            availableBackendTargets: [
                CODEX_TARGET,
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('keeps the remembered Agent ahead of unrelated configured catalog entries when no exact target is stored', () => {
        expect(resolvePreferredBackendTarget({
            availableBackendTargets: [
                CODEX_TARGET,
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: null,
        })).toEqual(CODEX_TARGET);
    });

    it('keeps a concrete Agent preference for repair when only unrelated configured definitions are available', () => {
        for (const [lastUsedAgent, expected] of [['codex', CODEX_TARGET], ['custom-acp', CLAUDE_TARGET]] as const) {
            expect(resolvePreferredBackendTarget({ lastUsedAgent, lastUsedBackendTarget: null,
                availableBackendTargets: [REVIEW_BOT_TARGET],
            })).toEqual(expected);
        }
    });

    it('does not treat the legacy customAcp carrier as permission to select a discovered/plugin backend even when a caller requests legacy compat fallback', () => {
        expect(resolvePreferredBackendTarget({
            availableBackendTargets: [
                CLAUDE_TARGET,
                { kind: 'backend', backendId: 'acme.review.backend' },
            ],
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            allowLegacyCompatFallback: true,
        } as any)).toEqual(CLAUDE_TARGET);
    });
});
