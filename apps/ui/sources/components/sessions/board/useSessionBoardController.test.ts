import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
    SessionBoardLayoutV1,
    SessionBoardMutationV1,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';
import { createSessionSurfaceNoteDocumentV1 } from '@happier-dev/protocol/sessions/board';

import { renderHook } from '@/dev/testkit';
import { t } from '@/text';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
    projectSessionBoard,
    type SessionBoardActionOutcome,
    type SessionBoardActionsPort,
    type SessionBoardItemRemoveInput,
    type SessionBoardItemUpsertInput,
    type SessionBoardLayoutUpdateInput,
    type SessionBoardMutationResult,
    type SessionBoardRemovalApprovalDecision,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';
import type { SessionBoardBinding } from './observeSessionBoard';
import type { SessionBoardMutationApprovalRequest } from './sessionBoardMutationApproval';
import {
    SessionBoardContinuityProvider,
    sessionBoardHostedHtmlDraftBufferKey,
    sessionBoardNoteDraftBufferKey,
    useMountedSessionBoardContinuity,
} from './SessionBoardContinuity';

import {
    describeSessionBoardOutcome,
    useSessionBoardController,
    type SessionBoardViewRemovalChoiceRequest,
    type SessionBoardViewRemovalDisposition,
} from './useSessionBoardController';

/** The platform announcement adapter is a real system boundary; nothing below it is mocked. */
const announced = vi.hoisted(() => [] as string[]);
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (message: string) => { announced.push(message); },
}));

/**
 * The one mounted Board controller.
 *
 * Everything a Board surface can invoke resolves here: which commands genuinely
 * have a producer, whether the person may write right now, and what happened when
 * they did. The failures these tests pin are the ones a Board cannot show you —
 * a control that silently does nothing, a write blocked because a refresh made the
 * snapshot stale, and a refused mutation that vanishes without a word.
 */

function note(title: string, body: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1(body) },
    } as SessionSurfaceItemV1;
}

function hostedHtml(title: string, html: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'full_bleed',
        height: { mode: 'fixed', size: 'tall' },
        source: {
            kind: 'hostedHtml',
            source: artifactHtmlBundleFromBodyV1(html),
            requestedCapabilities: { hostMethods: ['notify'] },
        },
        input: { v: 1, values: { mode: 'review' } },
    } as SessionSurfaceItemV1;
}

function readySnapshot(input: Readonly<{
    layout?: SessionBoardLayoutV1 | null;
    items?: ReadonlyArray<Readonly<{ itemId: string; item: SessionSurfaceItemV1 }>>;
    canEdit?: boolean;
    freshness?: 'fresh' | 'stale';
    reachability?: 'reachable' | 'offline' | 'unknown';
}> = {}): SessionBoardSnapshot {
    const items = new Map(
        (input.items ?? []).map(({ itemId, item }) => [itemId, {
            revision: `rev-${itemId}`,
            outcome: { status: 'ready' as const, value: item },
        }] as const),
    );
    return projectSessionBoard({
        layout: input.layout === undefined || input.layout === null
            ? undefined
            : { revision: 'rev-layout', outcome: { status: 'ready', value: input.layout } },
        items,
        capabilities: { readTranscript: true, editSessionRecords: input.canEdit ?? true },
        freshness: input.freshness ?? 'fresh',
        reachability: input.reachability ?? 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

function readySnapshotAtRevision(input: Readonly<{
    layout: SessionBoardLayoutV1;
    layoutRevision: string;
    items?: ReadonlyArray<Readonly<{ itemId: string; item: SessionSurfaceItemV1; revision?: string }>>;
}>): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: {
            revision: input.layoutRevision,
            outcome: { status: 'ready', value: input.layout },
        },
        items: new Map((input.items ?? []).map(({ itemId, item, revision }) => [itemId, {
            revision: revision ?? `rev-${itemId}`,
            outcome: { status: 'ready' as const, value: item },
        }] as const)),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

function binding(
    snapshot: SessionBoardSnapshot,
    refresh: () => void | Promise<void> = () => {},
): SessionBoardBinding & Readonly<{ refresh: () => void | Promise<void> }> {
    return { status: 'ready', snapshot, refresh };
}

type RecordedCall =
    | Readonly<{ kind: 'upsert'; input: SessionBoardItemUpsertInput }>
    | Readonly<{
        kind: 'remove';
        input: SessionBoardItemRemoveInput;
        approval: SessionBoardRemovalApprovalDecision | undefined;
    }>
    | Readonly<{ kind: 'layout'; input: SessionBoardLayoutUpdateInput }>;

function recordingActions(
    outcome: SessionBoardActionOutcome<SessionBoardMutationResult> = {
        status: 'ok',
        value: {
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: { operation: 'update_layout', layoutRevision: 'rev-layout-2' },
            destination: null,
        } as SessionBoardMutationResult,
    },
): Readonly<{ port: SessionBoardActionsPort; calls: RecordedCall[] }> {
    const calls: RecordedCall[] = [];
    return {
        calls,
        port: {
            upsertItem: async (input) => { calls.push({ kind: 'upsert', input }); return outcome; },
            removeItem: async (input, approval) => { calls.push({ kind: 'remove', input, approval }); return outcome; },
            updateLayout: async (input) => { calls.push({ kind: 'layout', input }); return outcome; },
        },
    };
}

const LAYOUT_TWO_VIEWS: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [
        { id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] },
        { id: 'research', title: 'Research', items: [] },
    ],
} as SessionBoardLayoutV1;

function mutableLayout(layout: SessionBoardLayoutV1) {
    return {
        v: 1 as const,
        tabs: layout.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            items: tab.items.map((item) => ({ ...item })),
        })),
    };
}

/**
 * The real viewer-local continuity owner, so retained editor buffers are read
 * and cleared through the same API the mounted editors use.
 */
function continuityWrapper(props: React.PropsWithChildren): React.ReactElement {
    return React.createElement(
        SessionBoardContinuityProvider,
        { sessionId: 'session-1', serverId: 'home-1' },
        props.children,
    );
}

async function mountController(input: Readonly<{
    snapshot: SessionBoardSnapshot;
    serverId?: string;
    sessionId?: string;
    actions?: SessionBoardActionsPort | null;
    askAgent?: (() => void) | undefined;
    confirm?: (() => Promise<boolean>) | undefined;
    promptTitle?: (() => Promise<string | null>) | undefined;
    chooseViewRemovalDisposition?: ((request: SessionBoardViewRemovalChoiceRequest) => Promise<SessionBoardViewRemovalDisposition | null>) | undefined;
    beforeReplaceDraft?: ((replace: () => void | Promise<void>) => true | Promise<boolean>) | undefined;
    refresh?: (() => void) | undefined;
    approvalPending?: boolean;
    callerHostedHtmlAvailable?: boolean;
    requestApprovalContinuation?: ((request: SessionBoardMutationApprovalRequest) => void) | undefined;
}>) {
    return await renderHook(() => useSessionBoardController({
        sessionId: input.sessionId ?? 'session-1',
        serverId: input.serverId ?? 'home-1',
        binding: binding(input.snapshot, input.refresh),
        actions: input.actions === undefined ? recordingActions().port : input.actions,
        ...(input.askAgent ? { onAskAgent: input.askAgent } : {}),
        ...(input.confirm ? { confirmDestructive: input.confirm } : {}),
        ...(input.promptTitle ? { promptViewTitle: input.promptTitle } : {}),
        ...(input.chooseViewRemovalDisposition
            ? { chooseViewRemovalDisposition: input.chooseViewRemovalDisposition }
            : {}),
        ...(input.beforeReplaceDraft ? { beforeReplaceNoteDraft: input.beforeReplaceDraft } : {}),
        ...(input.approvalPending !== undefined ? { approvalPending: input.approvalPending } : {}),
        ...(input.callerHostedHtmlAvailable !== undefined
            ? { callerHostedHtmlAvailable: input.callerHostedHtmlAvailable }
            : {}),
        ...(input.requestApprovalContinuation
            ? { requestApprovalContinuation: input.requestApprovalContinuation }
            : {}),
    }));
}

