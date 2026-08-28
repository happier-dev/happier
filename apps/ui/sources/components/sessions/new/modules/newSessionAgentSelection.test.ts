import { describe, expect, it } from 'vitest';

import {
    getSelectableBackendEntriesForNewSession,
    getSelectableAgentIdsForNewSession,
    isBackendEntrySelectableForNewSession,
    isAgentSelectableForNewSession,
    resolveNextSelectableBackendEntryForNewSession,
    resolveNextSelectableAgentForNewSession,
    resolveProfileAvailabilityForNewSession,
} from './newSessionAgentSelection';

describe('newSessionAgentSelection', () => {
    it('treats all agents as selectable before detection completes', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            detectionTimestamp: 0,
            availabilityById: { codex: false },
            installableDepKeyCountByAgentId: { codex: 0 },
        })).toBe(true);
    });

    it('keeps unavailable agents selectable when they have installable dependencies', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            detectionTimestamp: 1,
            availabilityById: { codex: false },
            installableDepKeyCountByAgentId: { codex: 1 },
        })).toBe(true);
    });

    it('keeps unavailable agents selectable when the UI marks them as selectable without CLI detection', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            detectionTimestamp: 1,
            availabilityById: { codex: false },
            installableDepKeyCountByAgentId: { codex: 0 },
            selectableWithoutCliByAgentId: { codex: true },
        })).toBe(true);
    });

    it('treats logged-out agents as unavailable when authentication has been checked', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            detectionTimestamp: 1,
            availabilityById: { codex: true },
            authStatusById: {
                codex: { state: 'logged_out', checkedAt: 1 },
            },
            installableDepKeyCountByAgentId: { codex: 0 },
        } as any)).toBe(false);
    });

    it('treats missing availability as unavailable after detection completes unless another path keeps it selectable', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: { codex: 0 },
        })).toBe(false);
    });

    it('resolves the next selectable agent while skipping unavailable intermediates', () => {
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'],
            currentAgentId: 'claude',
            detectionTimestamp: 1,
            availabilityById: { claude: true, codex: false, opencode: true },
            installableDepKeyCountByAgentId: { codex: 0 },
        })).toBe('opencode');
    });

    it('builds the selectable list from candidates using the same policy as chip cycling', () => {
        expect(getSelectableAgentIdsForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'],
            detectionTimestamp: 1,
            availabilityById: { claude: true, codex: false, opencode: true },
            installableDepKeyCountByAgentId: { codex: 0 },
        })).toEqual(['claude', 'opencode']);
    });

    it('marks multi-cli profiles as available when at least one supported agent remains selectable', () => {
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [
                { backendTarget: { kind: 'backend', backendId: 'claude' }, backendTargetKey: 'backend:claude', builtInAgentId: 'claude', agentId: 'claude', kind: 'builtInAgent' },
                { backendTarget: { kind: 'backend', backendId: 'codex' }, backendTargetKey: 'backend:codex', builtInAgentId: 'codex', agentId: 'codex', kind: 'builtInAgent' },
            ],
            detectionTimestamp: 1,
            availabilityById: { claude: false, codex: false },
            installableDepKeyCountByAgentId: { codex: 1 },
        })).toEqual({ available: true });
    });

    it('marks a single-cli profile unavailable with a logged-out reason when that agent is logged out', () => {
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [
                {
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    backendTargetKey: 'backend:codex',
                    builtInAgentId: 'codex',
                    agentId: 'codex',
                    kind: 'builtInAgent',
                },
            ],
            detectionTimestamp: 1,
            availabilityById: { codex: true },
            authStatusById: {
                codex: { state: 'logged_out', checkedAt: 1 },
            },
            installableDepKeyCountByAgentId: { codex: 0 },
        } as any)).toEqual({ available: false, reason: 'logged-out:codex' });
    });

    it('treats configured ACP backend entries as selectable without built-in CLI detection', () => {
        const entry = {
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' } as const,
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            builtInAgentId: null,
            agentId: 'review-bot',
            kind: 'configuredBackend' as const,
        };
        expect(isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: {},
        })).toBe(true);
        expect(getSelectableBackendEntriesForNewSession({
            candidateBackendEntries: [entry],
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: {},
        })).toEqual([entry]);
    });

    it('applies the operational installed Agent declaration to plugin backend availability', () => {
        const entry = {
            backendTarget: { kind: 'backend', backendId: 'acme.review' } as const,
            backendTargetKey: 'backend:acme.review',
            builtInAgentId: null,
            agentId: 'acme.review/assistant',
            kind: 'pluginBackend' as const,
        };

        expect(isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: 1,
            availabilityById: { 'acme.review/assistant': false },
            installableDepKeyCountByAgentId: { 'acme.review/assistant': 0 },
            selectableWithoutCliByAgentId: { 'acme.review/assistant': false },
        })).toBe(false);
        expect(isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: 1,
            availabilityById: { 'acme.review/assistant': false },
            installableDepKeyCountByAgentId: { 'acme.review/assistant': 1 },
            selectableWithoutCliByAgentId: { 'acme.review/assistant': false },
        })).toBe(true);
        expect(isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: 1,
            availabilityById: { 'acme.review/assistant': false },
            installableDepKeyCountByAgentId: { 'acme.review/assistant': 0 },
            selectableWithoutCliByAgentId: { 'acme.review/assistant': true },
        })).toBe(true);
    });

    it('excludes backend entries that explicitly do not support session runtime', () => {
        const entry = {
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' } as const,
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            builtInAgentId: null,
            agentId: 'review-bot',
            kind: 'configuredBackend' as const,
            capabilities: {
                session: { supported: false },
                executionRun: { supported: true },
            },
        };

        expect(isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: {},
        })).toBe(false);
        expect(getSelectableBackendEntriesForNewSession({
            candidateBackendEntries: [entry],
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: {},
        })).toEqual([]);
    });

    it('resolves profile availability from configured ACP backend targets', () => {
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [
                {
                    backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                    backendTargetKey: 'backend:review-bot:configured:review-bot',
                    builtInAgentId: null,
                    agentId: 'review-bot',
                    kind: 'configuredBackend',
                },
            ],
            detectionTimestamp: 1,
            availabilityById: {},
            installableDepKeyCountByAgentId: {},
        })).toEqual({ available: true });
    });

    it('cycles to a compatible configured ACP backend when no compatible built-in backend remains selectable', () => {
        const next = resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: [
                {
                    backendTarget: { kind: 'backend', backendId: 'claude' },
                    backendTargetKey: 'backend:claude',
                    builtInAgentId: 'claude',
                    agentId: 'claude',
                    kind: 'builtInAgent',
                },
                {
                    backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
                    backendTargetKey: 'backend:review-bot:configured:review-bot',
                    builtInAgentId: null,
                    agentId: 'review-bot',
                    kind: 'configuredBackend',
                },
            ],
            currentTargetKey: 'backend:claude',
            detectionTimestamp: 1,
            availabilityById: { claude: false },
            installableDepKeyCountByAgentId: { claude: 0 },
        });

        expect(next?.backendTarget).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });
});
