import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { Encryption } from '@/sync/encryption/encryption';
import { resetNativeCryptoWorkerCapabilityCacheForTests } from '@/sync/encryption/nativeCryptoWorker/nativeCryptoWorkerRouting';
import { resetNativeCryptoWorkerQueueLifecycleForTests } from '@/sync/encryption/nativeCryptoWorker/nativeCryptoWorkerQueue';
import { resetDefaultNativeCryptoWorkerRoutingForTests } from '@/sync/encryption/nativeCryptoWorker/nativeCryptoWorkerRoutingConfig';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { patchInboxArtifactOrder, projectInboxArtifactItems, readInboxArtifactEntry, type InboxArtifactEntry } from '@/sync/domains/artifacts/inboxArtifacts';

import { fetchAndApplyArtifactsList, type ArtifactDataKeyCache } from './syncArtifacts';

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ROWS = 12;

/**
 * Real Account Encryption and real artifact crypto; only HTTP is substituted.
 * The read's own caller stays current throughout: what is withdrawn is the
 * Account material's currentness while the unwrap is in flight, which makes
 * the owner stop the opening (a cancelled read), not refuse an envelope.
 */
async function createFixture() {
    const encryption = await Encryption.create(new Uint8Array(32).fill(41));
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    let materialCurrent = true;
    encryption.bindAccountMaterialCurrentness(() => materialCurrent);
    const rows = await Promise.all(Array.from({ length: ROWS }, async (_, index) => {
        const dataKey = new Uint8Array(32).fill(index + 1);
        const id = `artifact-${index}`;
        return {
            id,
            ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: 'e2ee' as const,
            header: await new ArtifactEncryption(dataKey).encryptHeader({ v: 1, kind: 'artifact.legacy', title: `title-${index}` } as never),
            headerVersion: 1,
            body: undefined,
            bodyVersion: undefined,
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'),
            seq: 1,
            createdAt: 0,
            updatedAt: index,
        };
    }));
    // The store as the Inbox reads it: each publication replaces rows by id and
    // maintains the Inbox order through the count owner, as store ingress does.
    const store = new Map<string, DecryptedArtifact>();
    const inboxEntries = new Map<string, InboxArtifactEntry>();
    let inboxOrder: readonly InboxArtifactEntry[] = [];
    const applyArtifacts = (artifacts: DecryptedArtifact[]) => {
        const changes = artifacts.map(artifact => {
            store.set(artifact.id, artifact);
            const previous = inboxEntries.get(artifact.id);
            const next = readInboxArtifactEntry(artifact) ?? undefined;
            if (next) inboxEntries.set(artifact.id, next); else inboxEntries.delete(artifact.id);
            return { previous, next };
        });
        inboxOrder = patchInboxArtifactOrder(inboxOrder, changes);
    };
    const read = (options: Readonly<{ artifactDataKeys: ArtifactDataKeyCache; withdrawMaterialDuringRead?: boolean }>) =>
        fetchAndApplyArtifactsList({
            credentials: { token: 't', secret: 's' } as never,
            encryption,
            artifactDataKeys: options.artifactDataKeys,
            applyArtifacts,
            request: async () => {
                if (options.withdrawMaterialDuringRead) materialCurrent = false;
                return Response.json(rows);
            },
        });
    const counts = () => {
        const all = [...store.values()];
        return {
            locked: all.filter(artifact => artifact.availability?.kind === 'locked').length,
            decrypted: all.filter(artifact => artifact.isDecrypted).length,
            badgeCertified: projectInboxArtifactItems(inboxOrder, 'owner').complete,
        };
    };
    return { read, counts, restoreMaterial: () => { materialCurrent = true; } };
}

describe('fetchAndApplyArtifactsList with a cancelled data-key unwrap', () => {
    beforeEach(() => {
        resetDefaultNativeCryptoWorkerRoutingForTests();
        resetNativeCryptoWorkerCapabilityCacheForTests();
        resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('keeps last-good rows and publishes no locked row when the unwrap is cancelled, then opens every row', async () => {
        const fixture = await createFixture();
        await fixture.read({ artifactDataKeys: new Map() });
        expect(fixture.counts()).toEqual({ locked: 0, decrypted: ROWS, badgeCertified: true });

        // A cold key cache (as after a reload that restored the rows) with a read
        // whose unwrap is cancelled while it is in flight.
        await fixture.read({ artifactDataKeys: new Map(), withdrawMaterialDuringRead: true }).catch(() => undefined);
        expect(fixture.counts()).toEqual({ locked: 0, decrypted: ROWS, badgeCertified: true });

        fixture.restoreMaterial();
        await fixture.read({ artifactDataKeys: new Map() });
        expect(fixture.counts()).toEqual({ locked: 0, decrypted: ROWS, badgeCertified: true });
    });

    // P03-INBOX3 / P03-ENC-GENERATION: live /inbox, a Session row hydrating with its newly readable key
    // advanced the Account generation during the cold Inbox census and cancelled the census page's pending
    // data-key batch. A Session key change now moves no Account generation, so the one batch completes.
    it('completes a read data-key batch in one opening when a Session key change lands mid-read', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(43));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const count = 400;
        const rows = await Promise.all(Array.from({ length: count }, async (_, index) => {
            const dataKey = new Uint8Array(32).fill((index % 250) + 1);
            return {
                id: `artifact-${index}`, ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: 'e2ee' as const,
                header: await new ArtifactEncryption(dataKey).encryptHeader({ v: 1, kind: 'artifact.legacy', title: `t-${index}` } as never),
                headerVersion: 1, body: undefined, bodyVersion: undefined,
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'),
                seq: 1, createdAt: 0, updatedAt: index,
            };
        }));
        await encryption.initializeSessions(new Map([['session-1', null]]));
        const before = encryption.getCurrentGeneration();
        const applied: DecryptedArtifact[] = [];
        let requests = 0;
        const read = fetchAndApplyArtifactsList({
            credentials: { token: 't', secret: 's' } as never, encryption, artifactDataKeys: new Map(),
            applyArtifacts: artifacts => { applied.push(...artifacts); },
            request: async () => {
                requests += 1;
                // The Session's own key becomes readable while this page's keys are opening.
                setTimeout(() => { void encryption.initializeSessions(new Map([['session-1', new Uint8Array(32).fill(7)]])); }, 0);
                return Response.json(rows);
            },
        });
        const outcome = await read.then(() => 'resolved', (error: unknown) => (error as Error).name);
        const counts = { outcome, requests, generationAdvanced: encryption.getCurrentGeneration() > before,
            decrypted: applied.filter(row => row.isDecrypted).length, locked: applied.filter(row => !row.isDecrypted).length };
        console.log('ENC-GENERATION Session key change mid-read', JSON.stringify(counts));
        expect(counts).toEqual({ outcome: 'resolved', requests: 1, generationAdvanced: false, decrypted: count, locked: 0 });
    });
});

