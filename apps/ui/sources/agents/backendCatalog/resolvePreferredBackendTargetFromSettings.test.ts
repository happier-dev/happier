import { describe, expect, it } from 'vitest';

import {
    resolvePreferredBackendTarget,
    resolvePreferredBackendTargetFromSettings,
} from './resolvePreferredBackendTargetFromSettings';

describe('resolvePreferredBackendTargetFromSettings', () => {
    it('prefers a parseable lastUsedBackendTarget from settings', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        })).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    });

    it('falls back to a built-in target from lastUsedAgent when no backend target is stored', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'claude',
        })).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    });

    it('falls back to the default built-in agent when settings contain no valid preference', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'not-a-real-agent',
            lastUsedBackendTarget: { kind: 'bad-target' },
        })).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
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
        } as any)).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
    });

    it('does not treat empty availability inputs as a stale-backend signal', () => {
        expect(resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: {},
            acpCatalogSettingsV1: { v: 2, backends: [] },
        })).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    });
});

describe('resolvePreferredBackendTarget', () => {
    it('uses candidate backend targets before settings and validates against available backend targets', () => {
        expect(resolvePreferredBackendTarget({
            candidateBackendTargets: [
                { kind: 'configuredAcpBackend', backendId: 'missing-review-bot' },
                { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            ],
            availableBackendTargets: [
                { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'legacy-review-bot' },
        })).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    });

    it('uses preferred built-in agent candidates when explicit backend targets are unavailable', () => {
        expect(resolvePreferredBackendTarget({
            candidateBackendTargets: [{ kind: 'configuredAcpBackend', backendId: 'review-bot' }],
            preferredBuiltInAgentIds: ['codex'],
            availableBackendTargets: [
                { kind: 'builtInAgent', agentId: 'codex' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        })).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
    });
});
