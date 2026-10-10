import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it, vi } from 'vitest';

import type {
    SessionBoardActionRecoveryEvidenceV1,
    SessionBoardApprovalRequestCreatedResultV1,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';
import { SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board/item';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type {
    SessionBoardActionsPort,
    SessionBoardItemUpsertInput,
    SessionBoardMutationResult,
} from '@/sync/domains/session/board';

import {
    buildSessionBoardHostedHtmlItem,
    useSessionBoardHostedHtmlEditor,
} from './useSessionBoardHostedHtmlEditor';
import type { SessionBoardMutationApprovalRequest } from '../sessionBoardMutationApproval';

function upsertResult(input: Readonly<{
    itemId: string;
    itemRevision: string;
    outcome?: 'created' | 'updated' | 'unchanged';
    layoutRevision?: string;
    destination?: SessionBoardMutationResult['destination'];
}>): SessionBoardMutationResult {
    return {
        v: 1,
        serverId: 'home-1',
        sessionId: 'session-1',
        result: {
            operation: 'upsert_item',
            itemId: input.itemId,
            outcome: input.outcome ?? 'updated',
            itemRevision: input.itemRevision,
            ...(input.layoutRevision ? { layoutRevision: input.layoutRevision } : {}),
        },
        destination: input.destination ?? null,
    };
}

function upsertApproval(artifactId: string): SessionBoardApprovalRequestCreatedResultV1 {
    return {
        kind: 'approval_request_created',
        artifactId,
        actionId: 'session.board.item.upsert',
    };
}

function createApprovalCapture() {
    let current: SessionBoardMutationApprovalRequest | null = null;
    return {
        request: vi.fn((request: SessionBoardMutationApprovalRequest) => { current = request; }),
        read: (): SessionBoardMutationApprovalRequest | null => current,
    };
}

function actions(outcome: Awaited<ReturnType<SessionBoardActionsPort['upsertItem']>>) {
    const upserts: SessionBoardItemUpsertInput[] = [];
    return {
        upserts,
        port: {
            upsertItem: async (input: SessionBoardItemUpsertInput) => { upserts.push(input); return outcome; },
            removeItem: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } } as const),
            updateLayout: async () => ({ status: 'refused', error: { error: 'session_board_invalid' } } as const),
        } satisfies SessionBoardActionsPort,
    };
}

