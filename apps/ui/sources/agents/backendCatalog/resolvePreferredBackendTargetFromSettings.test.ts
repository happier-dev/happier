import { describe, expect, it } from 'vitest';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import { resolvePreferredBackendTargetFromSettings } from './resolvePreferredBackendTargetFromSettings';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

const CLAUDE_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude };
const CODEX_TARGET = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex };
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

describe('resolvePreferredBackendTargetFromSettings', () => {
    it('prefers a parseable lastUsedBackendTarget from settings', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('does not revive a stored built-in customAcp target as a canonical backend target', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to a built-in target from lastUsedAgent when no backend target is stored', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'claude',
        })).toEqual(CLAUDE_TARGET);
    });

    it('does not treat legacy customAcp as a selectable built-in target when no backend target is stored', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'customAcp',
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to the default built-in agent when settings contain no valid preference', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
            lastUsedAgent: 'not-a-real-agent',
            lastUsedBackendTarget: { kind: 'bad-target' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('preserves the stored configured definition for repair when it is no longer available', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
        })).toEqual({ ...REVIEW_BOT_TARGET, definitionId: 'stale-review-bot' });
    });

    it('keeps a stored configured backend target when ACP catalog availability exists without merged projection', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [REVIEW_BOT_ACP_BACKEND] } },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('preserves configured preference intent without claiming availability in an empty catalog', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('does not treat an externally qualified Agent id as a settings-only built-in default', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'acme.review.agent',
            defaultBuiltInAgentId: 'codex',
            enabledAgentIds: ['acme.review.agent', 'codex'],
            backendEnabledByTargetKey: { 'backend:acme.review.backend': true },
            acpCatalogSnapshot: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } },
        })).toEqual(CODEX_TARGET);
    });

    it('still prefers a merged-projection configured backend target when the legacy customAcp carrier has no stored concrete backend target', () => {
        expect(resolvePreferredBackendTargetFromSettings({
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
        })).toEqual(REVIEW_BOT_TARGET);
    });

    it('preserves an explicit configured preference when the machine projection has no executable row', () => {
        expect(resolvePreferredBackendTargetFromSettings({
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
        expect(resolvePreferredBackendTargetFromSettings({
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

    it('prefers an available configured backend target over built-in defaults when no explicit target is stored', () => {
        expect(resolvePreferredBackendTarget({
            availableBackendTargets: [
                CODEX_TARGET,
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: null,
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
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
