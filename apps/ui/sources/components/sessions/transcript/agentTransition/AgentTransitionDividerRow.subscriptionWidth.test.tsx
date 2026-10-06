import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook, renderScreen as renderBaseScreen, standardCleanup } from '@/dev/testkit';
import { AppSessionTranscriptSourceProvider, useTranscriptMachineId } from '../source/appSessionTranscriptSource';
import { storage } from '@/sync/domains/state/storageStore';
import { useSession } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { MetadataSchema } from '@happier-dev/session-core/state';
import type { SessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import { AgentTransitionDividerRow } from './AgentTransitionDividerRow';
import { TranscriptSeparatorRow } from '../separators/TranscriptSeparatorRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalMock = vi.hoisted(() => ({ show: vi.fn((_config: unknown) => 'modal-id') }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalMock.show } }).module;
});

const SESSION_ID = 'agent-transition-divider-subscription-width';
const SERVER_ID = 'server-1';

function renderScreen(element: React.ReactElement) {
    return renderBaseScreen(<AppSessionTranscriptSourceProvider sessionId={SESSION_ID} serverId={SERVER_ID}>{element}</AppSessionTranscriptSourceProvider>);
}

const DIVIDER: SessionAgentTransitionDividerV1 = {
    v: 1,
    fromAgentId: 'claude',
    toAgentId: 'codex',
    sourceCutoffSeqInclusive: 41,
};

/**
 * Layout v1, because that is what the row actually reads: the machine id lives
 * ONLY in the owner projection under this layout — the shared `metadata` a
 * layout-v1 session carries has no `machineId` key at all. Seeding layout 0
 * would let a selector that reads raw `metadata` pass while still answering
 * `null` for every real layout-v1 session.
 */
function seedSession(patch: Partial<Session>): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [SESSION_ID]: createSessionFixture({
                id: SESSION_ID,
                serverId: SERVER_ID,
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                thinking: false,
                presence: 'online',
                accessLevel: 'admin',
                canApprovePermissions: true,
                metadataLayoutVersion: 1,
                metadata: MetadataSchema.parse({ v: 1 }),
                ownerMetadataView: { path: '/w', host: 'h', machineId: 'machine-owner' },
                agentState: null,
                agentStateVersion: 0,
                ...patch,
            }),
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

    it('keeps the app source machine selector narrow during unrelated Session writes', async () => {
        seedSession({});
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useTranscriptMachineId(); }, {
            wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={SESSION_ID} serverId={SERVER_ID}>{props.children}</AppSessionTranscriptSourceProvider>,
        });
        expect(hook.getCurrent()).toBe('machine-owner');
        const before = renders;

        await act(async () => { seedSession({ thinking: true, agentState: {}, agentStateVersion: 1, seq: 2 }); });
        expect(renders).toBe(before);

        await act(async () => { seedSession({ ownerMetadataView: { path: '/w', host: 'h', machineId: 'machine-moved' } }); });
        expect(hook.getCurrent()).toBe('machine-moved');
        expect(renders).toBe(before + 1);
        await hook.unmount();
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

        // Catalog identity leaves settle their credential/loading state on mount.
        // Measure only commits caused by the following Session writes.
        dividerUpdates = 0;
        controlUpdates = 0;

        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 1, updatedAt: 1, seq: 2 });
        });
        await act(async () => {
            seedSession({ thinking: true, agentState: {}, agentStateVersion: 2, updatedAt: 2, seq: 3, presence: 12 });
        });

        expect(controlUpdates).toBe(2);
        expect(dividerUpdates).toBe(0);
    });

    it('still addresses the owner-projected machine when the card is opened', async () => {
        seedSession({});

        const screen = await renderScreen(
            <AgentTransitionDividerRow divider={DIVIDER} sessionId={SESSION_ID} />,
        );
        screen.pressByTestId('transcript-agent-transition-divider-chip');

        expect(machineIdsPassedToCard()).toEqual(['machine-owner']);
    });

    it('re-renders when the machine the card must address actually changes', async () => {
        seedSession({});

        const committedTitles: React.ReactNode[] = [];
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        screen = await renderScreen(
            <React.Profiler
                    id="agent-transition-divider"
                    onRender={(_id, phase) => {
                        if (phase === 'update' && screen) {
                            committedTitles.push(screen.root.findByType(TranscriptSeparatorRow).props.titleContent);
                        }
                }}
            >
                <AgentTransitionDividerRow divider={DIVIDER} sessionId={SESSION_ID} />
            </React.Profiler>,
        );

        const mountedTitle = screen.root.findByType(TranscriptSeparatorRow).props.titleContent;
        committedTitles.length = 0;

        await act(async () => {
            seedSession({ ownerMetadataView: { path: '/w', host: 'h', machineId: 'machine-moved' } });
        });

        // The row creates this element on each own render. Its catalog icon
        // leaves also commit their loading projection after the machine changes
        // without credentials; those leaf commits preserve the row's element.
        expect(new Set([mountedTitle, ...committedTitles]).size - 1).toBe(1);
        expect(committedTitles).toHaveLength(2);
        expect(committedTitles[0]).not.toBe(mountedTitle);
        expect(committedTitles[1]).toBe(committedTitles[0]);
        screen.pressByTestId('transcript-agent-transition-divider-chip');
        expect(machineIdsPassedToCard()).toEqual(['machine-moved']);
    });
});
