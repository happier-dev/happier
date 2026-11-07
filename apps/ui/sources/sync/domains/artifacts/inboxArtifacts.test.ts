import { describe, expect, it, vi } from 'vitest';
import { createHook } from 'node:async_hooks';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import * as admission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createStore } from 'zustand/vanilla';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { patchInboxArtifactOrder, projectInboxArtifactItems, readInboxArtifactEntry } from './inboxArtifacts';

/** Count distinct retained rows per event-loop task; Promise/nextTick jobs do not yield the thread. */
async function measureRetainedTaskWork<T>(work: (visit: (index: number) => void) => T | Promise<T>) {
    const types = new Map<number, string>();
    let visited = new Set<number>();
    let maximum = 0;
    const hook = createHook({
        init(id, type) { types.set(id, type); },
        before(id) {
            const type = types.get(id);
            if (type && type !== 'PROMISE' && type !== 'TickObject' && type !== 'Microtask') visited = new Set();
        },
        destroy(id) { types.delete(id); },
    });
    hook.enable();
    try {
        const result = await work(index => {
            visited.add(index);
            maximum = Math.max(maximum, visited.size);
        });
        return { result, maximum };
    } finally { hook.disable(); }
}

function approvalArtifact(id: string, updatedAt: number): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'scale-session' }, requestedSurface: 'agent',
        actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
    return { id, isDecrypted: true, header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request), title: 'List sessions', headerVersion: 1, bodyVersion: 1,
        seq: updatedAt, createdAt: updatedAt, updatedAt };
}

