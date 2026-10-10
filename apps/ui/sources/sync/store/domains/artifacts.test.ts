import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { createArtifactsDomain, type ArtifactsDomain } from './artifacts';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { decryptArtifactListItem, decryptArtifactWithBody, decryptSocketNewArtifactUpdate } from '@/sync/engine/artifacts/syncArtifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

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

        store.getState().applyArtifacts([{ ...structuredClone(opened), body: undefined }]);
        console.info('B07 plain unchanged-head publications:', notify.mock.calls.length);

        expect(store.getState().artifacts[opened.id]?.body).toBe(opened.body);
        expect(store.getState().artifacts[opened.id]?.provenance).toEqual(opened.provenance);
        expect(store.getState().artifacts[opened.id]).toBe(opened);
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
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
        store.getState().applyArtifacts([]);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().applyArtifacts([]);
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
        for (const change of [{ body: 'new body' }, { access: 'view' as const }, { headerVersion: 2 }]) {
            const current = store.getState().artifacts[board.id];
            if (!current?.isDecrypted) throw new Error('Expected readable Board');
            store.getState().updateArtifact({ ...current, ...change });
        }
        expect(notify).toHaveBeenCalledTimes(3);
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
});
