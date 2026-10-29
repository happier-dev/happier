import { describe, expect, it, vi } from 'vitest';

import {
    createSessionSurfaceNoteDocumentV1,
    readSessionSurfaceNoteTextV1,
    type SessionBoardActionRecoveryEvidenceV1,
    type SessionSurfaceItemV1,
    SessionSurfaceItemV1Schema,
} from '@happier-dev/protocol/sessions/board';

// The canonical declarative document bound; `plugins/ui` does not re-export it,
// and importing it from there silently yields `undefined`, which would size the
// "oversized" fixture at zero characters and pass against any implementation.
import { MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1 } from '@happier-dev/protocol';
import { act, renderHook } from '@/dev/testkit';
import type {
    SessionBoardActionOutcome,
    SessionBoardActionsPort,
    SessionBoardItemUpsertInput,
    SessionBoardMutationResult,
} from '@/sync/domains/session/board';

import { buildSessionBoardNoteItem, useSessionBoardNoteEditor } from './useSessionBoardNoteEditor';
import type { SessionBoardMutationApprovalRequest } from '../sessionBoardMutationApproval';

/**
 * The Note editor's save contract.
 *
 * The failure this file exists to prevent is silent: the person types a last
 * character, presses Save immediately, and the debounced editor surface has not
 * yet published it. Reading the draft before the flush drops that keystroke into
 * a durable record nobody can recover it from.
 */

function upsertResult(itemRevision: string): SessionBoardMutationResult {
    return {
        v: 1,
        serverId: 'home-1',
        sessionId: 'session-1',
        result: {
            operation: 'upsert_item',
            itemId: 'item-1',
            outcome: 'created',
            itemRevision,
            layoutRevision: 'layout-1',
        },
        destination: { tabId: 'overview', width: 'medium' },
    };
}

function createApprovalCapture() {
    let current: SessionBoardMutationApprovalRequest | null = null;
    return {
        request: vi.fn((request: SessionBoardMutationApprovalRequest) => { current = request; }),
        read: (): SessionBoardMutationApprovalRequest | null => current,
    };
}

function recordingActions(): Readonly<{
    port: SessionBoardActionsPort;
    upserts: SessionBoardItemUpsertInput[];
}> {
    const upserts: SessionBoardItemUpsertInput[] = [];
    const ok = (revision: string): SessionBoardActionOutcome<SessionBoardMutationResult> => ({
        status: 'ok',
        value: upsertResult(revision),
    });
    return {
        upserts,
        port: {
            upsertItem: async (input) => {
                upserts.push(input);
                return ok('item-1');
            },
            removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
            updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
        },
    };
}

function noteBodyOf(item: SessionSurfaceItemV1): string | null {
    return item.source.kind === 'declarative'
        ? readSessionSurfaceNoteTextV1(item.source.document)
        : null;
}

/** The note builder returns `null` only for content this file never writes. */
function requireSessionBoardNoteItem(
    input: Parameters<typeof buildSessionBoardNoteItem>[0],
): SessionSurfaceItemV1 {
    const item = buildSessionBoardNoteItem(input);
    if (!item) throw new Error('expected the fixture note to be buildable');
    return item;
}

function createUnknownCreateRecovery(item: SessionSurfaceItemV1): SessionBoardActionRecoveryEvidenceV1 {
    const mutationRequest = {
        operation: 'upsert_item' as const,
        itemId: 'item-1',
        expectedItemRevision: null,
        itemContent: { t: 'plain' as const, v: item },
        placement: {
            expectedLayoutRevision: null,
            layoutContent: {
                t: 'plain' as const,
                v: { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'item-1', width: 'medium' as const }] }] },
            },
        },
    };
    return {
        v: 1,
        actionId: 'session.board.item.upsert',
        serverId: 'home-1',
        sessionId: 'session-1',
        requestBody: JSON.stringify(mutationRequest),
        mutationRequest,
        intent: {
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null, item,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
        },
    };
}

