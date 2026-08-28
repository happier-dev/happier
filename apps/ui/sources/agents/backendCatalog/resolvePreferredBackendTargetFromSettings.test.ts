import { describe, expect, it } from 'vitest';

import { resolvePreferredBackendTarget } from './resolvePreferredBackendTarget';
import { resolvePreferredBackendTargetFromSettings } from './resolvePreferredBackendTargetFromSettings';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

const CLAUDE_TARGET = { kind: 'agent' as const, identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES.claude };
const CODEX_TARGET = { kind: 'agent' as const, identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES.codex };

describe('resolvePreferredBackendTargetFromSettings', () => {
    it('prefers a parseable lastUsedBackendTarget from settings', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });

    it('does not revive a stored built-in customAcp target as a canonical backend target', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to a built-in target from lastUsedAgent when no backend target is stored', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'claude',
        })).toEqual(CLAUDE_TARGET);
    });

    it('does not treat legacy customAcp as a selectable built-in target when no backend target is stored', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to the default built-in agent when settings contain no valid preference', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'not-a-real-agent',
            lastUsedBackendTarget: { kind: 'bad-target' },
        })).toEqual(CLAUDE_TARGET);
    });

    it('falls back to the preferred built-in target when the stored configured backend is no longer available', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    { id: 'review-bot', name: 'review-bot', title: 'Review Bot' },
                ],
            },
        } as any)).toEqual(CODEX_TARGET);
    });

    it('keeps a stored configured backend target when ACP catalog availability exists without merged projection', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    { id: 'review-bot', name: 'review-bot', title: 'Review Bot' },
                ],
            },
        } as any)).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });

    it('does not treat empty availability inputs as a stale-backend signal', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });

    it('does not synthesize non-built-in backend ids from settings-only availability inputs without merged projection truth', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'claude',
            enabledAgentIds: ['acme.review.backend'],
            backendEnabledByTargetKey: { 'backend:acme.review.backend': true },
            acpCatalogSettingsV1: { v: 2, backends: [] },
        })).toEqual(CLAUDE_TARGET);
    });

    it('still prefers a merged-projection configured backend target when the legacy customAcp carrier has no stored concrete backend target', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    { id: 'review-bot', name: 'review-bot', title: 'Review Bot' },
                ],
            },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: ['review-bot'],
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {
                    'review-bot': {
                        providerId: 'acp:review-bot',
                        title: 'Review Bot',
                    },
                },
            } as any,
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });

    it('treats merged projection as canonical truth and does not keep catalog-only configured backends selectable', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    { id: 'review-bot', name: 'review-bot', title: 'Review Bot' },
                ],
            },
            daemonMergedProjectionInputs: {
                discoveredBackendIds: [],
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {},
            } as any,
        } as any)).toEqual(CODEX_TARGET);
    });

    it('does not use the legacy customAcp carrier as permission to select a discovered plugin backend from merged projection truth by default', () => {
        expect(resolvePreferredBackendTargetFromSettings({
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
    it('uses candidate backend targets before settings and validates against available backend targets', () => {
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
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });

    it('uses preferred built-in agent candidates when explicit backend targets are unavailable', () => {
        expect(resolvePreferredBackendTarget({
            candidateBackendTargets: [{ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }],
            preferredBuiltInAgentIds: ['codex'],
            availableBackendTargets: [
                CODEX_TARGET,
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        })).toEqual(CODEX_TARGET);
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