describe('admitted Inbox Artifact projection', () => {
    it('reuses unchanged admissions across unrelated Artifact publications and strictly admits changed bodies', () => {
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session-a' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const open: DecryptedArtifact = { id: 'approval', isDecrypted: true,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            title: 'List sessions', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        store.getState().addArtifact(open);
        const select = () => projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a').count;
        const admit = vi.spyOn(admission, 'approvalArtifactBodyMatchesHeaderV1');
        try {
            expect(select()).toBe(1);
            const entries = store.getState().artifactInboxEntries;
            admit.mockClear();
            for (let tick = 0; tick < 20; tick++) {
                const note: DecryptedArtifact = { ...open, id: `note-${tick}`, header: { kind: 'prompt_doc.v2', title: 'Note' }, body: 'Note' };
                store.getState().addArtifact(note);
                expect(select()).toBe(1);
                expect(store.getState().artifactInboxEntries).toBe(entries);
            }
            expect(admit).not.toHaveBeenCalled();
            store.getState().updateArtifact({ ...open, body: '{}', bodyVersion: 2 });
            expect(select()).toBe(0);
            expect(admit).toHaveBeenCalledTimes(1);
            store.getState().updateArtifact({ ...open, bodyVersion: 3 });
            expect(select()).toBe(1);
            expect(admit).toHaveBeenCalledTimes(2);
            store.getState().deleteArtifact(open.id);
            expect(select()).toBe(0);
        } finally { admit.mockRestore(); }
    });

    it('selects retained notice admissions by their authenticated Account owner', () => {
        const notice = createAccountNoticeArtifactFixture();
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        store.getState().addArtifact(notice);
        const order = store.getState().artifactInboxOrder;
        expect(projectInboxArtifactItems(order, 'account-a').count).toBe(1);
        expect(projectInboxArtifactItems(order, 'account-b').count).toBe(0);
        expect(projectInboxArtifactItems(order, 'account-a').count).toBe(1);
    });

    it('keeps equal-time admission order through revisions, removal and later pages without mutating published snapshots', () => {
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const a = approvalArtifact('a', 10);
        const b = approvalArtifact('b', 10);
        const c = approvalArtifact('c', 10);
        store.getState().applyArtifacts([a, b]);
        const originalOrder = store.getState().artifactInboxOrder;
        const original = projectInboxArtifactItems(originalOrder, 'account-a');
        store.getState().applyArtifacts([c, approvalArtifact('newest', 20)]);
        expect(store.getState().artifactInboxOrder.map(entry => entry.artifact.id)).toEqual(['newest', 'a', 'b', 'c']);
        store.getState().updateArtifact({ ...b, title: 'Revised', headerVersion: 2 });
        expect(store.getState().artifactInboxOrder.map(entry => entry.artifact.id)).toEqual(['newest', 'a', 'b', 'c']);
        store.getState().deleteArtifact('a');
        expect(store.getState().artifactInboxOrder.map(entry => entry.artifact.id)).toEqual(['newest', 'b', 'c']);
        store.getState().updateArtifact({ ...c, headerVersion: 2, updatedAt: 20 });
        const current = projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a', original);
        expect(current.openApprovals.map(artifact => artifact.id)).toEqual(['newest', 'c', 'b']);
        expect(current.openApprovals.find(artifact => artifact.id === 'b')?.title).toBe('Revised');
        expect(current.openApprovals.slice(1, 3).map(artifact => artifact.id)).toEqual(['c', 'b']);
        expect([...current.artifacts].map(artifact => artifact.id)).toEqual(['newest', 'c', 'b']);
        expect(originalOrder.map(entry => entry.artifact.id)).toEqual(['a', 'b']);
        expect(original.artifacts).toEqual([a, b]);
        expect(original.openApprovals).toEqual([a, b]);
        expect(original.count).toBe(2);
    });

    it('keeps Account notice counts, completeness and unchanged list identities separate from approval changes', () => {
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const noticeA = createAccountNoticeArtifactFixture({ id: 'notice-a' });
        const noticeB = createAccountNoticeArtifactFixture({ id: 'notice-b', ownerAccountId: 'account-b' });
        const pendingB = createAccountNoticeArtifactFixture({ id: 'pending-b', ownerAccountId: 'account-b' });
        store.getState().applyArtifacts([noticeA, noticeB, { ...pendingB, body: undefined }]);
        const before = projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a');
        expect(before.count).toBe(1);
        expect(before.complete).toBe(true);
        expect(before.accountNotices.map(notice => notice.artifact.id)).toEqual(['notice-a']);
        const other = projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-b');
        expect(other.count).toBe(1);
        expect(other.complete).toBe(false);
        expect(other.accountNotices.map(notice => notice.artifact.id)).toEqual(['notice-b']);
        store.getState().addArtifact(approvalArtifact('approval', 3_000));
        const after = projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a', before);
        expect(after.count).toBe(2);
        expect(after.accountNotices).toBe(before.accountNotices);
        expect(after.openAccountNotices).toBe(before.openAccountNotices);
        expect(after.openUsageNotices).toBe(before.openUsageNotices);
        expect(projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a', after)).toBe(after);
        store.getState().updateArtifact({ ...pendingB, bodyVersion: pendingB.bodyVersion! + 1 });
        const settled = projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-b', other);
        expect(settled.count).toBe(3);
        expect(settled.complete).toBe(true);
        expect(settled.accountNotices.map(notice => notice.artifact.id)).toEqual(['notice-b', 'pending-b']);
        expect(projectInboxArtifactItems(store.getState().artifactInboxOrder, 'account-a', after).accountNotices).toBe(after.accountNotices);
    });

    it('answers the first 10,500-row reader count without walking retained artifacts and reads only its requested visible window', () => {
        const retainedCount = 10_500;
        const pageSize = 500;
        const windowSize = 20;
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        for (let start = 0; start < retainedCount; start += pageSize) {
            store.getState().applyArtifacts(Array.from({ length: pageSize }, (_, offset) =>
                approvalArtifact(`first-${start + offset}`, start + offset)));
        }
        const order = store.getState().artifactInboxOrder;
        const visited = new Set<number>();
        let measuring = false;
        order.forEach((entry, index) => {
            const artifact = entry.artifact;
            Object.defineProperty(entry, 'artifact', { configurable: true,
                get() { if (measuring) visited.add(index); return artifact; } });
        });
        measuring = true;
        const items = projectInboxArtifactItems(order, 'account-a');
        expect(items.count).toBe(retainedCount);
        expect(items.complete).toBe(true);
        expect(items.openApprovals).toHaveLength(retainedCount);
        expect(visited.size).toBe(0);
        const visible = items.artifacts.slice(100, 100 + windowSize);
        expect(visible.map(artifact => artifact.id)).toEqual(Array.from({ length: windowSize }, (_, offset) =>
            `first-${retainedCount - 101 - offset}`));
        expect(visited.size).toBeLessThanOrEqual(windowSize);
        measuring = false;
    });

    it.each(['order merge', 'row projection'] as const)(
        'keeps a 500-row page %s from visiting all 10,500 retained rows in one task', async phase => {
            // Observed lp4.json census and inventory page size, not a new runtime ceiling.
            const retainedCount = 10_500;
            const pageSize = 500;
            const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'scale-session' }, requestedSurface: 'agent',
                actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
            const header = buildApprovalRequestArtifactHeaderV1(request);
            const body = JSON.stringify(request);
            const row = (index: number): DecryptedArtifact => ({ id: `scale-${index}`, isDecrypted: true,
                header, body, title: 'List sessions', headerVersion: 1, bodyVersion: 1, seq: index,
                createdAt: index, updatedAt: index });
            const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
            for (let start = 0; start < retainedCount; start += pageSize) {
                store.getState().applyArtifacts(Array.from({ length: pageSize }, (_, offset) => row(start + offset)));
            }
            const retained = store.getState().artifactInboxOrder;
            const previous = projectInboxArtifactItems(retained, 'account-a');
            const added = Array.from({ length: pageSize }, (_, offset) => readInboxArtifactEntry(row(retainedCount + offset))!);
            const changes = added.map(next => ({ next }));
            const projectedOrder = phase === 'row projection' ? patchInboxArtifactOrder(retained, changes) : null;
            let recordVisit: ((index: number) => void) | undefined;
            retained.forEach((entry, index) => {
                const artifact = entry.artifact;
                Object.defineProperty(entry, 'artifact', { configurable: true,
                    get() { recordVisit?.(index); return artifact; } });
            });
            const measured = await measureRetainedTaskWork(async visit => {
                recordVisit = visit;
                try {
                    if (phase === 'order merge') {
                        const observed = new Proxy(retained, {
                            get(target, key, receiver) {
                                if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) visit(Number(key));
                                return Reflect.get(target, key, receiver);
                            },
                        });
                        const order = await patchInboxArtifactOrder(observed, changes);
                        return { order, items: null };
                    }
                    const order = projectedOrder!;
                    return { order, items: await projectInboxArtifactItems(order, 'account-a', previous) };
                } finally { recordVisit = undefined; }
            });
            // All new rows are newer than retained rows: unchanged rows need no per-row admission.
            // A task may touch one actual inventory page; yielding between pages remains permitted.
            console.info('Inbox retained task cost', { phase, retainedCount, pageSize, maximum: measured.maximum });
            expect(measured.maximum).toBeLessThanOrEqual(pageSize);
            expect(measured.result.order).toHaveLength(retainedCount + pageSize);
            expect(measured.result.order[0]).toBe(added[pageSize - 1]);
            expect(measured.result.order[pageSize]).toBe(retained[0]);
            if (measured.result.items) {
                expect(measured.result.items.count).toBe(retainedCount + pageSize);
                expect(measured.result.items.complete).toBe(true);
                expect(measured.result.items.openApprovals).toHaveLength(retainedCount + pageSize);
                expect(measured.result.items.accountNotices).toBe(previous.accountNotices);
            }
        },
    );
});
