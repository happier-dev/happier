import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { createArtifactsDomain, type ArtifactsDomain } from './artifacts';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { decryptArtifactListItem, decryptArtifactWithBody, decryptSocketNewArtifactUpdate } from '@/sync/engine/artifacts/syncArtifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { doesArtifactInventorySelectionCover, isArtifactInventoryLoaded, isArtifactInventoryReady } from '@/sync/domains/artifacts/artifactInventory';
import { selectArtifactInventoryRows } from './artifactInventoryIndex';
import { createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';

function createHarness() {
    return createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
}

function artifact(id: number): Extract<DecryptedArtifact, { isDecrypted: true }> {
    return {
        id: `artifact-${id}`, title: `Artifact ${id}`, updatedAt: id, createdAt: id,
        headerVersion: 1, seq: id, isDecrypted: true, draft: false,
    };
}

describe('createArtifactsDomain', () => {
    it('indexes C1 health by Environment at admission and withdraws removed or unreadable facts', () => {
        const store = createHarness();
        const health = createServiceHealthNoticeArtifactFixture('home', { id: 'health', sourceServerId: 'home' });
        const key = serverAccountScopedResourceKey({ serverId: 'home', accountId: 'account-a' }, 'environment');
        store.getState().applyArtifacts([health]);
        expect(store.getState().artifactHealthNoticesByEnvironmentId?.[key]?.health?.notice?.header.healthPhase).toBe('open');
        const selected = store.getState().artifactHealthNoticesByEnvironmentId[key];
        store.getState().applyArtifacts([artifact(5)]);
        expect(store.getState().artifactHealthNoticesByEnvironmentId[key]).toBe(selected);
        store.getState().updateArtifact({ ...health, headerVersion: 4, bodyVersion: 4, body: undefined });
        expect(store.getState().artifactHealthNoticesByEnvironmentId[key]?.health?.complete).toBe(false);
        expect(store.getState().artifactHealthNoticesByEnvironmentId[key]?.health?.notice).toBeNull();
        store.getState().updateArtifact({ ...health, headerVersion: 5, bodyVersion: 5, access: 'view' });
        expect(store.getState().artifactHealthNoticesByEnvironmentId[key]).toBeUndefined();
        store.getState().updateArtifact({ ...health, headerVersion: 6, bodyVersion: 6 });
        store.getState().deleteArtifact(health.id);
        expect(store.getState().artifactHealthNoticesByEnvironmentId[key]).toBeUndefined();
    });
    it('publishes a same-Session approval page and retires it without enumerating membership after each row', () => {
        const store = createHarness();
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'rejected', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'same-session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'Historical request',
            decision: { kind: 'reject', decidedAtMs: 1 } });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const receipts = Array.from({ length: 512 }, (_, index) => ({ ...artifact(index),
            id: `same-session-receipt-${index}`, header }));
        const keys = Object.keys;
        let membershipKeyVisits = 0;
        // Transparent observation of the runtime enumeration boundary; the real
        // store, admission and relationship projection execute unchanged.
        const enumeration = vi.spyOn(Object, 'keys').mockImplementation(value => {
            const result = keys(value);
            if (result.length > 0 && result.every(key => key.startsWith('same-session-receipt-'))) {
                membershipKeyVisits += result.length;
            }
            return result;
        });
        try {
            store.getState().applyArtifacts(receipts);
            const insertionVisits = membershipKeyVisits;
            console.info('Same-Session approval insertion cost', { receipts: receipts.length, membershipKeyVisits: insertionVisits });
            const bucket = store.getState().artifactApprovalArtifactsBySessionId['same-session'];
            expect(bucket && keys(bucket)).toHaveLength(receipts.length);
            expect(bucket?.[receipts.at(-1)!.id]).toBe(receipts.at(-1));
            store.getState().deleteArtifact(receipts[0]!.id);
            const remaining = store.getState().artifactApprovalArtifactsBySessionId['same-session'];
            expect(remaining?.[receipts[0]!.id]).toBeUndefined();
            expect(remaining?.[receipts.at(-1)!.id]).toBe(receipts.at(-1));
            // Empty-bucket retirement is still required on deletion.
            membershipKeyVisits = 0;
            store.getState().applyArtifacts([], store.getState().artifacts);
            const retirementVisits = membershipKeyVisits;
            console.info('Same-Session approval retirement cost', { receipts: receipts.length - 1, membershipKeyVisits: retirementVisits });
            expect(store.getState().artifactApprovalArtifactsBySessionId['same-session']).toBeUndefined();
            expect(insertionVisits).toBe(0);
            expect(retirementVisits).toBe(0);
        } finally { enumeration.mockRestore(); }
    });
    it('keeps query membership current through state, kind, relationship, locked and deletion transitions', () => {
        const store = createHarness();
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'first-session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'Query membership' });
        const approval = { ...artifact(1), header: buildApprovalRequestArtifactHeaderV1(request) };
        const document = { ...artifact(2), header: { kind: 'markdown', title: 'Document' } };
        store.getState().applyArtifacts([approval, document]);
        const selected = (selection: Parameters<typeof selectArtifactInventoryRows>[1]) =>
            Object.keys(selectArtifactInventoryRows(store.getState(), selection));
        expect(selected('inboxOpen')).toEqual([approval.id]);
        expect(selected('browserListed')).toEqual([document.id]);
        expect(selected(['approval_request.v1'])).toEqual([approval.id]);
        expect(selected({ approvalSessionIds: ['first-session'] })).toEqual([approval.id]);
        const before = store.getState().artifactInventoryIndex;
        store.getState().updateArtifact({ ...document, body: 'Changed body' });
        expect(store.getState().artifactInventoryIndex).toBe(before);
        const moved = { ...approval, headerVersion: 2, header: buildApprovalRequestArtifactHeaderV1({ ...request,
            createdBy: { surface: 'agent', sessionId: 'next-session' }, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } }) };
        store.getState().updateArtifact(moved);
        expect(selected('inboxOpen')).toEqual([]);
        expect(selected({ approvalSessionIds: ['first-session'] })).toEqual([]);
        expect(selected({ approvalSessionIds: ['next-session'] })).toEqual([approval.id]);
        expect(selected({ kinds: ['approval_request.v1'], approvalStates: ['rejected'] })).toEqual([approval.id]);
        store.getState().updateArtifact({ ...moved, headerVersion: 3, header: { kind: 'memory_doc.v1', title: 'Changed kind' } });
        expect(selected(['approval_request.v1'])).toEqual([]);
        expect(selected({ approvalSessionIds: ['next-session'] })).toEqual([]);
        expect(selected(['memory_doc.v1'])).toEqual([approval.id]);
        const locked: DecryptedArtifact = { id: approval.id, title: null, header: null, rawHeader: null,
            headerVersion: 4, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: false, storageMode: 'e2ee',
            kindHint: 'memory_doc.v1', availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        store.getState().updateArtifact(locked);
        expect(selected(['memory_doc.v1'])).toEqual([]); // Opaque kind hint is not private-header membership.
        expect(selected('browserListed').sort()).toEqual([approval.id, document.id].sort());
        store.getState().deleteArtifact(approval.id);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(store.getState().artifactInventoryIndex.size).toBe(0);
        expect(selectArtifactInventoryRows(store.getState())).toBe(store.getState().artifacts);
    });

    it('publishes approval relationships from changed ids and retires moved, draft, locked and deleted rows', () => {
        const store = createHarness();
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'selected' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const selected = { ...artifact(0), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
        const retained = Array.from({ length: 512 }, (_, index) => ({ ...artifact(index + 1),
            header: { ...selected.header, sessionId: `closed-${index}`, sessions: [`closed-${index}`] } }));
        store.getState().applyArtifacts([selected, ...retained]);
        const before = store.getState();
        const selectedBucket = before.artifactApprovalArtifactsBySessionId.selected;
        expect(Object.keys(before.artifactOpenApprovalEntries)).toEqual([selected.id]);
        const closedBucket = before.artifactApprovalArtifactsBySessionId['closed-0'];
        store.getState().addArtifact({ ...artifact(600), header: { kind: 'note', title: 'Note' } });
        expect(store.getState().artifactOpenApprovalEntries).toBe(before.artifactOpenApprovalEntries);
        expect(store.getState().artifactDiscussionAttentionEntries).toBe(before.artifactDiscussionAttentionEntries);
        expect(store.getState().artifactIncompleteInboxArtifacts).toBe(before.artifactIncompleteInboxArtifacts);
        expect(store.getState().artifactApprovalArtifactsBySessionId).toBe(before.artifactApprovalArtifactsBySessionId);
        const unrelatedRequest = ApprovalRequestV1Schema.parse({ ...request, createdBy: { surface: 'agent', sessionId: 'unrelated' } });
        const unrelatedOpen = { ...selected, id: 'unrelated-open-request', header: buildApprovalRequestArtifactHeaderV1(unrelatedRequest),
            body: JSON.stringify(unrelatedRequest) };
        store.getState().addArtifact(unrelatedOpen);
        expect(store.getState().artifactOpenApprovalEntries[unrelatedOpen.id]?.parsed.request.status).toBe('open');
        expect(store.getState().artifactDiscussionAttentionEntries).toBe(before.artifactDiscussionAttentionEntries);
        expect(store.getState().artifactIncompleteInboxArtifacts).toBe(before.artifactIncompleteInboxArtifacts);
        store.getState().deleteArtifact(unrelatedOpen.id);
        expect(store.getState().artifactDiscussionAttentionEntries).toBe(before.artifactDiscussionAttentionEntries);
        expect(store.getState().artifactIncompleteInboxArtifacts).toBe(before.artifactIncompleteInboxArtifacts);
        const moved = { ...retained[0]!, headerVersion: 2,
            header: { ...retained[0]!.header, sessionId: 'moved', sessions: ['moved'] } };
        store.getState().updateArtifact(moved);
        expect(store.getState().artifactApprovalArtifactsBySessionId.selected).toBe(selectedBucket);
        expect(store.getState().artifactApprovalArtifactsBySessionId['closed-0']).toBeUndefined();
        expect(closedBucket?.[moved.id]).toBe(retained[0]);
        expect(store.getState().artifactApprovalArtifactsBySessionId.moved?.[moved.id]).toBe(moved);
        store.getState().updateArtifact({ ...moved, draft: true });
        expect(store.getState().artifactApprovalArtifactsBySessionId.moved).toBeUndefined();
        store.getState().updateArtifact(moved);
        const locked: DecryptedArtifact = { id: moved.id, seq: moved.seq, createdAt: moved.createdAt, updatedAt: moved.updatedAt,
            headerVersion: 3, header: null, title: null, isDecrypted: false, storageMode: 'e2ee',
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        store.getState().updateArtifact(locked);
        expect(store.getState().artifactApprovalArtifactsBySessionId.moved).toBeUndefined();
        store.getState().deleteArtifact(selected.id);
        expect(store.getState().artifactOpenApprovalEntries).toEqual({});
        expect(store.getState().artifactApprovalArtifactsBySessionId.selected).toBeUndefined();
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(store.getState().artifactApprovalArtifactsBySessionId).toEqual({});
        expect(store.getState().artifactApprovalArtifactsByDiscussionId).toEqual({});
    });

    it('publishes narrow inventory inputs only for selected row changes and retires them with membership', () => {
        const store = createHarness();
        const prompt = { ...artifact(1), header: { kind: 'prompt_doc.v2', title: 'Prompt' }, rawHeader: { kind: 'prompt_doc.v2' } };
        const ordinary = { ...artifact(2), header: { kind: 'future.document.v9', title: 'Ordinary' }, rawHeader: { kind: 'future.document.v9' } };
        const privateRows = Array.from({ length: 3500 }, (_, id) => ({ ...artifact(id + 10),
            header: { kind: 'approval_request.v1', title: 'Receipt', approvalStatus: 'canceled' }, rawHeader: { kind: 'approval_request.v1' } }));
        store.getState().applyArtifacts([prompt, ordinary, ...privateRows]);
        const before = store.getState();
        expect(Object.keys(before.artifactPromptLibraryArtifacts)).toEqual([prompt.id]);
        expect(Object.keys(before.artifactBrowserArtifacts)).toEqual([prompt.id, ordinary.id]);
        expect(before.artifactInboxEntries).toEqual({});
        for (const row of privateRows.slice(0, 10)) store.getState().updateArtifact({ ...row, bodyVersion: 2 });
        expect(store.getState().artifactBrowserArtifacts).toBe(before.artifactBrowserArtifacts);
        expect(store.getState().artifactPromptLibraryArtifacts).toBe(before.artifactPromptLibraryArtifacts);
        expect(store.getState().artifactInboxEntries).toBe(before.artifactInboxEntries);
        store.getState().updateArtifact({ ...ordinary, bodyVersion: 2 });
        expect(store.getState().artifactBrowserArtifacts[ordinary.id]).not.toBe(ordinary);
        expect(store.getState().artifactBrowserArtifacts[prompt.id]).toBe(prompt);
        expect(store.getState().artifactPromptLibraryArtifacts).toBe(before.artifactPromptLibraryArtifacts);
        store.getState().deleteArtifact(prompt.id);
        expect(store.getState().artifactPromptLibraryArtifacts).toEqual({});
        expect(store.getState().artifactBrowserArtifacts[prompt.id]).toBeUndefined();
        const opaque: DecryptedArtifact = { id: 'opaque', headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            isDecrypted: false, title: null, header: null,
            storageMode: 'e2ee', availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        store.getState().addArtifact(opaque);
        expect(store.getState().artifactBrowserArtifacts[opaque.id]).toBe(opaque);
        expect(store.getState().artifactPromptLibraryArtifacts[opaque.id]).toBe(opaque);
        expect(store.getState().artifactInboxEntries[opaque.id]?.complete).toBe(false);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(store.getState()).toMatchObject({ artifactBrowserArtifacts: {}, artifactPromptLibraryArtifacts: {}, artifactInboxEntries: {} });
    });
    it('keeps settled receipts during open-only reconciliation and never certifies full approval membership', () => {
        const store = createHarness();
        const approval = (id: number, status: string) => ({ ...artifact(id),
            rawHeader: { kind: 'approval_request.v1', approvalStatus: status, sessionId: 's1' } });
        const settled = approval(1, 'executed'), missingOpen = approval(2, 'open'), currentOpen = approval(3, 'open');
        store.getState().applyArtifacts([settled, missingOpen]);
        store.getState().applyArtifacts([currentOpen], store.getState().artifacts, 'inboxOpen');
        const state = store.getState();
        expect(state.artifacts[settled.id]).toBe(settled);
        expect(state.artifacts[missingOpen.id]).toBeUndefined();
        expect(state.artifacts[currentOpen.id]).toBe(currentOpen);
        expect(isArtifactInventoryLoaded(state, 'inboxOpen')).toBe(true);
        expect(isArtifactInventoryLoaded(state, ['approval_request.v1'])).toBe(false);
        expect(isArtifactInventoryLoaded(state)).toBe(false);
        expect(doesArtifactInventorySelectionCover('inboxOpen', ['approval_request.v1'])).toBe(false);
        expect(doesArtifactInventorySelectionCover({ approvalSessionIds: ['s1'] }, 'inboxOpen')).toBe(false);
        store.getState().applyArtifacts([settled], state.artifacts, { approvalSessionIds: ['s1'] });
        expect(store.getState().artifacts[settled.id]).toBe(settled);
        expect(store.getState().artifactInventoryKindsLoaded).toEqual([]);
    });
    it('uses readable browser membership for listed kinds, never private kinds or true full membership', () => {
        const state = { ...createHarness().getState(), artifactBrowserLoaded: true };
        expect(isArtifactInventoryLoaded(state, ['prompt_bundle.v2', 'acme.future-document'])).toBe(true);
        expect(isArtifactInventoryLoaded(state, ['approval_request.v1'])).toBe(false);
        expect(isArtifactInventoryLoaded(state)).toBe(false);
        expect(isArtifactInventoryLoaded(state, 'browserListed')).toBe(true);
        expect(isArtifactInventoryReady(state, 'browserListed')).toBe(true);
        expect(doesArtifactInventorySelectionCover(undefined, 'browserListed')).toBe(true);
        expect(doesArtifactInventorySelectionCover('browserListed', undefined)).toBe(false);
        expect(doesArtifactInventorySelectionCover('browserListed', ['prompt_bundle.v2', 'acme.future-document'])).toBe(true);
        expect(doesArtifactInventorySelectionCover('browserListed', ['approval_request.v1'])).toBe(false);
        expect(doesArtifactInventorySelectionCover(['markdown', 'prompt_bundle.v2'], ['prompt_bundle.v2'])).toBe(true);
        expect(doesArtifactInventorySelectionCover(['markdown', 'prompt_bundle.v2'], 'browserListed')).toBe(false);
        expect(doesArtifactInventorySelectionCover(['markdown'], ['approval_request.v1'])).toBe(false);
    });

    it('reconciles browser absence while preserving private opaque rows and concurrent arrivals', () => {
        const store = createHarness();
        expect(store.getState()).toMatchObject({ artifactBrowserLoaded: false });
        const listed = (id: number, kind?: string) => ({ ...artifact(id), access: 'owner' as const,
            header: { title: 'Document', ...(kind ? { kind } : {}) }, rawHeader: { title: 'Document', ...(kind ? { kind } : {}) } });
        const privateOpaque: DecryptedArtifact = { id: 'private', title: null, header: null, rawHeader: null, storageMode: 'e2ee', kindHint: 'approval_request.v1',
            isDecrypted: false, headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        store.getState().applyArtifacts([listed(1, 'markdown'), listed(2, 'acme.unknown'), listed(3), listed(6), privateOpaque]);
        const baseline = store.getState().artifacts;
        store.getState().updateArtifact({ ...listed(2, 'acme.unknown'), headerVersion: 2 });
        store.getState().deleteArtifact('artifact-3');
        store.getState().addArtifact(listed(4));
        store.getState().applyArtifacts([listed(3), listed(5)], baseline, 'browserListed');
        const state = store.getState();
        expect(Object.keys(state.artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5', 'private']);
        expect(state.artifacts.private).toBe(privateOpaque);
        expect(state.artifactBrowserLoaded).toBe(true);
        expect(state.artifactsLoaded).toBe(false);
        expect(state.artifactInventoryKindsLoaded).toEqual([]);
        store.getState().applyArtifacts(Object.values(state.artifacts).filter(row => row.id !== 'private'), state.artifacts, 'browserListed');
        expect(store.getState()).toBe(state);
    });

    it('keeps full structural membership but withdraws browser counts for opaque observations and arrivals', () => {
        const store = createHarness();
        expect(store.getState()).toMatchObject({ artifactBrowserLoaded: false });
        const listed = { ...artifact(1), access: 'owner' as const, header: { title: 'Document', kind: 'markdown' },
            rawHeader: { title: 'Document', kind: 'markdown' } };
        store.getState().applyArtifacts([listed], store.getState().artifacts);
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(true);
        const opaque: DecryptedArtifact = { id: 'opaque', title: null, header: null, rawHeader: null, storageMode: 'plain', kindHint: 'markdown',
            isDecrypted: false, headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1,
            availability: { kind: 'locked', reason: 'invalid_stored_content' } };
        store.getState().applyArtifacts([listed, opaque], store.getState().artifacts, 'browserListed', 'unreadable');
        expect(store.getState().artifactsLoaded).toBe(true);
        expect(isArtifactInventoryReady(store.getState(), 'browserListed')).toBe(false);
        store.getState().deleteArtifact(opaque.id);
        store.getState().applyArtifacts([listed], store.getState().artifacts, 'browserListed');
        const baseline = store.getState().artifacts;
        store.getState().addArtifact({ ...opaque, kindHint: 'approval_request.v1' });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(true);
        store.getState().updateArtifact({ ...opaque, headerVersion: 2 });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().applyArtifacts([listed], baseline, 'browserListed');
        expect(store.getState().artifacts.opaque).toMatchObject({ headerVersion: 2 });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().deleteArtifact(opaque.id);
        store.getState().applyArtifacts([listed], store.getState().artifacts, 'browserListed');
        const beforeUnknown = store.getState().artifacts;
        const { kindHint: _kindHint, ...unclassified } = opaque;
        store.getState().addArtifact({ ...unclassified, id: 'unknown' });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().applyArtifacts([listed], beforeUnknown, 'browserListed');
        expect(store.getState().artifacts.unknown).toBeDefined();
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
    });

    it('preserves an unchanged unresolved opaque row without certifying complete browser counts', () => {
        const store = createHarness();
        const opaque: DecryptedArtifact = { id: 'opaque-private-or-removed', title: null, header: null, rawHeader: null, storageMode: 'e2ee', isDecrypted: false,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        const listed = { ...artifact(1), header: { title: 'Document', kind: 'markdown' },
            rawHeader: { title: 'Document', kind: 'markdown' }, access: 'owner' as const };
        store.getState().applyArtifacts([opaque, listed]);
        const baseline = store.getState().artifacts;
        store.getState().applyArtifacts([listed], baseline, 'browserListed');
        expect(store.getState().artifacts[opaque.id]).toBe(opaque);
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        expect(isArtifactInventoryLoaded(store.getState())).toBe(false);
    });

    it.each(['partial', 'unreadable'] as const)('fences %s observations and reconciles absence only after exhaustion', publication => {
        const store = createHarness();
        const unseen: DecryptedArtifact = { ...artifact(1), access: 'owner', rawHeader: { kind: 'prompt_doc.v2' } };
        const deleted = artifact(3);
        store.getState().applyArtifacts([unseen, deleted]);
        const baseline = store.getState().artifacts;
        store.getState().deleteArtifact(deleted.id);
        const locked: DecryptedArtifact = { id: 'opaque', title: null, header: null, createdAt: 2, updatedAt: 2,
            headerVersion: 1, seq: 2, storageMode: 'plain', isDecrypted: false,
            availability: { kind: 'locked', reason: 'invalid_stored_content' } };
        const kinds = ['prompt_doc.v2'];
        store.getState().applyArtifacts([locked, deleted], baseline, kinds, publication);
        const state = store.getState();
        expect(state.artifacts[unseen.id]).toBe(publication === 'unreadable' ? undefined : unseen);
        expect(state.artifacts[deleted.id]).toBeUndefined();
        expect(state.artifacts.opaque).toBe(locked);
        expect(state.artifactInventoryUnreadyCount).toBe(1);
        expect(state.artifactInventoryKindsLoaded).toEqual([]);
        expect(isArtifactInventoryLoaded(state, kinds)).toBe(false);
        expect(isArtifactInventoryReady(state, kinds)).toBe(publication === 'unreadable');
        expect(isArtifactInventoryReady(state)).toBe(false);
        store.getState().applyArtifacts([locked, deleted], baseline, kinds, publication);
        expect(store.getState()).toBe(state);
    });

    it('reconciles exact-kind membership without evicting other kinds or claiming a full inventory', () => {
        const store = createHarness();
        const doc = (id: number) => ({ ...artifact(id), header: { kind: 'prompt_doc.v2', title: 'Prompt' }, rawHeader: { kind: 'prompt_doc.v2' } });
        const unrelated = { ...artifact(9), header: { kind: 'markdown', title: 'Unrelated' }, rawHeader: { kind: 'markdown' } };
        store.getState().applyArtifacts([doc(1), doc(2), doc(3), unrelated]);
        const baseline = store.getState().artifacts;
        store.getState().updateArtifact({ ...doc(2), headerVersion: 2, title: 'Concurrent change' });
        store.getState().deleteArtifact(doc(3).id);
        store.getState().addArtifact(doc(4));
        store.getState().applyArtifacts([doc(3), doc(5)], baseline, ['prompt_doc.v2']);
        expect(Object.keys(store.getState().artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5', 'artifact-9']);
        expect(store.getState().artifacts['artifact-9']).toBe(unrelated);
        expect(store.getState().artifactsLoaded).toBe(false);
        expect(store.getState().artifactInventoryKindsLoaded).toEqual(['prompt_doc.v2']);
        const current = store.getState();
        store.getState().applyArtifacts(Object.values(current.artifacts).filter(row => row.rawHeader?.kind === 'prompt_doc.v2'),
            current.artifacts, ['prompt_doc.v2']);
        expect(store.getState()).toBe(current);
        store.getState().applyArtifacts(Object.values(current.artifacts), current.artifacts);
        expect(store.getState().artifactsLoaded).toBe(true);
    });
    it('publishes skill inventory only for changed skill revisions and tracks incomplete inventory through removal', () => {
        const store = createHarness();
        const skills = Array.from({ length: 139 }, (_, i) => ({ ...artifact(i),
            header: { title: `Skill ${i}`, kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' },
            rawHeader: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, access: 'owner' as const, bodyVersion: 1 }));
        const documents = Array.from({ length: 1000 }, (_, i) => ({ ...artifact(i + 139),
            header: { title: 'Document', kind: 'markdown' }, rawHeader: { kind: 'markdown' }, access: 'owner' as const }));
        store.getState().applyArtifacts([...skills, ...documents]);
        const before = store.getState().artifactSkillRevisions;
        let notifications = 0;
        const off = store.subscribe((state, previous) => { if (state.artifactSkillRevisions !== previous.artifactSkillRevisions) notifications++; });
        try {
            for (const document of documents.slice(0, 10)) store.getState().updateArtifact({ ...document, bodyVersion: 2 });
            expect(notifications).toBe(0);
            expect(Object.keys(before)).toHaveLength(139);
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().updateArtifact({ ...skills[0]!, bodyVersion: 2 });
            expect(notifications).toBe(1);
            expect(store.getState().artifactSkillRevisions[skills[0]!.id]).toBe('artifact-0@1:2');
            store.getState().addArtifact({ id: 'locked-role', kindHint: 'role.v1', title: null,
                headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee', isDecrypted: false,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().addArtifact(artifact(2000));
            expect(store.getState().artifactInventoryUnreadyCount).toBe(1);
            store.getState().deleteArtifact('artifact-2000');
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().deleteArtifact(skills[0]!.id);
            expect(Object.keys(store.getState().artifactSkillRevisions)).toHaveLength(138);
            const readStartedWith = store.getState().artifacts;
            store.getState().applyArtifacts([], readStartedWith);
            expect(store.getState().artifactSkillRevisions).toEqual({});
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
        } finally { off(); }
    });
    it('retains unchanged Artifact slices when exact board or workflow reads hydrate or revise a body', () => {
        const store = createHarness();
        const head = { ...artifact(1), storageMode: 'plain', access: 'owner', ownerAccountId: 'owner',
            bodyVersion: 1, header: { title: 'Board', kind: 'work-board.v1', sessions: ['session'] },
            rawHeader: { title: 'Board', kind: 'work-board.v1', sessions: ['session'] }, sessions: ['session'],
            storageIdentity: { contentKeyEnvelope: 'plain', provenanceKeyEnvelope: null } } satisfies Extract<DecryptedArtifact, { isDecrypted: true }>;
        store.getState().applyArtifacts([head]);
        store.getState().updateArtifact({ ...structuredClone(head), body: 'Loaded board' });
        const loaded = store.getState().artifacts[head.id];
        expect(loaded.header).toBe(head.header);
        expect(loaded.rawHeader).toBe(head.rawHeader);
        expect(loaded.sessions).toBe(head.sessions);
        expect(loaded.storageIdentity).toBe(head.storageIdentity);
        const before = store.getState();
        const notify = vi.fn();
        const off = store.subscribe(notify);
        try {
            store.getState().updateArtifact(structuredClone(loaded));
            expect(store.getState()).toBe(before);
            expect(notify).not.toHaveBeenCalled();
            if (!loaded.isDecrypted) throw new Error('Expected readable board');
            store.getState().updateArtifact({ ...structuredClone(loaded), bodyVersion: 2, body: 'Revised board' });
            expect(store.getState().artifacts[head.id].header).toBe(head.header);
            expect(store.getState().artifacts[head.id].body).toBe('Revised board');
            expect(notify).toHaveBeenCalledTimes(1);
        } finally { off(); }
    });

    it('keeps opened content when an inventory adds exact header evidence without changing key custody', () => {
        const store = createHarness();
        const loaded = { ...artifact(1), storageMode: 'e2ee' as const, access: 'owner' as const, ownerAccountId: 'owner',
            bodyVersion: 1, body: 'Opened body', rawHeader: { title: 'Artifact 1' },
            storageIdentity: { contentKeyEnvelope: 'content', provenanceKeyEnvelope: null } };
        store.getState().applyArtifacts([loaded]);
        const head = { ...loaded, body: undefined,
            storageIdentity: { ...loaded.storageIdentity, header: 'exact stored header' } };
        store.getState().applyArtifacts([head]);
        expect(store.getState().artifacts[loaded.id]?.body).toBe('Opened body');
        store.getState().applyArtifacts([{ ...head,
            storageIdentity: { ...head.storageIdentity, contentKeyEnvelope: 'rotated' } }]);
        expect(store.getState().artifacts[loaded.id]?.body).toBeUndefined();
    });

    it('does not claim inventory readiness for a targeted body publication', () => {
        const store = createHarness();
        store.getState().applyArtifacts([{ ...artifact(1), body: 'Demanded approval' }]);
        expect(store.getState().artifactsLoaded).toBe(false);
        expect(store.getState().artifacts['artifact-1']?.body).toBe('Demanded approval');
    });

    it('reconciles full inventory membership while preserving writes and deletes since the read began', () => {
        const store = createHarness();
        store.getState().applyArtifacts([artifact(1), artifact(2), artifact(3)]);
        const readStartedWith = store.getState().artifacts;
        store.getState().updateArtifact({ ...artifact(2), headerVersion: 2 });
        store.getState().addArtifact(artifact(4));
        store.getState().deleteArtifact('artifact-3');
        store.getState().applyArtifacts([artifact(3), artifact(5)], readStartedWith);
        expect(store.getState().artifactsLoaded).toBe(true);
        expect(Object.keys(store.getState().artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5']);
        expect(store.getState().artifacts['artifact-2']?.headerVersion).toBe(2);
        const before = store.getState();
        store.getState().applyArtifacts([], before.artifacts);
        expect(store.getState().artifacts).toEqual({});
        expect(store.getState().artifactsStorageRevision).toBe(before.artifactsStorageRevision + 1);
    });
    it('retains HTTP access and ownership across content-only socket creation and revision echoes without granting initial events', async () => {
        const store = createHarness();
        const decode = (version: number) => decryptSocketNewArtifactUpdate({
            artifactId: 'socket-artifact', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Socket document' }),
            body: encodePlainArtifactStoredContent({ body: 'Revision content' }),
            headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version,
            encryption: null, artifactDataKeys: new Map(),
        });
        const initial = await decode(1);
        if (!initial) throw new Error('Expected readable socket Artifact');
        store.getState().addArtifact(initial);
        expect(store.getState().artifacts[initial.id]?.access).toBeUndefined();
        expect(store.getState().artifacts[initial.id]?.ownerAccountId).toBeUndefined();
        store.getState().applyArtifacts([{ ...initial, access: 'owner', ownerAccountId: 'owner' }]);
        store.getState().addArtifact(initial);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner' });
        const revised = await decode(2);
        if (!revised) throw new Error('Expected readable revised Artifact');
        store.getState().addArtifact(revised);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner', bodyVersion: 2 });
        store.getState().applyArtifacts([{ ...revised, access: 'view', ownerAccountId: 'different-owner' }]);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'view', ownerAccountId: 'different-owner' });
    });
    it('retains decoded E2EE content only while revision and exact key custody remain unchanged', async () => {
        const store = createHarness();
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const key = new Uint8Array(32).fill(8);
        const codec = new ArtifactEncryption(key);
        const wrap = () => encryption.encryptEncryptionKey(key).then(value => encodeBase64(value));
        const encrypted: Artifact = { id: 'encrypted', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            header: await codec.encryptHeader({ title: 'Encrypted' }), body: await codec.encryptBody({ body: 'Private' }),
            dataEncryptionKey: await wrap(), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const params = { encryption, artifactDataKeys: new Map() };
        const opened = await decryptArtifactWithBody({ ...params, artifact: encrypted });
        if (!opened) throw new Error('Expected opened Artifact');
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const publications = vi.fn();
        store.subscribe(publications);
        const echo = await decryptArtifactListItem({ ...params, artifact: { ...encrypted, body: undefined } });
        if (!echo) throw new Error('Expected list header');
        store.getState().applyArtifacts([echo]);
        console.info('B07 E2EE unchanged-head publications:', publications.mock.calls.length);
        expect(store.getState()).toBe(before);
        expect(publications).toHaveBeenCalledTimes(0);
        const rotated = await decryptArtifactListItem({ ...params, artifact: { ...encrypted, body: undefined, dataEncryptionKey: await wrap() } });
        if (!rotated) throw new Error('Expected rotated list header');
        store.getState().applyArtifacts([rotated]);
        expect(store.getState().artifacts.encrypted?.body).toBeUndefined();
        expect(publications).toHaveBeenCalledTimes(1);
    });
    it('retains an opened plain body and row identity through an unchanged header-only echo', () => {
        const store = createHarness();
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'plain', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, body: 'Already opened content',
            provenance: { savedBy: { kind: 'person', accountId: 'owner' } } };
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const notify = vi.fn();
        store.subscribe(notify);

        const { provenance: _provenance, ...headerOnly } = structuredClone(opened);
        store.getState().applyArtifacts([{ ...headerOnly, body: undefined }]);
        console.info('B07 plain unchanged-head publications:', notify.mock.calls.length);

        expect(store.getState().artifacts[opened.id]?.body).toBe(opened.body);
        expect(store.getState().artifacts[opened.id]?.provenance).toEqual(opened.provenance);
        expect(store.getState().artifacts[opened.id]).toBe(opened);
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
    });

    it('retains demanded provenance without a body only while exact revision and custody remain unchanged', () => {
        const store = createHarness();
        const provenance = { savedBy: { kind: 'person' as const, accountId: 'owner' } };
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'e2ee', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, provenance,
            storageIdentity: { contentKeyEnvelope: 'content', provenanceKeyEnvelope: 'private' } };
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const { provenance: _provenance, ...head } = opened;
        store.getState().applyArtifacts([head]);
        expect(store.getState()).toBe(before);
        store.getState().applyArtifacts([{ ...head, provenance: undefined }]);
        expect(store.getState().artifacts[opened.id]?.provenance).toBeUndefined();
        expect(Object.hasOwn(store.getState().artifacts[opened.id], 'provenance')).toBe(true);
        const cleared = store.getState();
        store.getState().applyArtifacts([head]);
        expect(store.getState()).toBe(cleared);
        store.getState().applyArtifacts([opened]);
        store.getState().applyArtifacts([{ ...head, storageIdentity: { ...head.storageIdentity!, provenanceKeyEnvelope: 'rotated' } }]);
        expect(store.getState().artifacts[opened.id]?.provenance).toBeUndefined();
    });

    it.each([
        { bodyVersion: 3 },
        { headerVersion: 2 },
        { storageMode: 'e2ee' as const },
        { access: 'view' as const },
        { ownerAccountId: 'another-owner' },
    ])('does not retain opened content after an incoming authority or revision change: %j', (change) => {
        const store = createHarness();
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'plain', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, body: 'Private content' };
        store.getState().applyArtifacts([opened]);
        store.getState().applyArtifacts([{ ...opened, ...change, body: undefined }]);
        expect(store.getState().artifacts[opened.id]?.body).toBeUndefined();
    });

    it('publishes the loaded transition once and suppresses empty, identical and decoded no-ops', () => {
        const store = createHarness();
        const notify = vi.fn();
        store.subscribe(notify);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(notify).toHaveBeenCalledTimes(1);
        const board = { ...artifact(1), header: { kind: 'work-board.v1', title: 'Board' } };
        store.getState().addArtifact(board);
        const before = store.getState();
        const boardChanged = vi.fn();
        store.subscribe((state) => { if (state.artifacts[board.id] !== before.artifacts[board.id]) boardChanged(); });
        notify.mockClear();
        store.getState().applyArtifacts([board]);
        store.getState().updateArtifact(structuredClone(board));
        store.getState().addArtifact(structuredClone(board));
        store.getState().deleteArtifact('missing');
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
        expect(boardChanged).not.toHaveBeenCalled();
        for (const change of [{ body: 'new body' }, { access: 'view' as const }, { headerVersion: 2 },
            { publicAudience: 'unknown' as const }, { publicAudience: 'none' as const }]) {
            const current = store.getState().artifacts[board.id];
            if (!current?.isDecrypted) throw new Error('Expected readable Board');
            store.getState().updateArtifact({ ...current, ...change });
        }
        expect(notify).toHaveBeenCalledTimes(5);
        const unrelated = artifact(2);
        store.getState().addArtifact(unrelated);
        store.getState().updateArtifact({ ...store.getState().artifacts[board.id]!, updatedAt: 5 });
        expect(store.getState().artifacts[unrelated.id]).toBe(unrelated);
    });

    it('keeps an old open approval discoverable through list hydration, catch-up and resolution beyond 500 heads', () => {
        const store = createHarness();
        const approval = ApprovalRequestV1Schema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
        });
        const head: DecryptedArtifact = { ...artifact(0), header: buildApprovalRequestArtifactHeaderV1(approval),
            body: JSON.stringify(approval), bodyVersion: 1 };
        const openApprovals = () => Object.values(store.getState().artifacts).filter(isOpenApprovalInboxArtifact);
        store.getState().applyArtifacts([head, ...Array.from({ length: 550 }, (_, index) => artifact(index + 1))]);
        expect(Object.keys(store.getState().artifacts)).toHaveLength(551);
        expect(openApprovals()).toEqual([head]);
        store.getState().applyArtifacts([artifact(600)]);
        expect(openApprovals()).toEqual([head]);
        const resolved = { ...approval, status: 'executed' as const };
        store.getState().updateArtifact({ ...head, header: buildApprovalRequestArtifactHeaderV1(resolved),
            body: JSON.stringify(resolved), bodyVersion: 2 });
        expect(openApprovals()).toEqual([]);
        store.setState({ artifacts: {}, artifactsLoaded: false });
        store.getState().applyArtifacts([artifact(700)]);
        expect(openApprovals()).toEqual([]);
    });

    it('does not reopen a settled approval when an earlier header or body read arrives late', () => {
        const store = createHarness();
        const open = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const old: DecryptedArtifact = { ...artifact(1), header: buildApprovalRequestArtifactHeaderV1(open),
            body: JSON.stringify(open), headerVersion: 1, bodyVersion: 1 };
        const settled = ApprovalRequestV1Schema.parse({ ...open, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        const current: DecryptedArtifact = { ...old, header: buildApprovalRequestArtifactHeaderV1(settled),
            body: JSON.stringify(settled), headerVersion: 2, bodyVersion: 2 };
        store.getState().applyArtifacts([current]);
        const before = store.getState();
        store.getState().applyArtifacts([{ ...old, body: undefined }]);
        store.getState().applyArtifacts([old]);
        store.getState().addArtifact(old);
        expect(store.getState()).toBe(before);
        expect(isOpenApprovalInboxArtifact(store.getState().artifacts[old.id]!)).toBe(false);
    });
});
