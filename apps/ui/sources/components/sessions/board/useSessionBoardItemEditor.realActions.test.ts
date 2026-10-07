import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { projectSessionBoard } from '@/sync/domains/session/board';
import { runUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

import { useSessionBoardNoteEditor, type SessionBoardNoteEditor } from './note/useSessionBoardNoteEditor';
import { SessionBoardContinuityProvider } from './SessionBoardContinuity';
import { useSessionBoardController, type SessionBoardController } from './useSessionBoardController';
import type { SessionBoardItemRecoveryObservation } from './useSessionBoardItemEditor';
import type { SessionBoardMutationApprovalRequest } from './sessionBoardMutationApproval';
import { realBoardActions } from './sessionBoardActionsTestkit';

/**
 * The shared Board editor composed with the real Board Action adapter, Action
 * executor and Actions port. Only the Home HTTP transport is a boundary.
 */
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const session = { serverId: 'home-a', sessionId: 'session-one' };

function createdAck(itemId: string): Response {
    return new Response(JSON.stringify({
        operation: 'upsert_item', itemId, outcome: 'created', itemRevision: revision, layoutRevision: revision,
    }));
}

describe('shared Board item editor through the real Board Actions', () => {
    afterEach(() => standardCleanup());

    it.each(['unknown', 'layout-conflict'] as const)('recovers %s after canonical refresh completes with the editor hidden', async (mode) => {
        let settle: ((response: Response) => void) | undefined;
        let editor!: SessionBoardNoteEditor;
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })));
        function Editor(props: Readonly<{
            observation: SessionBoardItemRecoveryObservation;
            refresh: () => void;
        }>) {
            editor = useSessionBoardNoteEditor({
                sessionId: session.sessionId, itemId: 'hidden-note', expectedItemRevision: null,
                placement: { tabId: 'overview', tabTitle: 'Overview' },
                initialTitle: 'Draft', initialBody: 'Keep this draft', reachable: true, actions,
                latestRevision: null, latestBody: null,
                recoveryObservation: props.observation, requestRecoveryRefresh: props.refresh,
            });
            return null;
        }
        function Host(props: Readonly<{ visible: boolean }>) {
            // The Session's repository projection remains alive while Details has
            // another active tab and its retained Board no longer owns an editor.
            const [observation, setObservation] = React.useState<SessionBoardItemRecoveryObservation>({
                state: 'settled', revision: null, item: null,
            });
            const refresh = React.useCallback(() => {
                setObservation({ state: 'refreshing', revision: null, item: null });
                void Promise.resolve().then(() => {
                    setObservation({ state: 'settled', revision: null, item: null });
                });
            }, []);
            return props.visible ? React.createElement(Editor, { observation, refresh }) : null;
        }
        const render = (visible: boolean) => React.createElement(SessionBoardContinuityProvider, session,
            React.createElement(Host, { visible }));
        const screen = await renderScreen(render(true));
        let saving!: Promise<boolean>;
        act(() => { saving = editor.save(); });
        for (let attempt = 0; attempt < 20 && !settle; attempt += 1) {
            await act(async () => { screen.tree.update(render(true)); });
        }
        expect(settle).toBeTypeOf('function');
        await act(async () => { screen.tree.update(render(false)); });
        await act(async () => {
            settle!(mode === 'unknown' ? new Response('acknowledgement lost') : new Response(JSON.stringify({
                error: 'session_board_revision_conflict', currentItemRevision: null, currentLayoutRevision: revision,
            }), { status: 409 }));
            expect(await saving).toBe(false);
        });
        await act(async () => { screen.tree.update(render(true)); });
        expect(editor.body).toBe('Keep this draft');
        if (mode === 'layout-conflict') {
            expect(editor.canReviewLatest).toBe(true);
            await act(async () => { editor.reviewLatest(); });
        }
        expect(editor.canSave).toBe(true);
    });

    it.each([false, true])('retires pending result custody on owner unmount (Session continuity: %s)', async (withContinuity) => {
        let settle: ((response: Response) => void) | undefined;
        let saved = false;
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })));
        const wrapper = ({ children }: React.PropsWithChildren) =>
            React.createElement(SessionBoardContinuityProvider, session, children);
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'retiring-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: 'A', reachable: true, actions,
            onSaved: () => { saved = true; },
        }), withContinuity ? { wrapper } : undefined);
        let saving!: Promise<boolean>;
        act(() => { saving = hook.getCurrent().save(); });
        for (let attempt = 0; attempt < 20 && !settle; attempt += 1) await hook.rerender();
        expect(settle).toBeTypeOf('function');
        await hook.unmount();
        settle!(createdAck('retiring-note'));
        expect(await saving).toBe(false);
        expect(saved).toBe(false);
    });

    it('does not carry a pending editor across a reused Session provider address', async () => {
        let settle: ((response: Response) => void) | undefined;
        let saved = false;
        let editor!: SessionBoardNoteEditor;
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })));
        function Editor(props: Readonly<{ sessionId: string }>) {
            editor = useSessionBoardNoteEditor({
                sessionId: props.sessionId, itemId: 'shared-item-id', expectedItemRevision: null,
                placement: { tabId: 'overview', tabTitle: 'Overview' },
                initialTitle: 'Draft', initialBody: props.sessionId, reachable: true, actions,
                onSaved: () => { saved = true; },
            });
            return null;
        }
        const render = (sessionId: string) => React.createElement(SessionBoardContinuityProvider,
            { serverId: session.serverId, sessionId }, React.createElement(Editor, { sessionId }));
        const screen = await renderScreen(render(session.sessionId));
        let saving!: Promise<boolean>;
        act(() => { saving = editor.save(); });
        for (let attempt = 0; attempt < 20 && !settle; attempt += 1) {
            await act(async () => { screen.tree.update(render(session.sessionId)); });
        }
        expect(settle).toBeTypeOf('function');
        await act(async () => { screen.tree.update(render('session-two')); });
        expect(editor.body).toBe('session-two');
        expect(editor.status.kind).toBe('editing');
        settle!(createdAck('shared-item-id'));
        expect(await saving).toBe(false);
        expect(saved).toBe(false);
    });

    it.each([null, 'ssr1.AAAACHN5c3JlY18yAAAAAg'])('retains typed approval conflict evidence for current item revision %s', async (currentItemRevision) => {
        // The only substituted execution boundary is durable Artifact creation.
        const actions = realBoardActions(async () => new Response(JSON.stringify({ record: null })),
            async () => ({ artifactId: 'approval-one' }));
        let continuation: SessionBoardMutationApprovalRequest | undefined;
        let observation: SessionBoardItemRecoveryObservation = { state: 'settled', revision: null, item: null };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'new-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: 'Keep me', reachable: true, actions,
            recoveryObservation: observation, latestRevision: null, latestBody: null,
            requestApprovalContinuation: (request) => { continuation = request; },
        }));
        await act(async () => { expect(await hook.getCurrent().save()).toBe(false); });
        await hook.rerender();
        expect(hook.getCurrent().status.kind).toBe('approvalPending');
        expect(continuation).toBeDefined();
        // The canonical approval host delivers the already-executed typed terminal.
        act(() => {
            continuation!.onFailed('session_board_revision_conflict', {
                ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict',
                details: { currentItemRevision, currentLayoutRevision: revision },
            });
        });
        await hook.rerender();
        observation = { ...observation, state: 'refreshing' };
        await hook.rerender();
        observation = { ...observation, state: 'settled' };
        await hook.rerender();
        expect(hook.getCurrent().canReviewLatest).toBe(currentItemRevision === null);
        act(() => { hook.getCurrent().reviewLatest(); });
        await hook.rerender();
        expect(hook.getCurrent().canSave).toBe(currentItemRevision === null);
        expect(hook.getCurrent().expectedRevision).toBeNull();
        expect(hook.getCurrent().body).toBe('Keep me');
    });

    it('flushes newer embedded-editor text before settling Save-and-leave', async () => {
        let settle: ((response: Response) => void) | undefined;
        let surfaceText = 'Save A';
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })));
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'new-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: '', reachable: true, actions,
            // This is the embedded editor's imperative boundary: B has not yet
            // crossed its debounced onChange when the network acknowledges A.
            flushBody: async () => surfaceText,
        }));
        act(() => { hook.getCurrent().setBody(surfaceText); });
        await hook.rerender();
        let navigated = false;
        let leaving!: ReturnType<typeof runUnsavedChangesGuard>;
        act(() => {
            leaving = runUnsavedChangesGuard({
                isDirtyRef: hook.getCurrent().dirtyRef,
                requestDecision: async () => 'save',
                onSave: () => hook.getCurrent().save(),
                tag: 'SessionBoardItemEditor.realActions',
            }, () => { navigated = true; });
        });
        for (let attempt = 0; attempt < 20 && !settle; attempt += 1) await hook.rerender();
        expect(settle).toBeTypeOf('function');
        surfaceText = 'Save A plus pending B';
        await act(async () => {
            settle!(createdAck('new-note'));
            expect(await leaving).toBe(false);
        });
        await hook.rerender();
        expect(navigated).toBe(false);
        expect(hook.getCurrent().body).toBe(surfaceText);
        expect(hook.getCurrent().dirty).toBe(true);
        expect(hook.getCurrent().expectedRevision).toBe(revision);
    });

    it.each(['direct', 'approval', 'unknown'] as const)('retains pending %s save custody and the committed CAS through editor rehosts', async (mode) => {
        let settle: ((response: Response) => void) | undefined;
        let continuation: SessionBoardMutationApprovalRequest | undefined;
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })),
        mode === 'approval' ? async () => ({ artifactId: 'approval-one' }) : undefined);
        const snapshot = projectSessionBoard({
            layout: undefined, items: new Map(),
            capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
        });
        let controller!: SessionBoardController;
        let editor!: SessionBoardNoteEditor;
        const surfaceText = { details: 'Save A', expanded: 'Save A', mobile: 'Save A plus pending B in expanded' };
        let observation: SessionBoardItemRecoveryObservation = { state: 'settled', revision: null, item: null };
        function Editor(props: Readonly<{ placement: keyof typeof surfaceText }>) {
            const draft = controller.noteDraft!;
            editor = useSessionBoardNoteEditor({
                sessionId: session.sessionId, ...draft, reachable: true, actions,
                flushBody: async () => surfaceText[props.placement],
                onSaved: controller.onNoteSaved,
                requestApprovalContinuation: (request) => { continuation = request; },
                recoveryObservation: observation,
            });
            return null;
        }
        function Host(props: Readonly<{ placement: keyof typeof surfaceText }>) {
            controller = useSessionBoardController({
                ...session, actions,
                binding: { status: 'ready', snapshot, refresh: () => {} },
            });
            return controller.noteDraft ? React.createElement(Editor, { key: props.placement, placement: props.placement }) : null;
        }
        const render = (placement: keyof typeof surfaceText) => React.createElement(SessionBoardContinuityProvider, session,
            React.createElement(Host, { placement }));
        const screen = await renderScreen(render('details'));
        await act(async () => { await controller.run({ kind: 'add', intent: 'note' }); });
        act(() => { editor.setBody(surfaceText.details); });
        let saving!: Promise<boolean>;
        act(() => { saving = editor.save(); });
        for (let attempt = 0; attempt < 20 && !(settle || continuation); attempt += 1) {
            await act(async () => { screen.tree.update(render('details')); });
        }
        expect(Boolean(settle || continuation)).toBe(true);
        const itemId = controller.noteDraft!.itemId;
        if (mode === 'unknown') {
            await act(async () => {
                settle!(new Response('acknowledgement lost'));
                expect(await saving).toBe(false);
            });
        }
        await act(async () => { await editor.flushToContinuity(); });
        await act(async () => { screen.tree.update(render('expanded')); });
        expect(editor.status.kind).toBe(mode === 'approval' ? 'approvalPending' : mode === 'unknown' ? 'outcomeUnknown' : 'saving');
        expect(editor.canSave).toBe(false);
        surfaceText.expanded = 'Save A plus pending B in expanded';
        await act(async () => {
            if (mode === 'approval') {
                if (continuation?.actionId !== 'session.board.item.upsert') throw new Error('missing upsert continuation');
                const committedActions = realBoardActions(async (_path, init) => init?.method === 'PUT'
                    ? createdAck(itemId) : new Response(JSON.stringify({ record: null })));
                const committed = await committedActions.upsertItem(continuation.expectedInput);
                if (committed.status !== 'ok') throw new Error('approval execution did not commit');
                await continuation.onSucceeded(committed.value);
            } else if (mode === 'unknown') {
                if (editor.status.kind !== 'outcomeUnknown') throw new Error('missing unknown intent');
                observation = { state: 'settled', revision, item: editor.status.intent.item };
                screen.tree.update(render('expanded'));
            } else settle!(createdAck(itemId));
            expect(await saving).toBe(false);
        });
        expect(controller.noteDraft?.itemId).toBe(itemId);
        expect(editor.body).toBe(surfaceText.expanded);
        expect(editor.dirty).toBe(true);
        expect(editor.expectedRevision).toBe(revision);
        await act(async () => { screen.tree.update(render('mobile')); });
        expect(editor.expectedRevision).toBe(revision);
        expect(editor.body).toBe(surfaceText.mobile);
        expect(editor.dirty).toBe(true);
    });

    it('does not complete Save-and-leave while text typed during the pending save remains unsaved', async () => {
        let settle: ((response: Response) => void) | undefined;
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? await new Promise<Response>((resolve) => { settle = resolve; })
            : new Response(JSON.stringify({ record: null })));
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'new-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: '', reachable: true, actions,
        }));
        hook.getCurrent().setBody('Save A');
        await hook.rerender();
        let navigated = false;
        const leaving = runUnsavedChangesGuard({
            isDirtyRef: hook.getCurrent().dirtyRef,
            requestDecision: async () => 'save',
            onSave: () => hook.getCurrent().save(),
            tag: 'SessionBoardItemEditor.realActions',
        }, () => { navigated = true; });
        for (let attempt = 0; attempt < 20 && !settle; attempt += 1) await hook.rerender();
        expect(settle).toBeTypeOf('function');
        // The person keeps typing while the PUT is outstanding.
        hook.getCurrent().setBody('Save A plus newer B');
        await hook.rerender();
        settle!(createdAck('new-note'));
        expect(await leaving).toBe(false);
        await hook.rerender();

        expect(navigated).toBe(false);
        expect(hook.getCurrent().body).toBe('Save A plus newer B');
        expect(hook.getCurrent().dirty).toBe(true);
        expect(hook.getCurrent().dirtyRef.current).toBe(true);
        expect(hook.getCurrent().expectedRevision).toBe(revision);
    });

    it('leaves after Save-and-leave when the committed draft is the current draft', async () => {
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? createdAck('settled-note')
            : new Response(JSON.stringify({ record: null })));
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'settled-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: '', reachable: true, actions,
        }));
        hook.getCurrent().setBody('Only A');
        await hook.rerender();
        let navigated = false;
        await expect(runUnsavedChangesGuard({
            isDirtyRef: hook.getCurrent().dirtyRef,
            requestDecision: async () => 'save',
            onSave: () => hook.getCurrent().save(),
            tag: 'SessionBoardItemEditor.realActions',
        }, () => { navigated = true; })).resolves.toBe(true);
        expect(navigated).toBe(true);
    });

    it('offers a deliberate retry of the same new item after a create loses only the layout CAS', async () => {
        const puts: unknown[] = [];
        let layoutConflict = true;
        const actions = realBoardActions(async (_path, init) => {
            if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: null }));
            puts.push(JSON.parse(String(init.body)));
            return layoutConflict
                ? new Response(JSON.stringify({
                    error: 'session_board_revision_conflict', currentItemRevision: null, currentLayoutRevision: revision,
                }), { status: 409 })
                : createdAck('new-note');
        });
        let observation: SessionBoardItemRecoveryObservation = { state: 'settled', revision: null, item: null };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'new-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: 'Retain me', reachable: true,
            latestRevision: null, latestBody: null, actions, recoveryObservation: observation,
        }));
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        // Before the canonical refresh has run, nothing may be retried.
        expect(hook.getCurrent().canReviewLatest).toBe(false);
        expect(hook.getCurrent().canSave).toBe(false);
        // The complete repository refresh: the new item is still absent, the layout moved.
        observation = { ...observation, state: 'refreshing' };
        await hook.rerender();
        observation = { ...observation, state: 'settled' };
        await hook.rerender();
        expect(hook.getCurrent().canReviewLatest).toBe(true);
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: true });
        // The item operand is unchanged: the same stable id is still being created.
        expect(hook.getCurrent().expectedRevision).toBeNull();
        expect(hook.getCurrent().canSave).toBe(true);

        layoutConflict = false;
        expect(await hook.getCurrent().save()).toBe(true);
        await hook.rerender();
        expect(puts).toHaveLength(2);
        expect(puts[1]).toMatchObject({ expectedItemRevision: null });
        expect(hook.getCurrent().body).toBe('Retain me');
        expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
    });

    it('keeps an item-changing conflict unreviewable until the changed record is readable', async () => {
        const actions = realBoardActions(async (_path, init) => init?.method === 'PUT'
            ? new Response(JSON.stringify({
                error: 'session_board_revision_conflict', currentItemRevision: 'ssr1.AAAACHN5c3JlY18yAAAAAg', currentLayoutRevision: revision,
            }), { status: 409 })
            : new Response(JSON.stringify({ record: null })));
        let observation: SessionBoardItemRecoveryObservation = { state: 'settled', revision: null, item: null };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: session.sessionId, itemId: 'contested-note', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview' },
            initialTitle: 'Draft', initialBody: 'Mine', reachable: true,
            latestRevision: null, latestBody: null, actions, recoveryObservation: observation,
        }));
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        observation = { ...observation, state: 'refreshing' };
        await hook.rerender();
        observation = { ...observation, state: 'settled' };
        await hook.rerender();
        // Someone else created this exact item: its record must be reviewed, never overwritten blind.
        expect(hook.getCurrent().canReviewLatest).toBe(false);
        expect(hook.getCurrent().canSave).toBe(false);
    });
});
