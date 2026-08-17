import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenSessionForkStrategyModalParams } from './openSessionForkStrategyModal';

/**
 * Source-context continuation — Configure new Session — is this program's
 * capability, not the pre-existing same-engine fork. It therefore consults the
 * same `sessions.agentSwitching` decision the in-Session picker does, at the one
 * point the fork flow branches into it.
 *
 * Native and Replay are deliberately untouched: they are the fork product that
 * predates this feature, and gating them would remove working functionality.
 */

const openedModals: OpenSessionForkStrategyModalParams[] = [];

vi.mock('./openSessionForkStrategyModal', () => ({
    openSessionForkStrategyModal: (params: OpenSessionForkStrategyModalParams) => {
        openedModals.push(params);
        return 'modal-1';
    },
}));

const sessionsRef = { current: {} as Record<string, unknown> };
vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ sessions: sessionsRef.current }) },
}));

import { openSessionForkStrategyFlow } from './openSessionForkStrategyFlow';

const SESSION_ID = 'session-1';

const FORK_SOURCE = {
    metadata: { flavor: 'claude', machineId: 'machine-1', path: '/repo' },
    metadataLayoutVersion: 1,
    ownerMetadataView: null,
    serverId: 'server-1',
} as never;

function openFlow(agentSwitchingEnabled: boolean) {
    const navigateToNewSession = vi.fn();
    const modalId = openSessionForkStrategyFlow({
        sessionId: SESSION_ID,
        forkSupportSource: FORK_SOURCE,
        serverId: 'server-1',
        machineId: 'machine-1',
        forkPoint: { type: 'latest' },
        settings: null,
        replayEnabled: true,
        executionRunsEnabled: false,
        agentSwitchingEnabled,
        navigateToSession: vi.fn(),
        navigateToNewSession,
    });
    return { modalId, navigateToNewSession, opened: openedModals.at(-1) ?? null };
}

beforeEach(() => {
    openedModals.length = 0;
    sessionsRef.current = {};
});

describe('openSessionForkStrategyFlow source-context gate', () => {
    it('does not offer source-context continuation when the feature is disabled', () => {
        const { modalId, opened } = openFlow(false);

        expect(modalId).toBe('modal-1');
        expect(opened?.configureNewSession).toBeNull();
        // The pre-existing same-engine fork stays exactly as available as it was.
        expect(opened?.availability.replay).toBe(true);
    });

    it('offers source-context continuation when the feature is enabled', () => {
        const { opened } = openFlow(true);

        expect(typeof opened?.configureNewSession).toBe('function');
        expect(opened?.availability.replay).toBe(true);
    });
});