describe('useSessionBoardController', () => {
    it('retains identity when Ask availability is unchanged and invokes the current handler', async () => {
        const snapshot = readySnapshot();
        const actions = recordingActions().port;
        const firstAsk = vi.fn();
        const nextAsk = vi.fn();
        const initialProps: Readonly<{ snapshot: SessionBoardSnapshot; ask?: () => void }> = { snapshot, ask: firstAsk };
        const hook = await renderHook((props: Readonly<{ snapshot: SessionBoardSnapshot; ask?: () => void }>) => useSessionBoardController({
            sessionId: 'session-1', serverId: 'home-1',
            binding: binding(props.snapshot), actions, onAskAgent: props.ask,
        }), { initialProps });
        const retained = hook.getCurrent();
        expect(await hook.rerender({ snapshot, ask: nextAsk })).toBe(retained);
        await act(async () => { await retained.run({ kind: 'add', intent: 'askAgent' }); });
        expect(firstAsk).not.toHaveBeenCalled();
        expect(nextAsk).toHaveBeenCalledOnce();

        const readOnly = readySnapshot({ canEdit: false });
        await hook.rerender({ snapshot: readOnly });
        const unavailable = hook.getCurrent();
        expect(await hook.rerender({ snapshot: readOnly, ask: nextAsk })).toBe(unavailable);
        expect(unavailable.addIntents).toEqual([]);
        await hook.unmount();
    });

    it.each([false, true])('retains identity for unchanged public fields (continuity: %s) and keeps draft getters live', async (withContinuity) => {
        const snapshot = readySnapshot({
            layout: LAYOUT_TWO_VIEWS,
            items: [{ itemId: 'note-1', item: note('A note', 'Body') }],
        });
        const actions = recordingActions().port;
        const hook = await renderHook((props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
            sessionId: 'session-1',
            serverId: 'home-1',
            binding: binding(props.snapshot),
            actions,
        }), {
            initialProps: { snapshot },
            ...(withContinuity ? { wrapper: continuityWrapper } : {}),
        });
        const retained = hook.getCurrent();
        expect(await hook.rerender()).toBe(retained);

        await act(async () => { await retained.run({ kind: 'item.edit', itemId: 'note-1' }); });
        expect(retained.noteDraft?.itemId).toBe('note-1');
        const editing = hook.getCurrent();
        expect(editing).not.toBe(retained);
        expect(await hook.rerender()).toBe(editing);

        await act(async () => { retained.onNoteSaved(null); });
        expect(retained.noteDraft).toBeNull();
        expect(retained.lastOutcome).toEqual({ kind: 'applied' });
        const settled = hook.getCurrent();
        expect(settled).not.toBe(editing);
        expect(await hook.rerender()).toBe(settled);

        const updated = readySnapshot({ canEdit: false });
        expect(await hook.rerender({ snapshot: updated })).not.toBe(settled);
        expect(hook.getCurrent().snapshot).toBe(updated);
        expect(hook.getCurrent().supports('item.edit')).toBe(false);
        await hook.unmount();
    });

    it('preserves readable CAS revisions in the controller conflict outcome', () => {
        expect(describeSessionBoardOutcome({
            status: 'refused',
            error: {
                error: 'session_board_revision_conflict',
                currentItemRevision: 'item-revision-2',
                currentLayoutRevision: 'layout-revision-3',
            },
        })).toEqual({
            kind: 'conflict',
            currentItemRevision: 'item-revision-2',
            currentLayoutRevision: 'layout-revision-3',
        });
    });

    it('preserves pending approval and definite failure without claiming application', () => {
        expect(describeSessionBoardOutcome({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-board-1',
                actionId: 'session.board.item.remove',
            },
        })).toEqual({
            kind: 'approvalPending',
            artifactId: 'approval-board-1',
            actionId: 'session.board.item.remove',
        });
        expect(describeSessionBoardOutcome({ status: 'failed', code: 'server_error' }))
            .toEqual({ kind: 'failed', error: 'server_error' });
        expect(describeSessionBoardOutcome({ status: 'cancelled' }))
            .toEqual({ kind: 'cancelled' });
    });

    it('publishes durable mutation success through the presentation notice owner without Undo', async () => {
        retirePresentationNotice();
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });

        expect(readPresentationNotice()).toMatchObject({
            key: JSON.stringify(['session-board', '["home-1","session-1"]', 'item.resize', 'note-1']),
            severity: 'info',
        });
        expect(readPresentationNotice()).not.toHaveProperty('undo');
        await hook.unmount();
    });

    it('keeps a mounted mutation pending until the shared approval settles', async () => {
        retirePresentationNotice();
        const actions = recordingActions({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-board-1',
                actionId: 'session.board.layout.update',
            },
        });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            requestApprovalContinuation: vi.fn(),
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        await hook.rerender();

        expect(hook.getCurrent().lastOutcome).toEqual({
            kind: 'approvalPending',
            artifactId: 'approval-board-1',
            actionId: 'session.board.layout.update',
        });
        expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
        await hook.unmount();
    });

    it('blocks duplicate Board mutations until the exact approval continuation settles', async () => {
        const actions = recordingActions({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-board-1',
                actionId: 'session.board.layout.update',
            },
        });
        const refresh = vi.fn();
        let pending = false;
        const continuation = { current: null as Readonly<{
            expectedInput: unknown;
            onSucceeded: (value: SessionBoardMutationResult) => void | Promise<void>;
            onFailed: (code: string) => void;
        }> | null };
        const requestApprovalContinuation = vi.fn((request: NonNullable<typeof continuation.current>) => {
            pending = true;
            continuation.current = request;
        });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            refresh,
            get approvalPending() { return pending; },
            requestApprovalContinuation,
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        await hook.rerender();
        expect(requestApprovalContinuation).toHaveBeenCalledOnce();
        expect(continuation.current?.expectedInput).toEqual(actions.calls[0]?.input);
        expect(hook.getCurrent().supports('item.rename')).toBe(false);

        await hook.getCurrent().run({ kind: 'item.rename', itemId: 'note-1', title: 'Duplicate' });
        expect(actions.calls).toHaveLength(1);

        pending = false;
        await continuation.current?.onSucceeded({
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: { operation: 'update_layout', layoutRevision: 'rev-layout-2' },
            destination: null,
        } as SessionBoardMutationResult);
        await hook.rerender();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'applied' });
        expect(hook.getCurrent().supports('item.rename')).toBe(true);
    });

    it('retains approval execution outcome-unknown as ambiguity instead of flattening it to failure', async () => {
        const actions = recordingActions({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-board-unknown',
                actionId: 'session.board.layout.update',
            },
        });
        const refresh = vi.fn();
        const continuation = { current: null as Readonly<{
            onFailed: (code: string) => void;
        }> | null };
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            refresh,
            requestApprovalContinuation: (request) => { continuation.current = request; },
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        continuation.current?.onFailed('approval_execution_outcome_unknown');
        await hook.rerender();

        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'outcomeUnknown', recovery: null });
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'outcomeUnknown', ready: false });
        expect(hook.getCurrent().supports('item.rename')).toBe(false);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('preserves the authoritative revision from a deferred approval conflict', async () => {
        const actions = recordingActions({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-board-conflict',
                actionId: 'session.board.layout.update',
            },
        });
        const refresh = vi.fn();
        const continuation = { current: null as Readonly<{
            onFailed: NonNullable<SessionBoardMutationApprovalRequest['onFailed']>;
        }> | null };
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            refresh,
            requestApprovalContinuation: (request) => { continuation.current = request; },
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        continuation.current?.onFailed('session_board_revision_conflict', {
            ok: false,
            errorCode: 'session_board_revision_conflict',
            error: 'session_board_revision_conflict',
            details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        });
        await hook.rerender();

        expect(hook.getCurrent().lastOutcome).toEqual({
            kind: 'conflict',
            currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        });
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'conflict', ready: false });
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('re-enables generic controls when an editor-origin shared approval settles', async () => {
        let pending = true;
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            get approvalPending() { return pending; },
        });

        expect(hook.getCurrent().supports('item.rename')).toBe(false);
        pending = false;
        await hook.rerender();
        expect(hook.getCurrent().supports('item.rename')).toBe(true);
    });

    it('publishes caller-hosted HTML save success through the same notice owner', async () => {
        retirePresentationNotice();
        const hook = await mountController({ snapshot: readySnapshot() });

        hook.getCurrent().onHostedHtmlSaved();

        expect(readPresentationNotice()).toMatchObject({
            key: JSON.stringify(['session-board-html-saved', '["home-1","session-1"]', null]),
            severity: 'info',
        });
        expect(readPresentationNotice()).not.toHaveProperty('undo');
        await hook.unmount();
    });

    it('keeps mutation and saved-note notice identity distinct for delimiter-colliding Sessions', async () => {
        retirePresentationNotice();
        const outcome = { status: 'refused' as const, error: { error: 'session_board_revision_conflict' as const } };
        const first = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS, items: [{ itemId: 'note-1', item: note('Plan', 'body') }] }),
            actions: recordingActions(outcome).port,
            serverId: 'home:a',
            sessionId: 'session',
        });
        const second = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS, items: [{ itemId: 'note-1', item: note('Plan', 'body') }] }),
            actions: recordingActions(outcome).port,
            serverId: 'home',
            sessionId: 'a:session',
        });

        await first.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        const firstMutationKey = readPresentationNotice()?.key;
        await second.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        const secondMutationKey = readPresentationNotice()?.key;

        first.getCurrent().onNoteSaved({
            v: 1,
            serverId: 'home:a',
            sessionId: 'session',
            result: { operation: 'upsert_item', itemId: 'note-1', outcome: 'updated', itemRevision: 'rev-2' },
            destination: null,
        });
        const firstSavedKey = readPresentationNotice()?.key;
        second.getCurrent().onNoteSaved({
            v: 1,
            serverId: 'home',
            sessionId: 'a:session',
            result: { operation: 'upsert_item', itemId: 'note-1', outcome: 'updated', itemRevision: 'rev-2' },
            destination: null,
        });
        const secondSavedKey = readPresentationNotice()?.key;

        expect(firstMutationKey).toBe(JSON.stringify(['session-board', '["home:a","session"]', 'item.resize', 'note-1']));
        expect(secondMutationKey).toBe(JSON.stringify(['session-board', '["home","a:session"]', 'item.resize', 'note-1']));
        expect(secondMutationKey).not.toBe(firstMutationKey);
        expect(firstSavedKey).toBe(JSON.stringify(['session-board-note-saved', '["home:a","session"]', 'note-1']));
        expect(secondSavedKey).toBe(JSON.stringify(['session-board-note-saved', '["home","a:session"]', 'note-1']));
        expect(secondSavedKey).not.toBe(firstSavedKey);
        await first.unmount();
        await second.unmount();
    });

    it('keeps an open note draft when replacing it is declined', async () => {
        const beforeReplaceDraft = vi.fn(async () => false);
        const hook = await mountController({ snapshot: readySnapshot(), beforeReplaceDraft });

        await hook.getCurrent().run({ kind: 'add', intent: 'note' });
        await hook.rerender();
        const firstDraft = hook.getCurrent().noteDraft;
        await hook.getCurrent().run({ kind: 'add', intent: 'note' });
        await hook.rerender();

        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().noteDraft).toEqual(firstDraft);
    });

    it('arms and acknowledges one exact rendered-heading focus after a note save', async () => {
        const hook = await mountController({ snapshot: readySnapshot() });

        await hook.getCurrent().run({ kind: 'add', intent: 'note' });
        const itemId = hook.getCurrent().noteDraft?.itemId;
        expect(itemId).toBeTruthy();

        hook.getCurrent().onNoteSaved(null);
        await hook.rerender();

        expect(hook.getCurrent().noteDraft).toBeNull();
        expect(hook.getCurrent().headingFocusRequest).toMatchObject({ itemId });
        const requestId = hook.getCurrent().headingFocusRequest?.requestId;
        expect(requestId).toBeTypeOf('number');

        hook.getCurrent().acknowledgeHeadingFocus(requestId! + 1);
        await hook.rerender();
        expect(hook.getCurrent().headingFocusRequest?.requestId).toBe(requestId);

        hook.getCurrent().acknowledgeHeadingFocus(requestId!);
        await hook.rerender();
        expect(hook.getCurrent().headingFocusRequest).toBeNull();
    });

    it('guards an unsaved note before editing a different note', async () => {
        const beforeReplaceDraft = vi.fn(async () => false);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [{
                        id: 'overview',
                        title: 'Overview',
                        items: [
                            { itemId: 'note-1', width: 'medium' },
                            { itemId: 'note-2', width: 'medium' },
                        ],
                    }],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: note('First', 'first body') },
                    { itemId: 'note-2', item: note('Second', 'second body') },
                ],
            }),
            beforeReplaceDraft,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        const firstDraft = hook.getCurrent().noteDraft;

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-2' });
        await hook.rerender();

        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().noteDraft).toEqual(firstDraft);
    });

    it('does not reset the draft when Edit is invoked for the note already being edited', async () => {
        const beforeReplaceDraft = vi.fn(async () => true);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            beforeReplaceDraft,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        const firstDraft = hook.getCurrent().noteDraft;
        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();

        expect(beforeReplaceDraft).not.toHaveBeenCalled();
        expect(hook.getCurrent().noteDraft).toBe(firstDraft);
    });

    it('opens an existing caller-hosted HTML item in the canonical editor with its CAS revision', async () => {
        const item = hostedHtml('Dashboard', '<main>Before</main>');
        if (item.source.kind !== 'hostedHtml') throw new Error('Expected hosted HTML fixture');
        const entrypoint = item.source.source.files[item.source.source.entrypoint];
        item.source.source = {
            v: 1,
            entrypoint: 'pages/dashboard.html',
            files: {
                'pages/dashboard.html': entrypoint,
                'app.js': { mime: 'application/javascript', contentBase64: 'YWxlcnQoMSk=' },
            },
        };
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item }],
            }),
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();

        expect(hook.getCurrent().noteDraft).toBeNull();
        expect(hook.getCurrent().hostedHtmlDraft).toEqual({
            itemId: 'note-1',
            expectedItemRevision: 'rev-note-1',
            initialTitle: 'Dashboard',
            initialHtml: '<main>Before</main>',
            baseItem: item,
        });
    });

    it('rejects direct hosted-HTML Edit when the caller runtime is unavailable', async () => {
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
            }),
            callerHostedHtmlAvailable: false,
        });

        expect(hook.getCurrent().supportsItemEdit('note-1')).toBe(false);
        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();

        expect(hook.getCurrent().hostedHtmlDraft).toBeNull();
    });

    it('retires a hosted-HTML draft while its runtime is unavailable and restores it when the runtime returns', async () => {
        let runtimeAvailable = true;
        const snapshot = readySnapshot({
            layout: LAYOUT_TWO_VIEWS,
            items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
        });
        const hook = await renderHook(() => useSessionBoardController({
            sessionId: 'session-1',
            serverId: 'home-1',
            binding: binding(snapshot),
            actions: recordingActions().port,
            callerHostedHtmlAvailable: runtimeAvailable,
        }));

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');

        runtimeAvailable = false;
        await hook.rerender();
        expect(hook.getCurrent().hostedHtmlDraft).toBeNull();

        runtimeAvailable = true;
        await hook.rerender();
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');
    });

    it('offers only the add sources that have a real producer in this build', async () => {
        const askAgent = vi.fn();
        const hook = await mountController({ snapshot: readySnapshot(), askAgent });

        // Note is native and Ask Agent has a host handler; hosted HTML and installed
        // widget authoring have no producer, so they are absent rather than inert.
        expect(hook.getCurrent().addIntents).toEqual(['note', 'walkthrough', 'askAgent']);
    });

    it('offers Interactive view when the caller-hosted HTML producer is available', async () => {
        const hook = await renderHook(() => useSessionBoardController({
            sessionId: 'session-1',
            serverId: 'home-1',
            binding: binding(readySnapshot()),
            actions: recordingActions().port,
            callerHostedHtmlAvailable: true,
        }));

        expect(hook.getCurrent().addIntents).toEqual(['note', 'walkthrough', 'interactiveView']);
        await hook.getCurrent().run({ kind: 'add', intent: 'interactiveView' });
        await hook.rerender();
        expect(hook.getCurrent().hostedHtmlDraft).toMatchObject({
            placement: { tabId: 'overview' },
        });
    });
    it('creates a live walkthrough and its first placement in the ordinary atomic Board mutation', async () => {
        const actions = recordingActions();
        const hook = await mountController({ snapshot: readySnapshot(), actions: actions.port });
        await hook.getCurrent().run({ kind: 'add', intent: 'walkthrough' });
        expect(actions.calls).toHaveLength(1);
        expect(actions.calls[0]).toMatchObject({ kind: 'upsert', input: {
            sessionId: 'session-1', expectedItemRevision: null,
            item: { source: { kind: 'walkthrough', comparison: 'session' }, height: { mode: 'auto', fallback: 'compact' } },
            placement: { tabId: 'overview' },
        } });
    });

    it('omits every add source when the viewer cannot edit', async () => {
        const hook = await mountController({ snapshot: readySnapshot({ canEdit: false }) });
        expect(hook.getCurrent().addIntents).toEqual([]);
        expect(hook.getCurrent().supports('item.remove')).toBe(false);
    });

    it('keeps editing available on a stale but reachable snapshot', async () => {
        // Freshness is not permission: a post-mutation invalidation must not take the
        // Board's controls away or claim the person is offline.
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
                freshness: 'stale',
            }),
            actions: actions.port,
        });

        expect(hook.getCurrent().supports('item.resize')).toBe(true);
        expect(hook.getCurrent().mutationsBlockedReason).toBeNull();
        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        expect(actions.calls).toHaveLength(1);
    });

    it('pauses writes and explains why when the Home is unreachable', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
                reachability: 'offline',
            }),
            actions: actions.port,
        });

        expect(hook.getCurrent().mutationsBlockedReason).toBe('offline');
        expect(hook.getCurrent().supports('item.resize')).toBe(false);
        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'wide' });
        expect(actions.calls).toEqual([]);
    });

    it('creates the first real Overview view atomically with the first note', async () => {
        const actions = recordingActions();
        const hook = await mountController({ snapshot: readySnapshot(), actions: actions.port });

        await hook.getCurrent().run({ kind: 'add', intent: 'note' });
        await hook.rerender();

        const draft = hook.getCurrent().noteDraft;
        expect(draft).not.toBeNull();
        // The synthetic Overview must become a real layout row in the SAME mutation;
        // an undefined tabId is rejected by the aggregate.
        expect(draft?.placement?.tabId).toBe('overview');
        expect(draft?.placement?.tabTitle).toBeTruthy();
    });

    it('reports a refused mutation instead of dropping it', async () => {
        const actions = recordingActions({ status: 'refused', error: { error: 'session_board_revision_conflict' } });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [{
                        id: 'overview',
                        title: 'Overview',
                        items: [{ itemId: 'note-1', width: 'medium' }, { itemId: 'note-2', width: 'medium' }],
                    }],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: note('Plan', 'body') },
                    { itemId: 'note-2', item: note('Later', 'body') },
                ],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.move', itemId: 'note-1', direction: 'after' });
        await hook.rerender();

        expect(actions.calls).toHaveLength(1);
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'conflict' });
    });

    it('moves an item to another Board view through one anchored layout operation', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.moveToView', itemId: 'note-1', viewId: 'research' });

        expect(actions.calls).toEqual([{
            kind: 'layout',
            input: {
                sessionId: 'session-1',
                expectedLayoutRevision: 'rev-layout',
                operation: {
                    op: 'item.move',
                    itemId: 'note-1',
                    fromTabId: 'overview',
                    toTabId: 'research',
                },
            },
        }]);
    });

    it('commits an arbitrary direct-manipulation destination as exactly one anchored layout Action', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [{
                        id: 'overview',
                        title: 'Overview',
                        items: [
                            { itemId: 'note-1', width: 'medium' },
                            { itemId: 'note-2', width: 'medium' },
                            { itemId: 'note-3', width: 'medium' },
                            { itemId: 'note-4', width: 'medium' },
                        ],
                    }],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: note('One', 'body') },
                    { itemId: 'note-2', item: note('Two', 'body') },
                    { itemId: 'note-3', item: note('Three', 'body') },
                    { itemId: 'note-4', item: note('Four', 'body') },
                ],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({
            kind: 'item.moveAnchored',
            itemId: 'note-1',
            fromViewId: 'overview',
            toViewId: 'overview',
            anchor: { side: 'after', itemId: 'note-4' },
        });

        expect(actions.calls).toEqual([{
            kind: 'layout',
            input: {
                sessionId: 'session-1',
                expectedLayoutRevision: 'rev-layout',
                operation: {
                    op: 'item.move',
                    itemId: 'note-1',
                    fromTabId: 'overview',
                    toTabId: 'overview',
                    anchor: { side: 'after', itemId: 'note-4' },
                },
            },
        }]);
    });

    it('does not move an item into a view where it already has an independent placement', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] },
                        { id: 'research', title: 'Research', items: [{ itemId: 'note-1', width: 'full' }] },
                    ],
                } as SessionBoardLayoutV1,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.moveToView', itemId: 'note-1', viewId: 'research' });

        expect(actions.calls).toEqual([]);
    });

    it('reports an unknown outcome rather than claiming success', async () => {
        const intent = { sessionId: 'session-1', expectedLayoutRevision: 'rev-layout', operation: { op: 'item.resize' as const, tabId: 'overview', itemId: 'note-1', width: 'full' as const } };
        const mutationRequest: SessionBoardMutationV1 = {
            operation: 'update_layout',
            expectedLayoutRevision: 'rev-layout',
            layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
        };
        const actions = recordingActions({
            status: 'outcome_unknown',
            recovery: {
                v: 1,
                actionId: 'session.board.layout.update',
                serverId: 'home-1',
                sessionId: 'session-1',
                requestBody: JSON.stringify(mutationRequest),
                mutationRequest,
                intent,
            },
        });
        const refresh = vi.fn();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            refresh,
        });

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'full' });
        await hook.rerender();
        expect(hook.getCurrent().lastOutcome).toMatchObject({ kind: 'outcomeUnknown' });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('blocks generic mutations after a lost response and settles only when refreshed Board state proves the resize', async () => {
        const mutationRequest: SessionBoardMutationV1 = {
            operation: 'update_layout',
            expectedLayoutRevision: 'rev-layout',
            layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
        };
        const actions = recordingActions({
            status: 'outcome_unknown',
            recovery: {
                v: 1,
                actionId: 'session.board.layout.update',
                serverId: 'home-1',
                sessionId: 'session-1',
                requestBody: JSON.stringify(mutationRequest),
                mutationRequest,
                intent: {
                    sessionId: 'session-1',
                    expectedLayoutRevision: 'rev-layout',
                    operation: { op: 'item.resize', tabId: 'overview', itemId: 'note-1', width: 'full' },
                },
            },
        });
        const refresh = vi.fn();
        const initial = readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        });
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot, refresh),
                actions: actions.port,
            }),
            { initialProps: { snapshot: initial } },
        );

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'full' });
        // The exact retained mutation must close the synchronous gap before
        // React publishes the next controller render; a double press cannot
        // dispatch a second write in that window.
        await hook.getCurrent().run({ kind: 'item.rename', itemId: 'note-1', title: 'Must not dispatch' });
        expect(actions.calls).toHaveLength(1);
        await hook.rerender();

        expect(hook.getCurrent().supports('item.rename')).toBe(false);
        await hook.getCurrent().run({ kind: 'item.rename', itemId: 'note-1', title: 'Must not dispatch' });
        expect(actions.calls).toHaveLength(1);
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'outcomeUnknown', ready: false });

        await hook.rerender({ snapshot: {
            ...initial,
            freshness: 'stale',
            loading: 'refreshing',
        } });

        await hook.rerender({
            snapshot: readySnapshotAtRevision({
                layout: {
                    ...LAYOUT_TWO_VIEWS,
                    tabs: [
                        { ...LAYOUT_TWO_VIEWS.tabs[0]!, items: [{ itemId: 'note-1', width: 'full' }] },
                        LAYOUT_TWO_VIEWS.tabs[1]!,
                    ],
                } as SessionBoardLayoutV1,
                layoutRevision: 'rev-layout-2',
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
        });

        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'applied' });
        expect(hook.getCurrent().mutationRecovery).toBeNull();
        expect(hook.getCurrent().supports('item.rename')).toBe(true);
    });

    it('offers one deliberate retry only after refresh leaves an outcome-unknown resize unapplied', async () => {
        const calls: SessionBoardLayoutUpdateInput[] = [];
        let attempt = 0;
        const actions: SessionBoardActionsPort = {
            upsertItem: async () => ({ status: 'failed', code: 'unexpected' }),
            removeItem: async () => ({ status: 'failed', code: 'unexpected' }),
            updateLayout: async (
                input,
            ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
                calls.push(input);
                attempt += 1;
                if (attempt === 1) {
                    const mutationRequest: SessionBoardMutationV1 = {
                        operation: 'update_layout',
                        expectedLayoutRevision: input.expectedLayoutRevision,
                        layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
                    };
                    return {
                        status: 'outcome_unknown',
                        recovery: {
                            v: 1,
                            actionId: 'session.board.layout.update',
                            serverId: 'home-1',
                            sessionId: 'session-1',
                            requestBody: JSON.stringify(mutationRequest),
                            mutationRequest,
                            intent: input,
                        },
                    };
                }
                return {
                    status: 'ok',
                    value: {
                        v: 1,
                        serverId: 'home-1',
                        sessionId: 'session-1',
                        result: { operation: 'update_layout', outcome: 'updated', layoutRevision: 'rev-layout-2' },
                        destination: null,
                    },
                };
            },
        };
        const refresh = vi.fn();
        const initial = readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        });
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot, refresh),
                actions,
            }),
            { initialProps: { snapshot: initial } },
        );

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'full' });
        await hook.rerender();
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'outcomeUnknown', ready: false });

        // This distinct fresh snapshot is the canonical repository's completed
        // refresh. The unchanged revision proves neither effect nor non-effect,
        // so only an explicit retry is enabled; no automatic replay occurs.
        await hook.rerender({ snapshot: {
            ...initial,
            freshness: 'stale',
            loading: 'refreshing',
        } });
        await hook.rerender({ snapshot: readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        }) });
        expect(calls).toHaveLength(1);
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'outcomeUnknown', ready: true });

        await hook.getCurrent().retryLastMutation();
        await hook.rerender();
        expect(calls).toHaveLength(2);
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'applied' });
        expect(hook.getCurrent().mutationRecovery).toBeNull();
    });

    it('retains a revision conflict through canonical refresh and retries only on explicit user intent', async () => {
        const calls: SessionBoardLayoutUpdateInput[] = [];
        const actions: SessionBoardActionsPort = {
            upsertItem: async () => ({ status: 'failed', code: 'unexpected' }),
            removeItem: async () => ({ status: 'failed', code: 'unexpected' }),
            updateLayout: async (
                input,
            ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
                calls.push(input);
                if (calls.length === 1) {
                    return {
                        status: 'refused',
                        error: {
                            error: 'session_board_revision_conflict',
                            currentLayoutRevision: 'rev-layout-2',
                        },
                    };
                }
                return {
                    status: 'ok',
                    value: {
                        v: 1,
                        serverId: 'home-1',
                        sessionId: 'session-1',
                        result: { operation: 'update_layout', outcome: 'updated', layoutRevision: 'rev-layout-3' },
                        destination: null,
                    },
                };
            },
        };
        const refresh = vi.fn();
        const initial = readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        });
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot, refresh),
                actions,
            }),
            { initialProps: { snapshot: initial } },
        );

        await hook.getCurrent().run({ kind: 'item.resize', itemId: 'note-1', width: 'full' });
        await hook.rerender();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'conflict', ready: false });
        expect(hook.getCurrent().supports('item.rename')).toBe(false);

        await hook.rerender({ snapshot: {
            ...initial,
            freshness: 'stale',
            loading: 'refreshing',
        } });
        await hook.rerender({ snapshot: readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout-2',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        }) });
        expect(calls).toHaveLength(1);
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'conflict', ready: true });

        await hook.getCurrent().retryLastMutation();
        await hook.rerender();
        expect(calls).toHaveLength(2);
        expect(calls[1]?.expectedLayoutRevision).toBe('rev-layout-2');
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'applied' });
        expect(hook.getCurrent().mutationRecovery).toBeNull();
    });

    it('settles an outcome-unknown removal when refreshed state proves the item and every placement are gone', async () => {
        const mutationRequest: SessionBoardMutationV1 = {
            operation: 'remove_item',
            itemId: 'note-1',
            expectedItemRevision: 'rev-note-1',
            expectedLayoutRevision: 'rev-layout',
            layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
        };
        const actions = recordingActions({
            status: 'outcome_unknown',
            recovery: {
                v: 1,
                actionId: 'session.board.item.remove',
                serverId: 'home-1',
                sessionId: 'session-1',
                requestBody: JSON.stringify(mutationRequest),
                mutationRequest,
                intent: {
                    sessionId: 'session-1',
                    itemId: 'note-1',
                    expectedItemRevision: 'rev-note-1',
                    expectedLayoutRevision: 'rev-layout',
                },
            },
        });
        const initial = readySnapshotAtRevision({
            layout: LAYOUT_TWO_VIEWS,
            layoutRevision: 'rev-layout',
            items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
        });
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot),
                actions: actions.port,
                confirmDestructive: async () => true,
            }),
            { initialProps: { snapshot: initial } },
        );

        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender({ snapshot: readySnapshotAtRevision({
            layout: {
                ...LAYOUT_TWO_VIEWS,
                tabs: [
                    { ...LAYOUT_TWO_VIEWS.tabs[0]!, items: [] },
                    LAYOUT_TWO_VIEWS.tabs[1]!,
                ],
            } as SessionBoardLayoutV1,
            layoutRevision: 'rev-layout-2',
        }) });

        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'applied' });
        expect(hook.getCurrent().mutationRecovery).toBeNull();
    });

    it('requires an explicit confirmation before removing a shared item', async () => {
        const actions = recordingActions();
        const confirm = vi.fn(async () => false);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            confirm,
        });

        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(actions.calls).toEqual([]);
    });

    it('guards the active note draft before removing the note being edited', async () => {
        const actions = recordingActions();
        const beforeReplaceDraft = vi.fn(async () => false);
        const confirm = vi.fn(async () => true);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(actions.calls).toEqual([]);
        expect(hook.getCurrent().noteDraft?.itemId).toBe('note-1');
    });

    it('does not guard an unrelated draft when removing a different item', async () => {
        const actions = recordingActions();
        const beforeReplaceDraft = vi.fn(async () => false);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [{
                        id: 'overview',
                        title: 'Overview',
                        items: [
                            { itemId: 'note-1', width: 'medium' },
                            { itemId: 'note-2', width: 'medium' },
                        ],
                    }],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: note('Draft', 'draft body') },
                    { itemId: 'note-2', item: note('Remove me', 'body') },
                ],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm: async () => true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-2' });

        expect(beforeReplaceDraft).not.toHaveBeenCalled();
        expect(actions.calls).toEqual([{
            kind: 'remove',
            approval: { approvalDecisionApplied: true },
            input: {
                sessionId: 'session-1',
                itemId: 'note-2',
                expectedItemRevision: 'rev-note-2',
                expectedLayoutRevision: 'rev-layout',
            },
        }]);
        expect(hook.getCurrent().noteDraft?.itemId).toBe('note-1');
    });

    /**
     * A hosted-HTML draft is the same unsaved human work as a Note draft.
     *
     * Removal consulted only the Note side of the one draft-replacing guard, so
     * removing the interactive view being edited skipped Keep Editing / Save /
     * Discard entirely: the record was deleted, the editor stayed mounted over
     * nothing, and the final input was lost with no decision offered.
     */
    it('guards the hosted-HTML draft before removing the interactive view being edited', async () => {
        const actions = recordingActions();
        const beforeReplaceDraft = vi.fn(async () => false);
        const confirm = vi.fn(async () => true);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm,
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        // Keep Editing: no destructive confirmation, no write, editor retained.
        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(actions.calls).toEqual([]);
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');
    });

    it('does not guard an unrelated hosted-HTML draft when removing a different item', async () => {
        const actions = recordingActions();
        const beforeReplaceDraft = vi.fn(async () => false);
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [{
                        id: 'overview',
                        title: 'Overview',
                        items: [
                            { itemId: 'note-1', width: 'medium' },
                            { itemId: 'note-2', width: 'medium' },
                        ],
                    }],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') },
                    { itemId: 'note-2', item: note('Remove me', 'body') },
                ],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm: async () => true,
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-2' });
        await hook.rerender();

        expect(beforeReplaceDraft).not.toHaveBeenCalled();
        expect(actions.calls).toHaveLength(1);
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');
    });

    it('retires the edited hosted-HTML draft only after the removal is applied', async () => {
        const actions = recordingActions();
        const order: string[] = [];
        const beforeReplaceDraft = vi.fn(async (replace: () => void | Promise<void>) => {
            order.push('guard');
            await replace();
            return true;
        });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm: async () => { order.push('confirm'); return true; },
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        // The editor's own decision runs BEFORE destructive confirmation.
        expect(order).toEqual(['guard', 'confirm']);
        expect(actions.calls).toEqual([{
            kind: 'remove',
            approval: { approvalDecisionApplied: true },
            input: {
                sessionId: 'session-1',
                itemId: 'note-1',
                expectedItemRevision: 'rev-note-1',
                expectedLayoutRevision: 'rev-layout',
            },
        }]);
        expect(hook.getCurrent().hostedHtmlDraft).toBeNull();
    });

    it('keeps the hosted-HTML draft mounted when the removal conflicts', async () => {
        const actions = recordingActions({
            status: 'refused',
            error: {
                error: 'session_board_revision_conflict',
                currentItemRevision: 'rev-note-1b',
                currentLayoutRevision: 'rev-layout-2',
            },
        });
        const beforeReplaceDraft = vi.fn(async (replace: () => void | Promise<void>) => {
            await replace();
            return true;
        });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm: async () => true,
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'conflict' });
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');
    });

    it('keeps the hosted-HTML draft mounted when the removal outcome is unknown', async () => {
        const intent: SessionBoardItemRemoveInput = {
            sessionId: 'session-1',
            itemId: 'note-1',
            expectedItemRevision: 'rev-note-1',
            expectedLayoutRevision: 'rev-layout',
        };
        const mutationRequest: SessionBoardMutationV1 = {
            operation: 'remove_item',
            itemId: 'note-1',
            expectedItemRevision: 'rev-note-1',
            layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
            expectedLayoutRevision: 'rev-layout',
        };
        const actions = recordingActions({
            status: 'outcome_unknown',
            recovery: {
                v: 1,
                actionId: 'session.board.item.remove',
                serverId: 'home-1',
                sessionId: 'session-1',
                requestBody: JSON.stringify(mutationRequest),
                mutationRequest,
                intent,
            },
        });
        const beforeReplaceDraft = vi.fn(async (replace: () => void | Promise<void>) => {
            await replace();
            return true;
        });
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
            }),
            actions: actions.port,
            beforeReplaceDraft,
            confirm: async () => true,
            callerHostedHtmlAvailable: true,
        });

        await hook.getCurrent().run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(beforeReplaceDraft).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().mutationRecovery).toMatchObject({ kind: 'outcomeUnknown' });
        expect(hook.getCurrent().hostedHtmlDraft?.itemId).toBe('note-1');
    });

    it('retires the retained draft buffer after an applied removal', async () => {
        const actions = recordingActions();
        const beforeReplaceDraft = async (replace: () => void | Promise<void>) => {
            await replace();
            return true;
        };
        const hook = await renderHook(() => ({
            controller: useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(readySnapshot({
                    layout: LAYOUT_TWO_VIEWS,
                    items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
                })),
                actions: actions.port,
                confirmDestructive: async () => true,
                beforeReplaceNoteDraft: beforeReplaceDraft,
                callerHostedHtmlAvailable: true,
            }),
            continuity: useMountedSessionBoardContinuity(),
        }), { wrapper: continuityWrapper });

        const bufferKey = sessionBoardHostedHtmlDraftBufferKey('note-1');
        await hook.getCurrent().controller.run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        // The mounted editor's retained input, written through its real owner.
        hook.getCurrent().continuity?.editorDrafts.write(bufferKey, {
            title: 'Dashboard',
            html: '<main>final</main>',
        });

        await hook.getCurrent().controller.run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();
        expect(hook.getCurrent().controller.hostedHtmlDraft).toBeNull();
        expect(hook.getCurrent().continuity?.editorDrafts.read(bufferKey)).toBeNull();
    });

    it('retires the retained note buffer only after an applied removal', async () => {
        const actions = recordingActions();
        const hook = await renderHook(() => ({
            controller: useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(readySnapshot({
                    layout: LAYOUT_TWO_VIEWS,
                    items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
                })),
                actions: actions.port,
                confirmDestructive: async () => true,
                beforeReplaceNoteDraft: async (replace: () => void | Promise<void>) => {
                    await replace();
                    return true;
                },
            }),
            continuity: useMountedSessionBoardContinuity(),
        }), { wrapper: continuityWrapper });

        await hook.getCurrent().controller.run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        const bufferKey = sessionBoardNoteDraftBufferKey('note-1', 'rev-note-1');
        hook.getCurrent().continuity?.editorDrafts.write(bufferKey, { title: 'Plan', body: 'final' });

        await hook.getCurrent().controller.run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(hook.getCurrent().controller.noteDraft).toBeNull();
        expect(hook.getCurrent().continuity?.editorDrafts.read(bufferKey)).toBeNull();
    });

    it('removes a saved note with the committed revision while retaining its draft until removal applies', async () => {
        const calls: SessionBoardItemRemoveInput[] = [];
        let saveDuringGuard = () => {};
        let readDraftBuffer = (): unknown => null;
        let draftAtRemoval: unknown = null;
        const actions: SessionBoardActionsPort = {
            upsertItem: recordingActions().port.upsertItem,
            removeItem: async (input) => {
                calls.push(input);
                draftAtRemoval = readDraftBuffer();
                if (input.expectedItemRevision !== 'rev-note-2') {
                    return {
                        status: 'refused',
                        error: {
                            error: 'session_board_revision_conflict',
                            currentItemRevision: 'rev-note-2',
                            currentLayoutRevision: 'rev-layout',
                        },
                    };
                }
                return {
                    status: 'ok',
                    value: {
                        v: 1,
                        serverId: 'home-1',
                        sessionId: 'session-1',
                        result: {
                            operation: 'remove_item',
                            itemId: 'note-1',
                            outcome: 'removed',
                            layoutRevision: 'rev-layout-2',
                        },
                        destination: null,
                    },
                };
            },
            updateLayout: recordingActions().port.updateLayout,
        };
        const hook = await renderHook(() => ({
            controller: useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(readySnapshot({
                    layout: LAYOUT_TWO_VIEWS,
                    items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
                })),
                actions,
                confirmDestructive: async () => true,
                beforeReplaceNoteDraft: async (replace: () => void | Promise<void>) => {
                    saveDuringGuard();
                    await replace();
                    return true;
                },
            }),
            continuity: useMountedSessionBoardContinuity(),
        }), { wrapper: continuityWrapper });

        await hook.getCurrent().controller.run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        const bufferKey = sessionBoardNoteDraftBufferKey('note-1', 'rev-note-1');
        hook.getCurrent().continuity?.editorDrafts.write(bufferKey, { title: 'Plan', body: 'final' });
        readDraftBuffer = () => hook.getCurrent().continuity?.editorDrafts.read(bufferKey);
        saveDuringGuard = () => hook.getCurrent().controller.onNoteSaved({
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: {
                operation: 'upsert_item',
                itemId: 'note-1',
                outcome: 'updated',
                itemRevision: 'rev-note-2',
            },
            destination: null,
        });

        await hook.getCurrent().controller.run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(calls).toHaveLength(1);
        expect(calls[0]?.expectedItemRevision).toBe('rev-note-2');
        expect(draftAtRemoval).toEqual({ title: 'Plan', body: 'final' });
        expect(hook.getCurrent().controller.noteDraft).toBeNull();
        expect(hook.getCurrent().continuity?.editorDrafts.read(bufferKey)).toBeNull();
        expect(hook.getCurrent().controller.lastOutcome).toEqual({ kind: 'applied' });
    });

    it('removes saved hosted HTML with the committed revision while retaining its draft until removal applies', async () => {
        const calls: SessionBoardItemRemoveInput[] = [];
        let saveDuringGuard = () => {};
        let readDraftBuffer = (): unknown => null;
        let draftAtRemoval: unknown = null;
        const actions: SessionBoardActionsPort = {
            upsertItem: recordingActions().port.upsertItem,
            removeItem: async (input) => {
                calls.push(input);
                draftAtRemoval = readDraftBuffer();
                if (input.expectedItemRevision !== 'rev-html-2') {
                    return {
                        status: 'refused',
                        error: {
                            error: 'session_board_revision_conflict',
                            currentItemRevision: 'rev-html-2',
                            currentLayoutRevision: 'rev-layout',
                        },
                    };
                }
                return {
                    status: 'ok',
                    value: {
                        v: 1,
                        serverId: 'home-1',
                        sessionId: 'session-1',
                        result: {
                            operation: 'remove_item',
                            itemId: 'note-1',
                            outcome: 'removed',
                            layoutRevision: 'rev-layout-2',
                        },
                        destination: null,
                    },
                };
            },
            updateLayout: recordingActions().port.updateLayout,
        };
        const hook = await renderHook(() => ({
            controller: useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(readySnapshot({
                    layout: LAYOUT_TWO_VIEWS,
                    items: [{ itemId: 'note-1', item: hostedHtml('Dashboard', '<main>Before</main>') }],
                })),
                actions,
                confirmDestructive: async () => true,
                beforeReplaceNoteDraft: async (replace: () => void | Promise<void>) => {
                    saveDuringGuard();
                    await replace();
                    return true;
                },
                callerHostedHtmlAvailable: true,
            }),
            continuity: useMountedSessionBoardContinuity(),
        }), { wrapper: continuityWrapper });

        await hook.getCurrent().controller.run({ kind: 'item.edit', itemId: 'note-1' });
        await hook.rerender();
        const bufferKey = sessionBoardHostedHtmlDraftBufferKey('note-1');
        hook.getCurrent().continuity?.editorDrafts.write(bufferKey, {
            title: 'Dashboard',
            html: '<main>final</main>',
        });
        readDraftBuffer = () => hook.getCurrent().continuity?.editorDrafts.read(bufferKey);
        saveDuringGuard = () => hook.getCurrent().controller.onHostedHtmlSaved({
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: {
                operation: 'upsert_item',
                itemId: 'note-1',
                outcome: 'updated',
                itemRevision: 'rev-html-2',
            },
            destination: null,
        });

        await hook.getCurrent().controller.run({ kind: 'item.remove', itemId: 'note-1' });
        await hook.rerender();

        expect(calls).toHaveLength(1);
        expect(calls[0]?.expectedItemRevision).toBe('rev-html-2');
        expect(draftAtRemoval).toEqual({ title: 'Dashboard', html: '<main>final</main>' });
        expect(hook.getCurrent().controller.hostedHtmlDraft).toBeNull();
        expect(hook.getCurrent().continuity?.editorDrafts.read(bufferKey)).toBeNull();
        expect(hook.getCurrent().controller.lastOutcome).toEqual({ kind: 'applied' });
    });

    it('removes the item and every placement once the person confirms', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            confirm: async () => true,
        });

        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });
        expect(actions.calls).toEqual([{
            kind: 'remove',
            approval: { approvalDecisionApplied: true },
            input: {
                sessionId: 'session-1',
                itemId: 'note-1',
                expectedItemRevision: 'rev-note-1',
                expectedLayoutRevision: 'rev-layout',
            },
        }]);
    });

    it('keeps Action approval routing fail-closed when no UI confirmation host is mounted', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: LAYOUT_TWO_VIEWS,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'note-1' });

        expect(actions.calls).toEqual([{
            kind: 'remove',
            approval: undefined,
            input: {
                sessionId: 'session-1',
                itemId: 'note-1',
                expectedItemRevision: 'rev-note-1',
                expectedLayoutRevision: 'rev-layout',
            },
        }]);
    });

    it('does not publish an invalid removal while the shared layout row is absent', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: null,
                items: [{ itemId: 'orphan-1', item: note('Recovered', 'body') }],
            }),
            actions: actions.port,
            confirm: async () => true,
        });

        expect(hook.getCurrent().recoveredItemIds).toEqual(['orphan-1']);
        await hook.getCurrent().run({ kind: 'item.remove', itemId: 'orphan-1' });

        expect(actions.calls).toEqual([]);
    });

    // A reorder is a momentary event, not Board state. Writing it into the
    // surface's one status line left "Release plan — Move up" printed under the
    // view strip for the rest of the session, and the line itself was assembled
    // in code from an item title, an em dash and an unrelated menu label.
    it('announces a completed move once instead of printing a permanent board status line', async () => {
        announced.length = 0;
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [
                        {
                            id: 'overview',
                            title: 'Overview',
                            items: [
                                { itemId: 'note-1', width: 'medium' },
                                { itemId: 'note-2', width: 'medium' },
                            ],
                        },
                        { id: 'research', title: 'Research', items: [] },
                    ],
                } as SessionBoardLayoutV1,
                items: [
                    { itemId: 'note-1', item: note('Release plan', 'body') },
                    { itemId: 'note-2', item: note('Second', 'body') },
                ],
            }),
        });

        await hook.getCurrent().run({ kind: 'item.move', itemId: 'note-1', direction: 'after' });
        await hook.rerender();

        expect(announced).toEqual([t('sessionBoard.item.moved.after', { title: 'Release plan' })]);
        expect(hook.getCurrent().announcement).toBeNull();

        await hook.getCurrent().run({ kind: 'item.moveToView', itemId: 'note-1', viewId: 'research' });
        await hook.rerender();

        expect(announced.at(-1)).toBe(
            t('sessionBoard.item.moved.toView', { title: 'Release plan', view: 'Research' }),
        );
        expect(hook.getCurrent().announcement).toBeNull();
        await hook.unmount();
    });

    it('keeps the viewer-local selection and reconciles it when the view disappears', async () => {
        const snapshot = readySnapshot({ layout: LAYOUT_TWO_VIEWS });
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot),
                actions: recordingActions().port,
            }),
            { initialProps: { snapshot } },
        );

        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();
        expect(hook.getCurrent().activeViewId).toBe('research');

        // A collaborator deleted "Research" remotely.
        await hook.rerender({
            snapshot: readySnapshot({
                layout: { v: 1, tabs: [LAYOUT_TWO_VIEWS.tabs[0]!] } as SessionBoardLayoutV1,
            }),
        });
        expect(hook.getCurrent().activeViewId).toBe('overview');
        expect(hook.getCurrent().announcement).not.toBeNull();
    });

    it('reconciles a remotely removed active view to the nearest survivor when Overview is absent', async () => {
        const initialLayout = {
            v: 1,
            tabs: [
                { id: 'planning', title: 'Planning', items: [] },
                { id: 'research', title: 'Research', items: [] },
                { id: 'decisions', title: 'Decisions', items: [] },
            ],
        } as SessionBoardLayoutV1;
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot),
                actions: recordingActions().port,
            }),
            { initialProps: { snapshot: readySnapshot({ layout: initialLayout }) } },
        );

        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();
        expect(hook.getCurrent().activeViewId).toBe('research');

        await hook.rerender({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [initialLayout.tabs[0]!, initialLayout.tabs[2]!],
                } as SessionBoardLayoutV1,
            }),
        });

        // The next view occupied the removed view's position. Falling back to
        // the first tab would make a remote update needlessly jump backwards.
        expect(hook.getCurrent().activeViewId).toBe('decisions');
        expect(hook.getCurrent().announcement).not.toBeNull();
    });

    it('retains the selected view identity through a local removal so the authoritative layout selects the nearest survivor', async () => {
        const initialLayout = {
            v: 1,
            tabs: [
                { id: 'planning', title: 'Planning', items: [] },
                { id: 'research', title: 'Research', items: [] },
                { id: 'decisions', title: 'Decisions', items: [] },
            ],
        } as SessionBoardLayoutV1;
        const actions = recordingActions();
        const hook = await renderHook(
            (props: Readonly<{ snapshot: SessionBoardSnapshot }>) => useSessionBoardController({
                sessionId: 'session-1',
                serverId: 'home-1',
                binding: binding(props.snapshot),
                actions: actions.port,
                confirmDestructive: async () => true,
            }),
            { initialProps: { snapshot: readySnapshot({ layout: initialLayout }) } },
        );

        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();
        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });
        await hook.rerender();

        // The mutation acknowledgement is not the new layout. Keep focus and
        // selection on the still-mounted selected tab until repository refresh.
        expect(hook.getCurrent().activeViewId).toBe('research');
        expect(hook.getCurrent().viewRemovalFocusRequest).toMatchObject({ removedViewId: 'research' });

        await hook.rerender({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [initialLayout.tabs[0]!, initialLayout.tabs[2]!],
                } as SessionBoardLayoutV1,
            }),
        });

        expect(hook.getCurrent().activeViewId).toBe('decisions');
        expect(hook.getCurrent().announcement).not.toBeNull();
    });

    it('selects a newly created view only after the layout mutation is applied', async () => {
        const actions = recordingActions({ status: 'refused', error: { error: 'session_board_revision_conflict' } });
        const hook = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS }),
            actions: actions.port,
            promptTitle: async () => 'Decisions',
        });

        await hook.getCurrent().run({ kind: 'view.create' });
        await hook.rerender();

        expect(hook.getCurrent().activeViewId).toBe('overview');
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'conflict' });
    });

    it('keeps the selected view when its removal outcome is unknown', async () => {
        const mutationRequest: SessionBoardMutationV1 = {
            operation: 'update_layout',
            expectedLayoutRevision: 'rev-layout',
            layoutContent: { t: 'plain', v: mutableLayout(LAYOUT_TWO_VIEWS) },
        };
        const actions = recordingActions({
            status: 'outcome_unknown',
            recovery: {
                v: 1,
                actionId: 'session.board.layout.update',
                serverId: 'home-1',
                sessionId: 'session-1',
                requestBody: JSON.stringify(mutationRequest),
                mutationRequest,
                intent: {
                    sessionId: 'session-1',
                    expectedLayoutRevision: 'rev-layout',
                    operation: { op: 'tab.remove', tabId: 'research', disposition: { kind: 'unpin' } },
                },
            },
        });
        const hook = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS }),
            actions: actions.port,
            confirm: async () => true,
        });
        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });
        await hook.rerender();

        expect(hook.getCurrent().activeViewId).toBe('research');
        expect(hook.getCurrent().viewRemovalFocusRequest).toBeNull();
        expect(hook.getCurrent().lastOutcome).toMatchObject({ kind: 'outcomeUnknown' });
    });

    it('does not request removal focus for a conflicted selected-view mutation', async () => {
        const actions = recordingActions({
            status: 'refused',
            error: { error: 'session_board_revision_conflict' },
        });
        const hook = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS }),
            actions: actions.port,
            confirm: async () => true,
        });
        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });
        await hook.rerender();

        expect(hook.getCurrent().viewRemovalFocusRequest).toBeNull();
        expect(hook.getCurrent().activeViewId).toBe('research');
        expect(hook.getCurrent().lastOutcome).toMatchObject({ kind: 'conflict' });
    });

    it('requests removal focus only after a selected-view approval succeeds', async () => {
        const actions = recordingActions({
            status: 'pending_approval',
            approval: {
                kind: 'approval_request_created',
                artifactId: 'approval-view-remove',
                actionId: 'session.board.layout.update',
            },
        });
        const continuation = { current: null as SessionBoardMutationApprovalRequest | null };
        const hook = await mountController({
            snapshot: readySnapshot({ layout: LAYOUT_TWO_VIEWS }),
            actions: actions.port,
            confirm: async () => true,
            requestApprovalContinuation: (request) => { continuation.current = request; },
        });
        await hook.getCurrent().run({ kind: 'view.select', viewId: 'research' });
        await hook.rerender();

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });
        await hook.rerender();
        expect(hook.getCurrent().viewRemovalFocusRequest).toBeNull();

        await continuation.current?.onSucceeded({
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: { operation: 'update_layout', outcome: 'updated', layoutRevision: 'rev-layout-2' },
            destination: null,
        });
        await hook.rerender();

        expect(hook.getCurrent().viewRemovalFocusRequest).toMatchObject({ removedViewId: 'research' });
    });

    it('requires an explicit destination before removing a non-empty view', async () => {
        const actions = recordingActions();
        const chooseViewRemovalDisposition = vi.fn(async () => ({ kind: 'move', viewId: 'overview' } as const));
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'overview', title: 'Overview', items: [] },
                        { id: 'research', title: 'Research', items: [{ itemId: 'note-1', width: 'medium' }] },
                        { id: 'decisions', title: 'Decisions', items: [] },
                    ],
                } as SessionBoardLayoutV1,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            chooseViewRemovalDisposition,
            confirm: async () => true,
        });

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });

        expect(chooseViewRemovalDisposition).toHaveBeenCalledWith({
            source: { viewId: 'research', title: 'Research' },
            eligibleDestinations: [
                { viewId: 'overview', title: 'Overview' },
                { viewId: 'decisions', title: 'Decisions' },
            ],
        });
        expect(actions.calls).toEqual([{
            kind: 'layout',
            input: {
                sessionId: 'session-1',
                expectedLayoutRevision: 'rev-layout',
                operation: {
                    op: 'tab.remove',
                    tabId: 'research',
                    disposition: { kind: 'move', tabId: 'overview' },
                },
            },
        }]);
    });

    it('allows explicit unpin when removing a non-empty view', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'overview', title: 'Overview', items: [] },
                        { id: 'research', title: 'Research', items: [{ itemId: 'note-1', width: 'medium' }] },
                    ],
                } as SessionBoardLayoutV1,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            chooseViewRemovalDisposition: async () => ({ kind: 'unpin' }),
            confirm: async () => true,
        });

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });

        expect(actions.calls[0]).toMatchObject({
            kind: 'layout',
            input: { operation: { op: 'tab.remove', disposition: { kind: 'unpin' } } },
        });
    });

    it.each([
        ['cancelled', async () => null],
        ['missing', undefined],
        ['invalid destination', async () => ({ kind: 'move', viewId: 'missing' } as const)],
    ])('does not remove a non-empty view when its disposition is %s', async (_case, chooser) => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: {
                    v: 1,
                    tabs: [
                        { id: 'overview', title: 'Overview', items: [] },
                        { id: 'research', title: 'Research', items: [{ itemId: 'note-1', width: 'medium' }] },
                    ],
                } as SessionBoardLayoutV1,
                items: [{ itemId: 'note-1', item: note('Plan', 'body') }],
            }),
            actions: actions.port,
            ...(chooser ? { chooseViewRemovalDisposition: chooser } : {}),
            confirm: async () => true,
        });

        await hook.getCurrent().run({ kind: 'view.remove', viewId: 'research' });

        expect(actions.calls).toEqual([]);
        expect(hook.getCurrent().lastOutcome).toEqual({ kind: 'cancelled' });
        expect(hook.getCurrent().viewRemovalFocusRequest).toBeNull();
    });

    it('surfaces readable items the shared layout does not place', async () => {
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] } as SessionBoardLayoutV1,
                items: [{ itemId: 'orphan-1', item: note('Orphan', 'body') }],
            }),
        });

        expect(hook.getCurrent().recoveredItemIds).toEqual(['orphan-1']);
        expect(hook.getCurrent().supports('item.pin')).toBe(true);
    });

    it('pins a recovered item into a real view through the layout Action', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] } as SessionBoardLayoutV1,
                items: [{ itemId: 'orphan-1', item: note('Orphan', 'body') }],
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.pin', itemId: 'orphan-1' });

        expect(actions.calls).toHaveLength(1);
        const call = actions.calls[0]!;
        expect(call.kind).toBe('layout');
        expect(call.kind === 'layout' ? call.input.operation : null).toMatchObject({
            op: 'item.place',
            itemId: 'orphan-1',
            tabId: 'overview',
        });
    });

    // Removing the last Board view with the unpin disposition leaves a layout
    // with no views and every readable item in Recovered items. The layout
    // `item.place` operation deliberately refuses a view it cannot name, so a
    // pin aimed at the synthetic Overview would be answered
    // `session_board_invalid` and the person could never get their note back.
    it('recreates the Overview view atomically when pinning onto a layout with no views', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: readySnapshot({
                layout: { v: 1, tabs: [] } as SessionBoardLayoutV1,
                items: [{ itemId: 'orphan-1', item: note('Orphan', 'body') }],
            }),
            actions: actions.port,
        });

        expect(hook.getCurrent().recoveredItemIds).toEqual(['orphan-1']);
        await hook.getCurrent().run({ kind: 'item.pin', itemId: 'orphan-1' });

        expect(actions.calls).toHaveLength(1);
        const call = actions.calls[0]!;
        // A layout operation here cannot succeed: it can only name a view the
        // stored layout does not contain.
        expect(call.kind).toBe('upsert');
        if (call.kind !== 'upsert') throw new Error('expected an atomic item+placement mutation');
        expect(call.input.itemId).toBe('orphan-1');
        expect(call.input.expectedItemRevision).toBe('rev-orphan-1');
        // The stored item is replaced by itself: pinning is a placement, never
        // an edit of the person's content.
        expect(call.input.item).toEqual(note('Orphan', 'body'));
        expect(call.input.placement?.tabId).toBe('overview');
        expect(typeof call.input.placement?.tabTitle).toBe('string');
        expect((call.input.placement?.tabTitle ?? '').length).toBeGreaterThan(0);
    });

    it('explains rather than silently dropping a pin of an unreadable recovered item', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            snapshot: projectSessionBoard({
                layout: { revision: 'rev-layout', outcome: { status: 'ready', value: { v: 1, tabs: [] } as SessionBoardLayoutV1 } },
                items: new Map([['locked-1', { revision: 'rev-locked-1', outcome: { status: 'locked' as const } }]]),
                capabilities: { readTranscript: true, editSessionRecords: true },
                freshness: 'fresh',
                reachability: 'reachable',
                loading: 'idle',
                incomplete: false,
            }),
            actions: actions.port,
        });

        await hook.getCurrent().run({ kind: 'item.pin', itemId: 'locked-1' });

        expect(actions.calls).toEqual([]);
        expect(hook.getCurrent().lastOutcome).toEqual({
            kind: 'failed',
            error: 'session_board_item_unreadable',
        });
    });

    it('refuses every command when no Board Action producer is bound', async () => {
        const hook = await mountController({ snapshot: readySnapshot(), actions: null });
        expect(hook.getCurrent().supports('item.remove')).toBe(false);
        expect(hook.getCurrent().supports('view.create')).toBe(false);
        expect(hook.getCurrent().addIntents).toEqual([]);
    });
});
