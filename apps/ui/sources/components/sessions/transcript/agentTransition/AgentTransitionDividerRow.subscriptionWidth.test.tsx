import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSession } from '@/sync/domains/state/storage';
import type { SessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import { AgentTransitionDividerRow } from './AgentTransitionDividerRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Genuine boundaries in the Node test runtime: the Agent mark resolves bundled
// image and SVG assets this runtime cannot load, and the registry module that
// carries its per-Agent optical scale loads them with it.
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-1',
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

const modalMock = vi.hoisted(() => ({ show: vi.fn((_config: unknown) => 'modal-id') }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalMock.show } }).module;
});

const SESSION_ID = 'agent-transition-divider-subscription-width';

const DIVIDER: SessionAgentTransitionDividerV1 = {
    v: 1,
    fromAgentId: 'claude',
    toAgentId: 'codex',
    sourceCutoffSeqInclusive: 41,
} as SessionAgentTransitionDividerV1;

function seedSession(patch: Record<string, unknown>): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [SESSION_ID]: {
                id: SESSION_ID,
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                thinking: false,
                presence: 'online',
                accessLevel: 'admin',
                canApprovePermissions: true,
                metadata: { path: '/w', host: 'h', machineId: 'machine-owner' },
                agentState: null,
                agentStateVersion: 0,
                ...patch,
            } as never,
        },
    }));
}

function machineIdsPassedToCard(): readonly unknown[] {
    return modalMock.show.mock.calls.map(([config]) => (
        (config as { props?: { machineId?: unknown } })?.props?.machineId
    ));
}

/**
 * A transcript row is the hottest surface in the product: during a turn the
 * session record is rewritten on every chunk. This row needs exactly one string
 * off that record, so it must not re-render when anything else on it moves.
 */
describe('Agent transition divider subscription width', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
        modalMock.show.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('does not re-render while turn-lifecycle session fields churn, where a whole-record subscriber does', async () => {
        seedSession({});

        let dividerUpdates = 0;
        let controlUpdates = 0;

        function WholeRecordControl(): React.ReactElement | null {
            useSession(SESSION_ID);
            return null;
        }

        await renderScreen(
            <>
                <React.Profiler
                    id="agent-transition-divider"
                    onRender={(_id, phase) => {
                        if (phase === 'update') dividerUpdates += 1;
                    }}
                >
                    <AgentTransitionDividerRow divider={DIVIDER} sessionId={SESSION_ID} />
                </React.Profiler>
                {/* Control: the subscription the row used to hold. It re-renders on this
                    churn, so a flat divider count is evidence rather than an inert test. */}
                <React.Profiler
                    id="whole-record-control"
                    onRender={(_id, phase) => {
                        if (phase === 'update') controlUpdates += 1;
                    }}
                >
                    <WholeRecordControl />
                </React.Profiler>
            </>,
        );

        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 1, updatedAt: 1, seq: 2 });
        });
        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 2, updatedAt: 2, seq: 3, presence: 12 });
        });

        expect(controlUpdates).toBe(2);
        expect(dividerUpdates).toBe(0);
    });

    it('still addresses the session machine when the card is opened', async () => {
        seedSession({});

        const screen = await renderScreen(
            <AgentTransitionDividerRow divider={DIVIDER} sessionId={SESSION_ID} />,
        );
        screen.pressByTestId('transcript-agent-transition-divider-chip');

        expect(machineIdsPassedToCard()).toEqual(['machine-owner']);
    });

    it('re-renders when the machine the card must address actually changes', async () => {
        seedSession({});

        let dividerUpdates = 0;
        const screen = await renderScreen(
            <React.Profiler
                id="agent-transition-divider"
                onRender={(_id, phase) => {
                    if (phase === 'update') dividerUpdates += 1;
                }}
            >
                <AgentTransitionDividerRow divider={DIVIDER} sessionId={SESSION_ID} />
            </React.Profiler>,
        );

        await act(async () => {
            seedSession({ metadata: { path: '/w', host: 'h', machineId: 'machine-moved' } });
        });

        expect(dividerUpdates).toBe(1);
        screen.pressByTestId('transcript-agent-transition-divider-chip');
        expect(machineIdsPassedToCard()).toEqual(['machine-moved']);
    });
});
