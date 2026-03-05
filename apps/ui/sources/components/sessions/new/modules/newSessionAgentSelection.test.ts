import { describe, expect, it } from 'vitest';

import {
    getSelectableAgentIdsForNewSession,
    isAgentSelectableForNewSession,
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
            supportedAgentIds: ['claude', 'codex'],
            detectionTimestamp: 1,
            availabilityById: { claude: false, codex: false },
            installableDepKeyCountByAgentId: { codex: 1 },
        })).toEqual({ available: true });
    });
});