describe('useSessionBoardHostedHtmlEditor', () => {
    it('flushes the shared code editor before one atomic item and placement write', async () => {
        const stored = actions({
            status: 'ok',
            value: upsertResult({
                itemId: 'interactive-1',
                itemRevision: 'rev-1',
                outcome: 'created',
                layoutRevision: 'layout-1',
                destination: { tabId: 'overview', width: 'medium' },
            }),
        });
        const onSaved = vi.fn();
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved,
            flushHtml: async () => '<main>final!</main>',
        }));
        hook.getCurrent().setTitle('Dashboard');
        hook.getCurrent().setHtml('<main>final</main>');
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(true);
        expect(stored.upserts[0]).toMatchObject({
            expectedItemRevision: null,
            placement: { tabId: 'overview' },
            item: { source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>final!</main>') } },
        });
        // The third operand is the settlement fact: nothing newer was typed while the save ran.
        expect(onSaved).toHaveBeenCalledWith(expect.any(Object), 'rev-1', true);
    });

    it('edits the existing hosted HTML record with its exact revision and preserves presentation fields', async () => {
        const stored = actions({
            status: 'ok',
            value: upsertResult({ itemId: 'interactive-1', itemRevision: 'rev-3' }),
        });
        const baseItem = SessionSurfaceItemV1Schema.parse({
            v: 1,
            title: 'Existing',
            frame: 'full_bleed',
            height: { mode: 'fixed', size: 'tall' },
            source: {
                kind: 'hostedHtml',
                source: artifactHtmlBundleFromBodyV1('<main>before</main>'),
                requestedCapabilities: { hostMethods: ['notify'] },
            },
            input: { v: 1, values: { tone: 'calm' } },
        });
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1',
            itemId: 'interactive-1',
            expectedItemRevision: 'rev-2',
            initialTitle: 'Existing',
            initialHtml: '<main>before</main>',
            baseItem,
            reachable: true,
            actions: stored.port,
            onSaved: vi.fn(),
        }));
        hook.getCurrent().setHtml('<main>after</main>');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(true);
        expect(stored.upserts).toHaveLength(1);
        expect(stored.upserts[0]?.itemId).toBe('interactive-1');
        expect(stored.upserts[0]?.expectedItemRevision).toBe('rev-2');
        expect(stored.upserts[0]?.item).toEqual({
            ...baseItem,
            title: 'Existing',
            source: {
                ...baseItem.source,
                source: artifactHtmlBundleFromBodyV1('<main>after</main>'),
            },
        });
        expect(stored.upserts[0]).not.toHaveProperty('placement');
    });

    it('requires review before applying a retained draft to the latest revision and conflicts again on a second update', async () => {
        const upserts: SessionBoardItemUpsertInput[] = [];
        const outcomes = [
            {
                status: 'refused' as const,
                error: { error: 'session_board_revision_conflict' as const, currentItemRevision: 'rev-2' },
            },
            {
                status: 'refused' as const,
                error: { error: 'session_board_revision_conflict' as const, currentItemRevision: 'rev-3' },
            },
            {
                status: 'ok' as const,
                value: {
                    v: 1 as const,
                    serverId: 'home-1',
                    sessionId: 'session-1',
                    result: {
                        operation: 'upsert_item' as const,
                        itemId: 'interactive-1',
                        outcome: 'updated' as const,
                        itemRevision: 'rev-4',
                    },
                    destination: null,
                },
            },
        ];
        const port = {
            upsertItem: async (input: SessionBoardItemUpsertInput) => {
                upserts.push(input);
                return outcomes.shift()!;
            },
            removeItem: actions({ status: 'unavailable', reason: 'board_actions_unavailable' }).port.removeItem,
            updateLayout: actions({ status: 'unavailable', reason: 'board_actions_unavailable' }).port.updateLayout,
        } satisfies SessionBoardActionsPort;
        // The conflict refresh has not settled yet, so the editor still sees the
        // exact rev-1 record it originally opened. Review must not bless this
        // stale snapshot as the new CAS operand.
        let latestRevision = 'rev-1';
        let latestHtml = '<main>base</main>';
        let latestItem = buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: latestHtml })!;
        const requestRecoveryRefresh = vi.fn();
        const onSaved = vi.fn();
        const flushHtml = vi.fn(async () => '<main>mine, including final keystroke</main>');
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1',
            itemId: 'interactive-1',
            expectedItemRevision: 'rev-1',
            latestRevision,
            latestHtml,
            initialTitle: 'Dashboard',
            initialHtml: '<main>base</main>',
            baseItem: buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: '<main>base</main>' })!,
            recoveryObservation: { state: 'settled', revision: latestRevision, item: latestItem },
            reachable: true,
            actions: port,
            onSaved,
            flushHtml,
            requestRecoveryRefresh,
        }));
        hook.getCurrent().setHtml('<main>mine</main>');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        expect(hook.getCurrent().canSave).toBe(false);
        expect(hook.getCurrent().html).toBe('<main>mine, including final keystroke</main>');
        expect(hook.getCurrent().latestHtml).toBe('<main>base</main>');
        expect(upserts[0]?.expectedItemRevision).toBe('rev-1');

        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        expect(hook.getCurrent().expectedRevision).toBe('rev-1');
        expect(hook.getCurrent().canSave).toBe(false);

        latestRevision = 'rev-2';
        latestHtml = '<main>theirs v2</main>';
        const latestBundle = artifactHtmlBundleFromBodyV1(latestHtml);
        latestItem = SessionSurfaceItemV1Schema.parse({
            ...latestItem,
            source: {
                kind: 'hostedHtml',
                source: {
                    v: 1,
                    entrypoint: 'pages/latest.html',
                    files: {
                        'pages/latest.html': latestBundle.files[latestBundle.entrypoint],
                        'app.js': { mime: 'application/javascript', contentBase64: 'YWxlcnQoMik=' },
                    },
                },
            },
        });
        await hook.rerender();
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: true });
        expect(hook.getCurrent().expectedRevision).toBe('rev-2');
        expect(hook.getCurrent().canSave).toBe(true);

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(upserts[1]?.expectedItemRevision).toBe('rev-2');
        expect(upserts[1]?.item.source).toMatchObject({
            source: {
                entrypoint: 'pages/latest.html',
                files: {
                    'pages/latest.html': {
                        contentBase64: artifactHtmlBundleFromBodyV1('<main>mine, including final keystroke</main>').files['index.html'].contentBase64,
                    },
                    'app.js': { mime: 'application/javascript', contentBase64: 'YWxlcnQoMik=' },
                },
            },
        });
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        expect(hook.getCurrent().canSave).toBe(false);

        // The second conflict likewise cannot reuse the already-reviewed rev-2
        // snapshot while the authoritative rev-3 refresh is still in flight.
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
        expect(hook.getCurrent().expectedRevision).toBe('rev-2');

        latestRevision = 'rev-3';
        latestHtml = '<main>theirs v3</main>';
        latestItem = buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: latestHtml, baseItem: latestItem })!;
        await hook.rerender();
        expect(hook.getCurrent().latestHtml).toBe('<main>theirs v3</main>');
        hook.getCurrent().reviewLatest();
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(true);
        expect(upserts[2]?.expectedItemRevision).toBe('rev-3');
        expect(onSaved).toHaveBeenCalledOnce();
        expect(requestRecoveryRefresh).toHaveBeenCalledTimes(2);
    });

    it('persists a valid bundle beyond the retired source-string ceiling', async () => {
        const stored = actions({ status: 'ok', value: upsertResult({ itemId: 'interactive-1', itemRevision: 'rev-1' }) });
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved: vi.fn(),
        }));
        const oversizedHtml = 'é'.repeat(524289);
        hook.getCurrent().setHtml(oversizedHtml);
        await hook.rerender();
        expect(await hook.getCurrent().save()).toBe(true);
        await hook.rerender();
        expect(stored.upserts[0]?.item.source).toEqual({ kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1(oversizedHtml) });
        expect(hook.getCurrent().html).toBe(oversizedHtml);
    });

    it('settles a pending approval once and restores an editable retained draft after cancellation', async () => {
        const stored = actions({
            status: 'pending_approval',
            approval: upsertApproval('approval-html-1'),
        });
        const continuation = createApprovalCapture();
        const onSaved = vi.fn();
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved, requestApprovalContinuation: continuation.request,
        }));
        hook.getCurrent().setTitle('Dashboard');
        hook.getCurrent().setHtml('<main>retained</main>');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(continuation.request).toHaveBeenCalledOnce();
        expect(continuation.read()?.expectedInput).toEqual(stored.upserts[0]);
        expect(await hook.getCurrent().save()).toBe(false);
        expect(stored.upserts).toHaveLength(1);

        continuation.read()?.onFailed('approval_canceled');
        await hook.rerender();
        expect(hook.getCurrent().html).toBe('<main>retained</main>');
        expect(hook.getCurrent().canSave).toBe(true);
    });

    it('refreshes and retains the exact approved HTML submission when approval execution becomes outcome unknown', async () => {
        const stored = actions({
            status: 'pending_approval',
            approval: upsertApproval('approval-html-unknown'),
        });
        const continuation = createApprovalCapture();
        const requestRecoveryRefresh = vi.fn();
        const onSaved = vi.fn();
        let observation: NonNullable<Parameters<typeof useSessionBoardHostedHtmlEditor>[0]['recoveryObservation']> = {
            state: 'settled',
            revision: null,
            item: null,
        };
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved,
            requestApprovalContinuation: continuation.request,
            requestRecoveryRefresh,
            recoveryObservation: observation,
        }));
        hook.getCurrent().setTitle('Dashboard');
        hook.getCurrent().setHtml('<main>exact approved draft</main>');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        continuation.read()?.onFailed('approval_execution_outcome_unknown');
        await hook.rerender();

        expect(hook.getCurrent().status.kind).toBe('outcomeUnknown');
        expect(hook.getCurrent().canSave).toBe(false);
        expect(requestRecoveryRefresh).toHaveBeenCalledOnce();
        expect(await hook.getCurrent().save()).toBe(false);
        expect(stored.upserts).toHaveLength(1);

        observation = { state: 'refreshing', revision: null, item: null };
        await hook.rerender();
        observation = {
            state: 'settled',
            revision: 'html-rev-approved',
            item: stored.upserts[0]!.item,
        };
        await hook.rerender();

        expect(onSaved).toHaveBeenCalledOnce();
        expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
        expect(hook.getCurrent().expectedRevision).toBe('html-rev-approved');
        expect(hook.getCurrent().dirty).toBe(false);
        expect(stored.upserts).toHaveLength(1);
    });

    it('settles against the exact submitted hosted draft while preserving newer edits', async () => {
        const stored = actions({
            status: 'pending_approval',
            approval: upsertApproval('approval-html-1'),
        });
        const continuation = createApprovalCapture();
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved: vi.fn(),
            requestApprovalContinuation: continuation.request,
        }));
        hook.getCurrent().setTitle('Submitted');
        hook.getCurrent().setHtml('<main>submitted</main>');
        await hook.rerender();
        await hook.getCurrent().save();
        await hook.rerender();

        hook.getCurrent().setTitle('Newer edit');
        await hook.rerender();
        await continuation.read()?.onSucceeded(upsertResult({
            itemId: 'interactive-1',
            itemRevision: 'rev-approved',
            outcome: 'created',
        }));
        await hook.rerender();

        expect(hook.getCurrent().title).toBe('Newer edit');
        expect(hook.getCurrent().dirty).toBe(true);
        expect(hook.getCurrent().expectedRevision).toBe('rev-approved');
    });

    it('does not submit while another exact Board approval is unresolved', async () => {
        const stored = actions({ status: 'unavailable', reason: 'board_actions_unavailable' });
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1', expectedItemRevision: 'rev-1',
            initialTitle: 'Dashboard', initialHtml: '<main>base</main>',
            reachable: true, approvalPending: true, actions: stored.port, onSaved: vi.fn(),
        }));
        hook.getCurrent().setHtml('<main>retained</main>');
        await hook.rerender();

        expect(hook.getCurrent().canSave).toBe(false);
        expect(await hook.getCurrent().save()).toBe(false);
        expect(stored.upserts).toEqual([]);
        expect(hook.getCurrent().html).toBe('<main>retained</main>');
    });

    it.each([
        ['committed', 'item-rev-1', '<main>final</main>', 'saved'],
        ['not committed', null, null, 'retryable'],
        ['conflict', 'item-rev-1', '<main>someone else</main>', 'conflict'],
    ] as const)('reconciles an unknown create after a canonical refresh when it is %s', async (_name, revision, observedHtml, expected) => {
        const submittedItem = buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: '<main>final</main>' })!;
        const mutationRequest = {
            operation: 'upsert_item' as const,
            itemId: 'interactive-1',
            expectedItemRevision: null,
            itemContent: { t: 'plain' as const, v: submittedItem },
            placement: {
                expectedLayoutRevision: null,
                layoutContent: {
                    t: 'plain' as const,
                    v: { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'interactive-1', width: 'medium' as const }] }] },
                },
            },
        };
        const recovery: SessionBoardActionRecoveryEvidenceV1 = {
            v: 1,
            actionId: 'session.board.item.upsert',
            serverId: 'home-1',
            sessionId: 'session-1',
            requestBody: JSON.stringify(mutationRequest),
            mutationRequest,
            intent: {
                sessionId: 'session-1',
                itemId: 'interactive-1',
                expectedItemRevision: null,
                item: submittedItem,
                placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            },
        };
        let observation: NonNullable<Parameters<typeof useSessionBoardHostedHtmlEditor>[0]['recoveryObservation']> = {
            state: 'settled',
            revision: null,
            item: null,
        };
        const onSaved = vi.fn();
        const requestRecoveryRefresh = vi.fn();
        const stored = actions({ status: 'outcome_unknown', recovery });
        const hook = await renderHook(() => useSessionBoardHostedHtmlEditor({
            sessionId: 'session-1', itemId: 'interactive-1',
            expectedItemRevision: null, initialTitle: '', initialHtml: '',
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            reachable: true, actions: stored.port, onSaved,
            recoveryObservation: observation,
            requestRecoveryRefresh,
        }));
        hook.getCurrent().setTitle('Dashboard');
        hook.getCurrent().setHtml('<main>final</main>');
        await hook.rerender();

        expect(await hook.getCurrent().save()).toBe(false);
        await hook.rerender();
        expect(hook.getCurrent().status.kind).toBe('outcomeUnknown');
        expect(requestRecoveryRefresh).toHaveBeenCalledTimes(1);
        expect(await hook.getCurrent().save()).toBe(false);
        expect(stored.upserts).toHaveLength(1);

        observation = { state: 'refreshing', revision: null, item: null };
        await hook.rerender();
        observation = {
            state: 'settled',
            revision,
            item: observedHtml === null
                ? null
                : buildSessionBoardHostedHtmlItem({ title: 'Dashboard', html: observedHtml }),
        };
        await hook.rerender();

        if (expected === 'saved') {
            expect(onSaved).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().dirty).toBe(false);
        } else if (expected === 'retryable') {
            expect(onSaved).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toEqual({ kind: 'editing' });
            expect(hook.getCurrent().canSave).toBe(true);
        } else {
            expect(onSaved).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toEqual({ kind: 'conflict', reviewed: false });
            expect(hook.getCurrent().canSave).toBe(false);
        }
        expect(hook.getCurrent().html).toBe('<main>final</main>');
    });
});
