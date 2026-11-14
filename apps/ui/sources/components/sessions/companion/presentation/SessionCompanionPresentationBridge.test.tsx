import * as React from 'react';
import { act } from 'react-test-renderer';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { CurrentSessionPresentationActionInputV1Schema } from '@happier-dev/protocol/sessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionBoardActionsPort,
    projectSessionBoard,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { SessionBoardContinuityProvider, useSessionBoardContinuity } from '../../board/SessionBoardContinuity';
import { readPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
    SessionBoardControllerOwner,
    useMountedSessionBoardController,
    type MountedSessionBoardController,
} from '../../board/SessionBoardControllerProvider';
import type { SessionBoardBinding } from '../../board/observeSessionBoard';
import { SessionCompanionPresentationBridge } from './SessionCompanionPresentationBridge';
import type {
    SessionPresentationIntentApplier,
} from './SessionCompanionPresentationBridge';

const local = vi.hoisted(() => ({ stored: undefined as unknown }));

vi.mock('@/sync/domains/state/storage', () =>
    createStorageModuleStub({
        useSessionCompanionPreferenceSlot: (sessionId: string | null, serverId?: string | null) => ({
            storageKey: sessionId && serverId ? `${serverId}:${sessionId}` : null,
            stored: local.stored,
        }),
        useMutateSessionCompanionPreference: () => (
            _sessionId: string,
            updater: (stored: unknown) => unknown,
            serverId?: string | null,
        ) => {
            if (!serverId) return false;
            const next = updater(local.stored);
            if (next === null) return false;
            local.stored = next;
            return true;
        },
    }),
);

const OWNER_ADDRESS: SessionAddress = { serverId: 'home-1', sessionId: 'session-1' };
const actions = createSessionBoardActionsPort(OWNER_ADDRESS);
const pluginRuntime = {
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable' as const,
    interactionEnabled: false,
    machineId: null,
    serverId: OWNER_ADDRESS.serverId,
    platform: 'web' as const,
    accountLifetime: null,
};

// Reachability and repository freshness are separate axes on purpose: a
// reachable Home with a stale repository is the ordinary state right after any
// Board write, and the bridge must be able to see them apart.
function snapshot(
    reachability: SessionBoardSnapshot['reachability'],
    freshness: SessionBoardSnapshot['freshness'],
): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: undefined,
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness,
        reachability,
        loading: 'idle',
        incomplete: false,
    });
}

function snapshotWithViews(viewIds: readonly string[]): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: {
            revision: 'ssr1:layout',
            outcome: {
                status: 'ready',
                value: { v: 1, tabs: viewIds.map((id) => ({ id, title: id.toUpperCase(), items: [] })) },
            },
        },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    } as Parameters<typeof projectSessionBoard>[0]);
}