describe('useSessionBoardNoteEditor', () => {
    it('refuses an unconfirmed snapshot before persistence and retries the retained note after confirmation', async () => {
        const actions = recordingActions();
        let confirmed = false;
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            initialTitle: 'Plan', initialBody: 'draft', reachable: true, actions: actions.port,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            flushBody: async () => { if (!confirmed) throw new Error('snapshot_unconfirmed'); return 'final native draft'; },
        }));
        await act(async () => { await expect(hook.getCurrent().save()).resolves.toBe(false); });
        await hook.rerender();
        expect(actions.upserts).toHaveLength(0);
        expect(hook.getCurrent().status.kind).toBe('failed');
        expect(hook.getCurrent().body).toBe('draft');
        expect(hook.getCurrent().canSave).toBe(true);
        confirmed = true;
        await act(async () => { expect(await hook.getCurrent().save()).toBe(true); });
        expect(noteBodyOf(actions.upserts[0]!.item)).toBe('final native draft');
        await hook.unmount();
    });

    it('retains an acknowledged revision when the post-save snapshot is unconfirmed', async () => {
        const actions = recordingActions();
        const onSaved = vi.fn();
        let flushes = 0;
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            initialTitle: 'Plan', initialBody: 'submitted draft', reachable: true, actions: actions.port,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' }, onSaved,
            flushBody: async () => {
                flushes += 1;
                if (flushes === 2) throw new Error('snapshot_unconfirmed');
                return flushes === 1 ? 'submitted draft' : 'newer native draft';
            },
        }));
        await act(async () => { await expect(hook.getCurrent().save()).resolves.toBe(false); });
        await hook.rerender();
        expect(actions.upserts).toHaveLength(1);
        expect(hook.getCurrent().expectedRevision).toBe('item-1');
        expect(hook.getCurrent().status.kind).toBe('failed');
        expect(onSaved).toHaveBeenCalledWith(expect.anything(), 'item-1', false);
        await act(async () => { expect(await hook.getCurrent().save()).toBe(true); });
        expect(actions.upserts[1]?.expectedItemRevision).toBe('item-1');
        expect(noteBodyOf(actions.upserts[1]!.item)).toBe('newer native draft');
        await hook.unmount();
    });

    it('updates an existing note without changing its frame, height, input, or Board placement', async () => {
        const actions = recordingActions();
        const current = SessionSurfaceItemV1Schema.parse({
            v: 1,
            title: 'Old title',
            frame: 'full_bleed',
            height: { mode: 'fixed', size: 'tall' },
            input: { context: 'release' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('old body') },
        });
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: 'item-rev-1',
            initialTitle: current.title,
            initialBody: 'old body',
            baseItem: current,
            reachable: true,
            actions: actions.port,
        }));

        hook.getCurrent().setTitle('New title');
        hook.getCurrent().setBody('new body');
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(true);

        expect(actions.upserts).toHaveLength(1);
        expect(actions.upserts[0]).not.toHaveProperty('placement');
        expect(actions.upserts[0]?.item).toMatchObject({
            title: 'New title',
            frame: 'full_bleed',
            height: { mode: 'fixed', size: 'tall' },
            input: { context: 'release' },
        });
        expect(noteBodyOf(actions.upserts[0]!.item)).toBe('new body');
    });

    // The canonical declarative document bound refuses an oversized note. The
    // editor must say so and keep the draft, not sit in `saving` forever.
    it('refuses an oversized note before persistence and keeps the exact draft editable', async () => {
        const actions = recordingActions();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            initialTitle: 'Plan', initialBody: '', reachable: true, actions: actions.port,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
        }));
        const oversizedBody = 'x'.repeat(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1 + 1);
        hook.getCurrent().setBody(oversizedBody);
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(actions.upserts).toHaveLength(0);
        expect(hook.getCurrent().status).toEqual({ kind: 'invalid', error: 'session_board_note_too_large' });
        expect(hook.getCurrent().canSave).toBe(true);
        expect(hook.getCurrent().body).toBe(oversizedBody);
    });

    it('keeps the flushed value as the clean baseline so a saved note is not left dirty', async () => {
        const actions = recordingActions();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true,
            actions: actions.port,
            flushBody: async () => 'final text',
        }));

        hook.getCurrent().setBody('final tex');
        await hook.rerender();
        await hook.getCurrent().save();
        await hook.rerender();

        expect(hook.getCurrent().body).toBe('final text');
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('cannot review a null or unchanged conflict revision before the canonical refresh settles', async () => {
        const upserts: SessionBoardItemUpsertInput[] = [];
        const port = {
            upsertItem: async (input: SessionBoardItemUpsertInput) => {
                upserts.push(input);
                return {
                    status: 'refused' as const,
                    error: { error: 'session_board_revision_conflict' as const, currentItemRevision: 'rev-2' },
                };
            },
            removeItem: recordingActions().port.removeItem,
            updateLayout: recordingActions().port.updateLayout,
        } satisfies SessionBoardActionsPort;
        let latestRevision: string | null = 'rev-1';
        let latestBody: string | null = 'base';
        const requestRecoveryRefresh = vi.fn();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: 'rev-1',
            initialTitle: 'Plan', initialBody: 'base', reachable: true, actions: port,
            latestRevision, latestBody, requestRecoveryRefresh,
        }));
        hook.getCurrent().setBody('mine');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();

        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        expect(hook.getCurrent().expectedRevision).toBe('rev-1');
        expect(hook.getCurrent().canSave).toBe(false);

        latestRevision = null;
        latestBody = null;
        await hook.rerender();
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });

        latestRevision = 'rev-2';
        latestBody = 'theirs';
        await hook.rerender();
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: true });
        expect(hook.getCurrent().expectedRevision).toBe('rev-2');
        expect(hook.getCurrent().canSave).toBe(true);
        expect(upserts).toHaveLength(1);
    });

    it('keeps text typed while a deferred approval was outstanding', async () => {
        const upsertItem: SessionBoardActionsPort['upsertItem'] = vi.fn(async () => ({
            status: 'pending_approval' as const,
            approval: {
                kind: 'approval_request_created' as const,
                artifactId: 'approval-1',
                actionId: 'session.board.item.upsert',
            },
        }));
        const continuation = createApprovalCapture();
        const onSaved = vi.fn();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            initialTitle: 'Plan', initialBody: 'A', reachable: true,
            actions: { ...recordingActions().port, upsertItem },
            onSaved,
            requestApprovalContinuation: continuation.request,
        }));
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        hook.getCurrent().setBody('A then B');
        await hook.rerender();
        await continuation.read()?.onSucceeded(upsertResult('rev-approved'));
        await hook.rerender();

        expect(hook.getCurrent().body).toBe('A then B');
        expect(onSaved).toHaveBeenCalledWith(expect.any(Object), 'rev-approved', false);
    });

    it('applies the reviewed record as the base so a concurrent change to untouched fields survives', async () => {
        const upserts: SessionBoardItemUpsertInput[] = [];
        const port = {
            upsertItem: async (input: SessionBoardItemUpsertInput) => {
                upserts.push(input);
                return upserts.length === 1
                    ? {
                        status: 'refused' as const,
                        error: { error: 'session_board_revision_conflict' as const, currentItemRevision: 'rev-2' },
                    }
                    : { status: 'ok' as const, value: upsertResult('rev-3') };
            },
            removeItem: recordingActions().port.removeItem,
            updateLayout: recordingActions().port.updateLayout,
        } satisfies SessionBoardActionsPort;
        const openedItem = SessionSurfaceItemV1Schema.parse({
            v: 1, title: 'Plan', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('base') },
        });
        // Another client changed only the height; the reviewer never saw or edited it.
        const theirItem = SessionSurfaceItemV1Schema.parse({
            ...openedItem,
            height: { mode: 'fixed', size: 'tall' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('theirs') },
        });
        let latestRevision: string | null = 'rev-1';
        let latestBody: string | null = 'base';
        let observation: NonNullable<Parameters<typeof useSessionBoardNoteEditor>[0]['recoveryObservation']> = {
            state: 'settled', revision: 'rev-1', item: openedItem,
        };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: 'rev-1',
            initialTitle: 'Plan', initialBody: 'base', reachable: true, actions: port,
            baseItem: openedItem, latestRevision, latestBody,
            recoveryObservation: observation, requestRecoveryRefresh: vi.fn(),
        }));
        hook.getCurrent().setBody('mine');
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();

        latestRevision = 'rev-2';
        latestBody = 'theirs';
        observation = { state: 'settled', revision: 'rev-2', item: theirItem };
        await hook.rerender();
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().expectedRevision).toBe('rev-2');
        expect(await hook.getCurrent().save()).toBe(true);

        expect(upserts).toHaveLength(2);
        expect(upserts[1]?.item.height).toEqual({ mode: 'fixed', size: 'tall' });
        expect(noteBodyOf(upserts[1]!.item)).toBe('mine');
    });

    it('settles the exact pending approval without replaying the mutation and restores the retained draft on denial', async () => {
        const submitted: SessionBoardItemUpsertInput[] = [];
        const upsertItem: SessionBoardActionsPort['upsertItem'] = vi.fn(async (
            input: SessionBoardItemUpsertInput,
        ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
            submitted.push(input);
            return {
                status: 'pending_approval',
                approval: {
                    kind: 'approval_request_created',
                    artifactId: 'approval-1',
                    actionId: 'session.board.item.upsert',
                },
            };
        });
        const continuation = createApprovalCapture();
        const onSaved = vi.fn();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            initialTitle: '', initialBody: '', reachable: true,
            actions: { ...recordingActions().port, upsertItem },
            onSaved,
            requestApprovalContinuation: continuation.request,
        }));
        hook.getCurrent().setTitle('Plan');
        hook.getCurrent().setBody('retained draft');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(continuation.request).toHaveBeenCalledOnce();
        expect(continuation.read()?.expectedInput).toEqual(submitted[0]);
        expect(await hook.getCurrent().save()).toBe(false);
        expect(upsertItem).toHaveBeenCalledOnce();

        continuation.read()?.onFailed('approval_rejected');
        await hook.rerender();
        expect(hook.getCurrent().body).toBe('retained draft');
        expect(hook.getCurrent().canSave).toBe(true);

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        await continuation.read()?.onSucceeded(upsertResult('rev-approved'));
        await hook.rerender();
        expect(onSaved).toHaveBeenCalledWith(expect.any(Object), 'rev-approved', true);
        expect(upsertItem).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().expectedRevision).toBe('rev-approved');
    });

    it('reconciles an approval execution acknowledgement loss against the exact submitted note before allowing another Save', async () => {
        const submitted: SessionBoardItemUpsertInput[] = [];
        const upsertItem: SessionBoardActionsPort['upsertItem'] = vi.fn(async (
            value: SessionBoardItemUpsertInput,
        ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
            submitted.push(value);
            return {
                status: 'pending_approval',
                approval: {
                    kind: 'approval_request_created',
                    artifactId: 'approval-unknown-note',
                    actionId: 'session.board.item.upsert',
                },
            };
        });
        const continuation = createApprovalCapture();
        const requestRecoveryRefresh = vi.fn();
        const onSaved = vi.fn();
        let observation: NonNullable<Parameters<typeof useSessionBoardNoteEditor>[0]['recoveryObservation']> = {
            state: 'settled',
            revision: null,
            item: null,
        };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            initialTitle: '', initialBody: '', reachable: true,
            actions: { ...recordingActions().port, upsertItem },
            requestApprovalContinuation: continuation.request,
            requestRecoveryRefresh,
            recoveryObservation: observation,
            onSaved,
        }));
        hook.getCurrent().setTitle('Release');
        hook.getCurrent().setBody('exact approved draft');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        continuation.read()?.onFailed('approval_execution_outcome_unknown');
        await hook.rerender();

        expect(hook.getCurrent().status.kind).toBe('outcomeUnknown');
        expect(hook.getCurrent().canSave).toBe(false);
        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();
        expect(await hook.getCurrent().save()).toBe(false);
        expect(upsertItem).toHaveBeenCalledOnce();

        observation = { state: 'refreshing', revision: null, item: null };
        await hook.rerender();
        observation = {
            state: 'settled',
            revision: 'note-rev-approved',
            item: submitted[0]!.item,
        };
        await hook.rerender();

        expect(onSaved).toHaveBeenCalledWith(null, 'note-rev-approved', true);
        expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
        expect(hook.getCurrent().expectedRevision).toBe('note-rev-approved');
        expect(hook.getCurrent().dirty).toBe(false);
        expect(upsertItem).toHaveBeenCalledOnce();
    });

    it('does not submit while another exact Board approval is unresolved', async () => {
        const actions = recordingActions();
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: 'rev-1',
            initialBody: 'base', reachable: true, approvalPending: true, actions: actions.port,
        }));
        hook.getCurrent().setBody('retained');
        await hook.rerender();

        expect(hook.getCurrent().canSave).toBe(false);
        expect(await hook.getCurrent().save()).toBe(false);
        expect(actions.upserts).toEqual([]);
        expect(hook.getCurrent().body).toBe('retained');
    });

    it('reports an unavailable Board mutation instead of pretending the note was saved', async () => {
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true,
            actions: {
                upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
                removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
                updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
            },
        }));

        hook.getCurrent().setBody('draft that must survive');
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();

        expect(hook.getCurrent().status).toEqual({ kind: 'unavailable', reason: 'board_actions_unavailable' });
        expect(hook.getCurrent().body).toBe('draft that must survive');
    });

    it.each([
        ['committed', 'item-2', 'Shipping', 'final text', 'saved'],
        ['not committed', null, '', '', 'retryable'],
        ['conflict', 'item-2', 'Someone else', 'remote text', 'conflict'],
    ] as const)('reconciles an unknown create after a canonical refresh when it is %s', async (_name, latestRevision, latestTitle, latestBody, expected) => {
        const submittedItem = requireSessionBoardNoteItem({ title: 'Shipping', body: 'final text' });
        const recovery = createUnknownCreateRecovery(submittedItem);
        const onSaved = vi.fn();
        const requestRecoveryRefresh = vi.fn();
        let observation: NonNullable<Parameters<typeof useSessionBoardNoteEditor>[0]['recoveryObservation']> = {
            state: 'settled',
            revision: null,
            item: null,
        };
        const actions: SessionBoardActionsPort = {
            upsertItem: async () => ({ status: 'outcome_unknown', recovery }),
            removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
            updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
        };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            initialTitle: '',
            initialBody: '',
            reachable: true,
            actions,
            recoveryObservation: observation,
            requestRecoveryRefresh,
            onSaved,
        }));
        hook.getCurrent().setTitle('Shipping');
        hook.getCurrent().setBody('final text');
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(hook.getCurrent().status.kind).toBe('outcomeUnknown');
        expect(requestRecoveryRefresh).toHaveBeenCalledTimes(1);

        observation = { state: 'refreshing', revision: null, item: null };
        await hook.rerender();
        observation = {
            state: 'settled',
            revision: latestRevision,
            item: latestRevision === null ? null : buildSessionBoardNoteItem({ title: latestTitle, body: latestBody }),
        };
        await hook.rerender();

        if (expected === 'saved') {
            expect(onSaved).toHaveBeenCalledWith(null, 'item-2', true);
            expect(hook.getCurrent().dirty).toBe(false);
            expect(hook.getCurrent().expectedRevision).toBe('item-2');
        } else if (expected === 'retryable') {
            expect(onSaved).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
            expect(hook.getCurrent().canSave).toBe(true);
            expect(hook.getCurrent().body).toBe('final text');
        } else {
            expect(onSaved).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
            expect(hook.getCurrent().body).toBe('final text');
        }
    });

    it('does not mistake the unchanged pre-request record for proof that an unknown update committed', async () => {
        const existing = requireSessionBoardNoteItem({ title: 'Shipping', body: 'same text' });
        const onSaved = vi.fn();
        let observation: NonNullable<Parameters<typeof useSessionBoardNoteEditor>[0]['recoveryObservation']> = {
            state: 'settled',
            revision: 'item-1',
            item: existing,
        };
        const port: SessionBoardActionsPort = {
            upsertItem: async () => ({ status: 'outcome_unknown', recovery: createUnknownCreateRecovery(existing) }),
            removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
            updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
        };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: 'item-1',
            initialTitle: 'Shipping',
            initialBody: 'same text',
            baseItem: existing,
            reachable: true,
            actions: port,
            recoveryObservation: observation,
            requestRecoveryRefresh: vi.fn(),
            onSaved,
        }));

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(hook.getCurrent().status.kind).toBe('outcomeUnknown');
        expect(onSaved).not.toHaveBeenCalled();

        observation = { state: 'refreshing', revision: 'item-1', item: existing };
        await hook.rerender();
        observation = { state: 'settled', revision: 'item-1', item: existing };
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
        expect(hook.getCurrent().expectedRevision).toBe('item-1');
        expect(onSaved).not.toHaveBeenCalled();
    });

    it.each([
        ['offline', false, { kind: 'editing' } as const],
        ['unreviewed conflict', true, { kind: 'conflict', reviewed: false } as const],
        ['unknown outcome', true, { kind: 'outcomeUnknown' } as const],
    ])('does not dispatch another write when Save is re-entered while %s', async (_name, reachable, terminal) => {
        const submittedItem = requireSessionBoardNoteItem({ title: 'Shipping', body: 'final text' });
        const recovery = createUnknownCreateRecovery(submittedItem);
        const upserts: SessionBoardItemUpsertInput[] = [];
        const port: SessionBoardActionsPort = {
            upsertItem: async (value) => {
                upserts.push(value);
                if (terminal.kind === 'conflict') {
                    return { status: 'refused', error: { error: 'session_board_revision_conflict' } } as const;
                }
                return { status: 'outcome_unknown', recovery } as const;
            },
            removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
            updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } }),
        };
        const hook = await renderHook(() => useSessionBoardNoteEditor({
            sessionId: 'session-1', itemId: 'item-1', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable, actions: port,
        }));
        hook.getCurrent().setTitle('Shipping');
        hook.getCurrent().setBody('final text');
        await hook.rerender();

        if (reachable) {
            expect(await hook.getCurrent().save()).toBe(false);
            await hook.rerender();
        }
        expect(await hook.getCurrent().save()).toBe(false);
        expect(upserts).toHaveLength(reachable ? 1 : 0);
    });
});