function snapshotWithReadableTranscriptItem(
    reachability: SessionBoardSnapshot['reachability'],
): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: undefined,
        items: new Map([['visual-1', { revision: 'ssr1:item', outcome: { status: 'ready', value: {
            v: 1,
            destination: 'transcript',
            title: 'Visual',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Visual</p>') },
        } } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability,
        loading: 'idle',
        incomplete: false,
    });
}

type ContinuityProbe = { current: ReturnType<typeof useSessionBoardContinuity> };

function ContinuityProbe(props: Readonly<{ probe: ContinuityProbe }>): null {
    props.probe.current = useSessionBoardContinuity(OWNER_ADDRESS);
    return null;
}

function InlineOccurrences(props: Readonly<{ probe: { current: MountedSessionBoardController | null } }>): null {
    const mounted = useMountedSessionBoardController(OWNER_ADDRESS);
    props.probe.current = mounted;
    const report = mounted?.reportInlineTranscriptDemand;
    React.useEffect(() => {
        // The first occurrence sits later in the transcript, so it stays the default target.
        const releaseFirst = report?.('visual-1', 'first', 2);
        const releaseSecond = report?.('visual-1', 'second', 1);
        return () => { releaseFirst?.(); releaseSecond?.(); };
    }, [report]);
    return null;
}

function Harness(props: Readonly<{
    binding: SessionBoardBinding;
    bridgeAddress?: SessionAddress;
    applierRef: React.MutableRefObject<SessionPresentationIntentApplier | null>;
    openBoard: ReturnType<typeof vi.fn>;
    revealBoardItem?: ReturnType<typeof vi.fn>;
    continuityProbe?: ContinuityProbe;
    inlineProbe?: { current: MountedSessionBoardController | null };
}>): React.ReactElement {
    const bridgeAddress = props.bridgeAddress ?? OWNER_ADDRESS;
    return (
        <SessionBoardContinuityProvider
            sessionId={OWNER_ADDRESS.sessionId}
            serverId={OWNER_ADDRESS.serverId}
        >
            <SessionBoardControllerOwner
                address={OWNER_ADDRESS}
                input={{
                    sessionId: OWNER_ADDRESS.sessionId,
                    serverId: OWNER_ADDRESS.serverId,
                    binding: props.binding,
                    actions,
                }}
                binding={props.binding}
                actions={actions}
                pluginRuntime={pluginRuntime}
                callerHostedHtmlRuntime={null}
            >
                {props.continuityProbe ? <ContinuityProbe probe={props.continuityProbe} /> : null}
                {props.inlineProbe ? <InlineOccurrences probe={props.inlineProbe} /> : null}
                <SessionCompanionPresentationBridge
                    sessionId={bridgeAddress.sessionId}
                    serverId={bridgeAddress.serverId}
                    applierRef={props.applierRef}
                    openBoard={props.openBoard}
                    revealBoardItem={props.revealBoardItem ?? (() => ({ status: 'applied' }))}
                    returnToChat={() => ({ status: 'applied' })}
                    openFullSurface={() => ({ status: 'applied' })}
                />
            </SessionBoardControllerOwner>
        </SessionBoardContinuityProvider>
    );
}

describe('SessionCompanionPresentationBridge Board currentness', () => {
    beforeEach(() => {
        local.stored = undefined;
    });
    afterEach(() => standardCleanup());

    it.each(['ready', 'unavailable'] as const)('transfers only to the exact requested live occurrence and refuses a retired occurrence with %s Board', async board => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const probe: { current: MountedSessionBoardController | null } = { current: null };
        const readyBinding = { status: 'ready', snapshot: projectSessionBoard({
            layout: undefined,
            items: new Map([['visual-1', { revision: 'ssr1:item', outcome: { status: 'ready', value: {
                v: 1, destination: 'transcript', title: 'Visual', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Visual' } } },
            } } }]]),
            capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh', reachability: 'reachable',
            loading: 'idle', incomplete: false,
        }) } as const;
        const binding: SessionBoardBinding = board === 'ready' ? readyBinding : { status: 'unavailable', reason: 'board_feature_disabled' };
        const screen = await renderScreen(<Harness binding={binding} applierRef={applierRef} inlineProbe={probe} openBoard={vi.fn()} />);
        expect(probe.current?.resolveInlineTranscriptOccurrence('visual-1')).toBe('first');
        const { intent } = CurrentSessionPresentationActionInputV1Schema.parse({
            intent: { kind: 'chat.item.show', widgetId: 'visual-1', occurrenceId: 'second' },
        });
        if (intent.kind !== 'chat.item.show') throw new Error('Expected the requested Chat occurrence intent');
        await act(async () => { expect(applierRef.current?.(intent)).toEqual({ status: 'applied' }); });
        expect(probe.current?.resolveInlineTranscriptOccurrence('visual-1')).toBe('second');
        await act(async () => { expect(applierRef.current?.({ ...intent, occurrenceId: 'retired' })).toEqual({ status: 'unavailable' }); });
        expect(probe.current?.resolveInlineTranscriptOccurrence('visual-1')).toBe('second');
        await screen.update(<Harness binding={binding} applierRef={applierRef} openBoard={vi.fn()} />);
        await act(async () => { expect(applierRef.current?.(intent)).toEqual({ status: 'unavailable' }); });
        await screen.unmount();
        expect(applierRef.current).toBeNull();
    });

    it.each([
        ['feature-disabled', { status: 'unavailable', reason: 'board_feature_disabled' } as const, OWNER_ADDRESS],
        ['forbidden or revoked', { status: 'unavailable', reason: 'forbidden' } as const, OWNER_ADDRESS],
        ['wrong exact address', { status: 'ready', snapshot: snapshot('reachable', 'fresh') } as const, {
            serverId: 'home-2',
            sessionId: OWNER_ADDRESS.sessionId,
        }],
    ])('refuses Board presentation without pane mutation when %s', async (_label, binding, bridgeAddress) => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const openBoard = vi.fn(() => ({ status: 'applied' as const }));
        await renderScreen(
            <Harness
                binding={binding}
                bridgeAddress={bridgeAddress}
                applierRef={applierRef}
                openBoard={openBoard}
            />,
        );

        expect(applierRef.current?.({ kind: 'board.open', mode: 'beside_chat' }))
            .toEqual({ status: 'unavailable' });
        expect(openBoard).not.toHaveBeenCalled();
    });

    it('opens a readable transcript item in the local panel while Board reachability is still unknown', async () => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const revealBoardItem = vi.fn(() => ({ status: 'applied' as const }));
        await renderScreen(
            <Harness
                binding={{ status: 'ready', snapshot: snapshotWithReadableTranscriptItem('unknown') }}
                applierRef={applierRef}
                openBoard={vi.fn()}
                revealBoardItem={revealBoardItem}
            />,
        );

        expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'visual-1' }))
            .toEqual({ status: 'applied' });
        expect(revealBoardItem).toHaveBeenCalledWith('visual-1');
    });

    // Opening the local pane creates content demand. Network readiness and
    // freshness cannot be prerequisites for that first navigation.
    it.each([
        ['fresh', 'reachable', 'fresh'],
        ['stale', 'reachable', 'stale'],
        ['offline', 'offline', 'stale'],
        ['not yet demanded', 'unknown', 'stale'],
    ] as const)('opens the exact-Session Board when its repository is %s', async (_label, reachability, freshness) => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const openBoard = vi.fn(() => ({ status: 'applied' as const }));
        await renderScreen(
            <Harness
                binding={{ status: 'ready', snapshot: snapshot(reachability, freshness) }}
                applierRef={applierRef}
                openBoard={openBoard}
            />,
        );

        expect(applierRef.current?.({ kind: 'board.open', mode: 'focus' }))
            .toEqual({ status: 'applied' });
        expect(openBoard).toHaveBeenCalledWith('focus');
    });

    it('undoes a Board view selection to the view that was current before it, and never over a newer choice', async () => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const openBoard = vi.fn(() => ({ status: 'unchanged' as const }));
        const probe: ContinuityProbe = { current: null };
        const screen = await renderScreen(
            <Harness
                binding={{ status: 'ready', snapshot: snapshotWithViews(['a', 'b', 'c']) }}
                applierRef={applierRef}
                openBoard={openBoard}
                continuityProbe={probe}
            />,
        );
        const rerender = async () => await screen.update(
            <Harness
                binding={{ status: 'ready', snapshot: snapshotWithViews(['a', 'b', 'c']) }}
                applierRef={applierRef}
                openBoard={openBoard}
                continuityProbe={probe}
            />,
        );
        probe.current!.viewSelection.request('a');
        await rerender();
        expect(applierRef.current?.({ kind: 'board.view.select', viewId: 'b' })).toMatchObject({ status: 'applied' });
        await rerender();
        expect(probe.current!.viewSelection.read()).toBe('b');

        // The actual published notice inverse restores the pre-command selection.
        readPresentationNotice()?.undo?.run();
        await rerender();
        expect(probe.current!.viewSelection.read()).toBe('a');

        // A newer human selection wins: the old inverse stays inert.
        expect(applierRef.current?.({ kind: 'board.view.select', viewId: 'b' })).toMatchObject({ status: 'applied' });
        await rerender();
        const staleUndo = readPresentationNotice()?.undo;
        probe.current!.viewSelection.request('c');
        await rerender();
        staleUndo?.run();
        await rerender();
        expect(probe.current!.viewSelection.read()).toBe('c');
    });

    it('keeps Companion-only intents independent of unavailable Board currentness', async () => {
        const applierRef = { current: null } as React.MutableRefObject<SessionPresentationIntentApplier | null>;
        const openBoard = vi.fn(() => ({ status: 'applied' as const }));
        await renderScreen(
            <Harness
                binding={{ status: 'unavailable', reason: 'board_feature_disabled' }}
                applierRef={applierRef}
                openBoard={openBoard}
            />,
        );

        expect(applierRef.current?.({ kind: 'companion.show' })).toEqual({ status: 'applied' });
        expect(openBoard).not.toHaveBeenCalled();
    });
});
