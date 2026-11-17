import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import * as z from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDataKeyAccountEncryptionCurrentnessFixture, createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { MachineContentKeyTransitionInputV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachineRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { encryptLegacy } from '../../../../../cli/src/api/encryption';
import { prepareMachineDataKeyEnvelopesForScope, prepareMachineDataKeyEnvelopesForMachines } from './machineDataKeyEnvelopesApi';
import { createMachineFixture, createDeferred } from '@/dev/testkit';
import { executeMachineAccessHttpAction } from './machineAccessApi';
import { Encryption } from '@/sync/encryption/encryption';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { flushHookEffects } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { readScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';

await loadSyncSingletonForTests();

describe('captured Machine recipient preparation transport', () => {
    it('runs one exact preparation pass for a cold row without a recipient-work fact', async () => {
        const secret = new Uint8Array(32).fill(62);
        const author = await Encryption.create(secret);
        author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const id = 'recipient-unknown-fact';
        const key = new Uint8Array(32).fill(11);
        await author.initializeMachines(new Map([[id, key]]));
        const envelope = encodeBase64(await author.encryptEncryptionKey(key));
        const machine = createMachineFixture({ id, storageMode: 'e2ee',
            access: { custodian: { accountId: 'carol', displayName: 'Carol' }, role: 'manage',
                resourceMode: 'e2ee', accessState: 'ready' } });
        const row = { ...machine, kind: 'persistent' as const, revokedAt: null, replacedByMachineId: null,
            metadata: await author.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
            metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: envelope, keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 0 } };
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://recipient-unknown-fact.test',
            accountId: 'alice', accountMode: 'e2ee',
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } }],
            route: request => request.path.endsWith('/data-key-envelopes') ? Response.json({
                machineId: id, custodianAccountId: 'carol', encryptionMode: 'e2ee',
                machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(envelope)),
                callerDataEncryptionKey: envelope, nextCursor: null,
                content: { metadata: row.metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, recipients: [],
            }) : undefined });
        try {
            await prepareMachineDataKeyEnvelopesForMachines({ scope: { serverId: home.homes.resource!.id, accountId: 'alice' },
                machines: [row], publishedRows: [row], recipientChangeCursors: new Map(), isCurrent: () => true });
            expect(home.requests.filter(request => request.path.endsWith('/data-key-envelopes')).map(request => request.method))
                .toEqual(['GET', 'GET']);
        } finally { await home.dispose(); }
    });

    it('reads only pending recipient work across cold start, navigation and recipient changes', async () => {
        const secret = new Uint8Array(32).fill(61);
        const author = await Encryption.create(secret);
        author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const ids = Array.from({ length: 128 }, (_, index) => `recipient-scale-${index}`);
        const keys = new Map(ids.map((id, index) => [id, new Uint8Array(32).fill((index % 200) + 1)]));
        await author.initializeMachines(keys);
        const access = { custodian: { accountId: 'carol', displayName: 'Carol' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        let revision = 1;
        let machines = await Promise.all(ids.map(async id => {
            const machine = createMachineFixture({ id, access, storageMode: 'e2ee' });
            const envelope = encodeBase64(await author.encryptEncryptionKey(keys.get(id)!));
            return { ...machine, kind: 'persistent' as const, revokedAt: null, replacedByMachineId: null,
                metadata: await author.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
                metadataVersion: revision, daemonState: null, daemonStateVersion: revision,
                keyBasis: { dataEncryptionKey: envelope, metadataVersion: revision, daemonStateVersion: revision },
                dataEncryptionKey: envelope, recipientWorkPending: false, recipientWorkCursor: 0 };
        }));
        const rowsById = () => new Map(machines.map(machine => [machine.id, machine]));
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://recipient-scale.test',
            accountId: 'alice', accountMode: 'e2ee',
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } }],
            route: request => {
                if (!request.path.endsWith('/data-key-envelopes')) return undefined;
                const machine = rowsById().get(request.path.split('/')[3]!);
                if (!machine?.dataEncryptionKey) return Response.json({ kind: 'refused', code: 'machine_unavailable' });
                return Response.json({ machineId: machine.id, custodianAccountId: 'carol', encryptionMode: 'e2ee',
                    machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(machine.keyBasis!.dataEncryptionKey!)),
                    callerDataEncryptionKey: machine.dataEncryptionKey, nextCursor: null,
                    content: { metadata: machine.metadata, metadataVersion: machine.metadataVersion,
                        daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion }, recipients: [] });
            } });
        const scope = { serverId: home.homes.resource!.id, accountId: 'alice' };
        const recipientChangeCursors = new Map<string, number>();
        const reads = () => home.requests.filter(request => request.path.endsWith('/data-key-envelopes'));
        const refresh = () => prepareMachineDataKeyEnvelopesForMachines({ scope, machines, publishedRows: machines,
            recipientChangeCursors, isCurrent: () => true });
        try {
            await refresh();
            expect(reads()).toHaveLength(0);
            for (revision = 2; revision <= 5; revision++) {
                machines = machines.map(machine => ({ ...machine, daemonStateVersion: revision,
                    keyBasis: { ...machine.keyBasis!, daemonStateVersion: revision } }));
                const before = reads().length;
                await refresh();
                expect(reads().length - before).toBe(0);
            }
            const changedId = ids[73]!;
            const pendingIds = new Set([ids[3]!, ids[17]!, changedId]);
            machines = machines.map(machine => ({ ...machine, recipientWorkPending: pendingIds.has(machine.id) }));
            await refresh();
            expect(reads()).toHaveLength(pendingIds.size * 2);
            const beforeNavigation = reads().length;
            await refresh();
            expect(reads()).toHaveLength(beforeNavigation);
            const beforeRecipientChange = reads().length;
            recipientChangeCursors.set(changedId, 1);
            await refresh();
            expect(reads().slice(beforeRecipientChange).map(request => request.path.split('/')[3])).toEqual([changedId, changedId]);
        } finally { await home.dispose(); }
    });

    it('keeps pending recipient work once per real Sync census across warm and hydrated publications, then retries a new census', async () => {
        const secret = new Uint8Array(32).fill(39);
        const author = await Encryption.create(secret);
        author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const ids = ['sync-recipient-a', 'sync-recipient-b'];
        const keys = new Map(ids.map((id, index) => [id, new Uint8Array(32).fill(index + 7)]));
        await author.initializeMachines(keys);
        const access = { custodian: { accountId: 'carol', displayName: 'Carol' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const authored = await Promise.all(ids.map(async id => {
            const machine = createMachineFixture({ id, activeAt: Date.now(), access });
            const envelope = encodeBase64(await author.encryptEncryptionKey(keys.get(id)!));
            return { ...machine, kind: 'persistent' as const, revokedAt: null, replacedByMachineId: null,
                metadata: await author.getMachineEncryption(id)!.encryptMetadata(machine.metadata!),
                daemonState: null, daemonStateVersion: 0,
                keyBasis: { dataEncryptionKey: envelope, metadataVersion: 1, daemonStateVersion: 0 },
                dataEncryptionKey: envelope, recipientWorkPending: true, recipientWorkCursor: 0 } satisfies FetchedMachineRow;
        }));
        let rows: readonly FetchedMachineRow[] = [];
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://sync-recipient-pass.test',
            accountId: 'alice', accountMode: 'e2ee',
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } }],
            route: request => {
                if (request.path === '/v1/machines') return Response.json(rows);
                if (!request.path.endsWith('/data-key-envelopes')) return undefined;
                // A current holder's missing recipient key is retryable at the next census,
                // not once for every display/hydration publication of this census.
                return Response.json({ machineId: request.path.split('/')[3], custodianAccountId: 'carol', encryptionMode: 'e2ee',
                    machineOwnerEnvelopeFingerprint: null, callerDataEncryptionKey: null, nextCursor: null,
                    content: { metadata: '', metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, recipients: [] });
            } });
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            rows = authored;
            const reads = () => home.requests.filter(request => request.path.endsWith('/data-key-envelopes'));
            await sync.refreshMachines();
            await vi.waitFor(() => expect(ids.map(id => storage.getState().machines[id]?.metadataVersion)).toEqual([1, 1]));
            await flushHookEffects({ cycles: 12, turns: 2 });
            expect.soft(reads().map(request => request.path.split('/')[3]).sort()).toEqual([...ids].sort());
            await sync.refreshMachines();
            await flushHookEffects({ cycles: 12, turns: 2 });
            expect(reads().map(request => request.path.split('/')[3]).sort()).toEqual([...ids, ...ids].sort());
        } finally { await home.dispose(); }
    });

    it.each(['replaced', 'revoked'] as const)('does not prepare a %s Machine despite a stale Manage-ready projection', async retirement => {
        const secret = new Uint8Array(32).fill(27);
        const terminal = retirement === 'replaced' ? { replacedByMachineId: 'replacement', revokedAt: null }
            : { replacedByMachineId: null, revokedAt: 0 };
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const row = { id: 'retired-machine', ...terminal, storageMode: 'e2ee', dataEncryptionKey: null,
            metadata: encodeBase64(encryptLegacy({ host: 'host', platform: 'linux', happyCliVersion: '0.2',
                homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }, secret)),
            metadataVersion: 1, daemonState: null, daemonStateVersion: 0, access };
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: `https://retired-${retirement}.test`,
            accountId: 'alice', accountMode: 'e2ee',
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } }],
            route: request => request.path === '/v1/machines/retired-machine'
                ? Response.json({ machine: row }) : Response.json({ kind: 'refused', code: 'machine_unavailable' }) });
        const scope = { serverId: home.homes.resource!.id, accountId: 'alice' };
        const machine = createMachineFixture({ id: row.id, ...terminal, access });
        const machineRequests = () => home.requests.filter(request => request.path.startsWith('/v1/machines/'));
        try {
            for (let pass = 0; pass < 3; pass++) {
                await prepareMachineDataKeyEnvelopesForMachines({ scope, machines: [{ ...machine, activeAt: pass }],
                    recipientChangeCursors: new Map([[machine.id, pass]]), isCurrent: () => true });
            }
            expect.soft(machineRequests()).toEqual([]);
            const beforeExplicit = machineRequests().length;
            expect(await prepareMachineDataKeyEnvelopesForScope({ scope, machineId: machine.id }))
                .toEqual({ kind: 'unavailable', code: 'machine_unavailable' });
            expect(machineRequests().slice(beforeExplicit).map(request => [request.method, request.path]))
                .toEqual([['GET', '/v1/machines/retired-machine']]);
        } finally { await home.dispose(); }
    });

    it('retries an unprepared recipient on a later census even under the same current authority', async () => {
        const secret = new Uint8Array(32).fill(27);
        const access = { custodian: { accountId: 'carol', displayName: 'Carol' }, role: 'manage' as const,
            resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        const ids = Array.from({ length: 12 }, (_, index) => `fleet-${index}`);
        const rowFor = (id: string) => ({ id, revokedAt: null, replacedByMachineId: null, storageMode: 'e2ee', dataEncryptionKey: null,
            metadata: encodeBase64(encryptLegacy({ host: id, platform: 'linux', happyCliVersion: '0.2',
                homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }, secret)),
            metadataVersion: 1, daemonState: null, daemonStateVersion: 0, access, recipientWorkPending: true, recipientWorkCursor: 0 });
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://fleet-read.test',
            accountId: 'alice', accountMode: 'e2ee',
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } }],
            // This device does not hold the key yet, so the preparation ends pending rather than prepared.
            route: request => request.path.endsWith('/data-key-envelopes') ? Response.json({
                machineId: request.path.split('/')[3], custodianAccountId: 'carol', encryptionMode: 'e2ee',
                machineOwnerEnvelopeFingerprint: null, callerDataEncryptionKey: null, nextCursor: null,
                content: { metadata: '', metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, recipients: [] })
                : Response.json({ kind: 'refused', code: 'machine_unavailable' }) });
        const scope = { serverId: home.homes.resource!.id, accountId: 'alice' };
        const machines = ids.map(id => createMachineFixture({ id, access }));
        const publishedRows = ids.map(id => ({ ...createMachineFixture({ id, access }), ...rowFor(id) }));
        const isCurrent = () => true;
        try {
            for (let census = 0; census < 3; census++) {
                await prepareMachineDataKeyEnvelopesForMachines({ scope, machines, publishedRows, recipientChangeCursors: new Map(), isCurrent });
            }
            const requests = home.requests.filter(request => request.path.startsWith('/v1/machines/'));
            expect(requests.filter(request => request.path.endsWith('/data-key-envelopes'))).toHaveLength(ids.length * 3);
            expect(requests.filter(request => !request.path.endsWith('/data-key-envelopes'))).toEqual([]);
        } finally { await home.dispose(); }
    });

    it('converts retained historical content through the custodian snapshot when persisted Account mode is plain', async () => {
        const secret = new Uint8Array(32).fill(73);
        const historicalMetadata = { host: 'old-host', platform: 'linux', happyCliVersion: '0.2', homeDir: '/home/owner',
            happyHomeDir: '/home/owner/.happier', displayName: 'Retained workstation' };
        const historicalState = { status: 'stopped' };
        let metadata = encodeBase64(encryptLegacy(historicalMetadata, secret));
        let daemonState = encodeBase64(encryptLegacy(historicalState, secret));
        let envelope: string | null = null;
        let revision = 1;
        let storageMode: 'e2ee' | 'plain' = 'e2ee';
        const row = () => ({ id: 'historical-machine', storageMode, metadata, daemonState,
            dataEncryptionKey: envelope, metadataVersion: revision, daemonStateVersion: revision,
            keyBasis: { dataEncryptionKey: envelope, metadataVersion: revision, daemonStateVersion: revision } });
        const path = '/v1/machines/historical-machine';
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://plain-history.test',
            accountId: 'alice', accountMode: 'plain', encryptionCurrentness: createPlainAccountEncryptionCurrentnessFixture,
            credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret), custody: 'historical' } }],
            route: request => {
                if (request.path === path) return Response.json({ machine: { ...row(), storageMode: 'plain',
                    metadata: storageMode === 'plain' ? metadata : null, daemonState: storageMode === 'plain' ? daemonState : null,
                    access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain',
                        accessState: storageMode === 'plain' ? 'ready' : 'refused' } } });
                if (request.path === `${path}/content-key/transition`) {
                    if (request.method === 'GET') return Response.json({ machine: row() });
                    const input = MachineContentKeyTransitionInputV1Schema.parse(request.body);
                    expect(input.expected).toEqual(row().keyBasis);
                    envelope = input.next.dataEncryptionKey;
                    metadata = input.next.metadata;
                    daemonState = input.next.daemonState!;
                    revision++;
                    storageMode = 'plain';
                    return Response.json({ kind: 'committed', machine: row() });
                }
                if (request.path === `${path}/data-key-envelopes`) return storageMode === 'plain'
                    ? Response.json({ machineId: 'historical-machine', custodianAccountId: 'alice', encryptionMode: 'plain',
                        machineOwnerEnvelopeFingerprint: null, callerDataEncryptionKey: null, nextCursor: null, recipients: [],
                        content: { metadata, metadataVersion: revision, daemonState, daemonStateVersion: revision } })
                    : Response.json({ kind: 'refused', code: 'access_denied' });
                return undefined;
            } });
        try {
            expect(await prepareMachineDataKeyEnvelopesForScope({
                scope: { serverId: home.homes.resource!.id, accountId: 'alice' }, machineId: 'historical-machine',
            })).toEqual({ kind: 'prepared' });
            expect(envelope).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
            expect(decodePlainMachineStoredContent(metadata)).toEqual(historicalMetadata);
            expect(decodePlainMachineStoredContent(daemonState)).toEqual(historicalState);
            expect(readScopedAccountEncryption(home.homes.resource!.id)).toBeNull();
            expect(home.requests.filter(request => request.path.startsWith(path)).map(request => [request.method, request.path]))
                .toEqual([['GET', path], ['GET', `${path}/content-key/transition`],
                    ['POST', `${path}/content-key/transition`], ['GET', `${path}/data-key-envelopes`]]);
        } finally { await home.dispose(); }
    });

    it.each(['dataKey', 'legacy', 'mixed-legacy', 'malformed-present', 'lost-ack'] as const)('prepares %s custody under the resource Home and preserves edited content', async variant => {
        const secret = new Uint8Array(32).fill(27);
        const usesDataKey = variant === 'dataKey' || variant === 'lost-ack';
        const owner = usesDataKey ? nacl.box.keyPair() : nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret));
        const recipient = nacl.box.keyPair();
        const signing = nacl.sign.keyPair();
        // Observed ../0.2 f2dd8f01185784676b639cec5cf8a5ed79973301 legacy factory:
        // recovery-secret ciphertext, encryptionVariant='legacy', dataEncryptionKey=null.
        let ownerEnvelope: string | null = usesDataKey ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: owner.secretKey, recipientPublicKey: owner.publicKey, randomBytes: nacl.randomBytes }))
            : variant === 'malformed-present' ? encodeBase64(new Uint8Array([0, 1, 2])) : null;
        const editedMetadata = { host: 'host', platform: 'linux', happyCliVersion: '0.2', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier', displayName: 'Edited workstation', username: 'alice' };
        const editedState = { status: 'running', pid: 42, httpPort: 4321 };
        let metadata = encodeBase64(usesDataKey ? (await new AES256Encryption(owner.secretKey).encrypt([editedMetadata]))[0]! : encryptLegacy(editedMetadata, secret));
        let daemonState = encodeBase64(usesDataKey ? (await new AES256Encryption(owner.secretKey).encrypt([editedState]))[0]! : encryptLegacy(editedState, secret));
        let revision = 3;
        let delivered: Uint8Array | null = null;
        let recipientBindingAvailable = true;
        let censusGate: Promise<void> | undefined;
        let censusEntered: (() => void) | undefined;
        const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
        const row = () => ({ id: 'machine', dataEncryptionKey: ownerEnvelope, metadata, metadataVersion: revision, daemonState, daemonStateVersion: revision,
            keyBasis: { dataEncryptionKey: ownerEnvelope, metadataVersion: revision, daemonStateVersion: revision },
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage' as const, resourceMode: 'e2ee' as const, accessState: 'ready' as const } });
        const home = await serveAccountHomes({ homes: [
            { key: 'resource', serverUrl: 'https://machine-custodian.test', accountId: 'alice', accountMode: 'e2ee',
                encryptionCurrentness: () => usesDataKey
                    ? createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: owner.secretKey, publicKey: owner.publicKey })
                    : createLegacyAccountEncryptionCurrentnessFixture({ secret }),
                credentials: usesDataKey ? { token: createAccountTokenForTests('alice'), encryption: { publicKey: encodeBase64(owner.publicKey), machineKey: encodeBase64(owner.secretKey) } }
                    : { token: createAccountTokenForTests('alice'), secret: encodeBase64(secret) } },
            { key: 'focused', serverUrl: 'https://machine-focused-custodian.test', accountId: 'cara' },
        ], route: async request => {
            if (request.home !== 'resource') return undefined;
            if (request.path.endsWith('/data-key-envelopes') && request.method === 'GET' && censusGate) {
                censusEntered?.();
                await censusGate;
            }
            if (request.path === '/v1/machines/machine/access' && request.method === 'PUT') return Response.json({
                kind: 'saved', grant: { machineId: 'machine', principal: { kind: 'team', teamId: 'mixed-team' }, level: 'view' },
                readiness: 'refused', canPrepareKeys: true,
            });
            if (request.path === '/v1/machines/machine') return Response.json({ machine: row() });
            if (request.path.endsWith('/content-key/transition')) {
                const input = MachineContentKeyTransitionInputV1Schema.parse(request.body);
                expect(input.expected).toEqual(row().keyBasis);
                ownerEnvelope = input.next.dataEncryptionKey;
                metadata = input.next.metadata;
                daemonState = input.next.daemonState!;
                revision++;
                if (variant === 'lost-ack') throw new TypeError('Connection lost after commit');
                return Response.json({ kind: 'committed', machine: row() });
            }
            if (request.path.endsWith('/data-key-envelopes') && request.method === 'PATCH') {
                const input = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse({ machineId: 'machine',
                    ...lazyZodSchema(() => z.omit(MachineRecipientKeyEnvelopeCommitInputV1Schema, { machineId: true })).parse(request.body) });
                expect(input.expectedCallerDataEncryptionKey).toBe(ownerEnvelope);
                expect(input.expectedMachineOwnerEnvelopeFingerprint).toBe(computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope!)));
                expect(input.expectedMetadataVersion).toBe(revision);
                delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
                return Response.json({ appliedRecipientAccountIds: ['bob'], skippedRecipientAccountIds: [] });
            }
            if (request.path.endsWith('/data-key-envelopes') && (!ownerEnvelope || variant === 'malformed-present')) return Response.json({ kind: 'refused', code: 'encryption_material_unavailable' }, { status: 409 });
            if (request.path.endsWith('/data-key-envelopes')) return Response.json({ machineId: 'machine', custodianAccountId: 'alice', encryptionMode: 'e2ee',
                machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope!)), callerDataEncryptionKey: ownerEnvelope, nextCursor: null,
                content: { metadata, metadataVersion: revision, daemonState, daemonStateVersion: revision }, recipients: [...(delivered ? [] : [{ recipientAccountId: 'bob',
                    contentKey: recipientBindingAvailable ? { status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
                        contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })) }
                        : { status: 'unavailable', reason: 'encryption_setup_required' },
                    contentPublicKeyFingerprint: recipientBindingAvailable ? fingerprint : null, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }]),
                    ...(variant === 'mixed-legacy' ? [{ recipientAccountId: 'plain-member', contentKey: { status: 'unavailable', reason: 'plain_account' },
                        contentPublicKeyFingerprint: null, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }] : [])] });
            return undefined;
        } });
        const machineRequests = () => home.requests.filter(request => request.path.startsWith('/v1/machines/'));
        try {
            if (variant === 'malformed-present') {
                expect(await prepareMachineDataKeyEnvelopesForScope({ scope: { serverId: home.homes.resource!.id, accountId: 'alice' }, machineId: 'machine' })).toMatchObject({ kind: 'unavailable' });
                expect(machineRequests().some(request => request.method === 'POST' || request.method === 'PATCH')).toBe(false);
                expect(delivered).toBeNull();
                return;
            }
            const scope = { serverId: home.homes.resource!.id, accountId: 'alice' };
            if (variant === 'mixed-legacy') {
                expect(await executeMachineAccessHttpAction({ scope, actionId: 'machines.access.grant.set',
                    input: { serverId: scope.serverId, machineId: 'machine', principal: { kind: 'team', teamId: 'mixed-team' }, level: 'view' },
                })).toMatchObject({ kind: 'saved', readiness: 'refused', canPrepareKeys: true });
            } else {
                const fromList = { scope, machineId: 'machine', initialMachineRow: row() };
                expect(await prepareMachineDataKeyEnvelopesForScope(fromList)).toEqual({ kind: 'prepared' });
                // The authenticated list already supplied the owner observation. Only
                // unknown transition outcomes may require another physical row read.
                expect(machineRequests().filter(request => request.path === '/v1/machines/machine'))
                    .toHaveLength(variant === 'lost-ack' ? 1 : 0);
            }
            const currentKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(ownerEnvelope!), recipientSecretKeyOrSeed: owner.secretKey });
            expect(delivered).toEqual(currentKey);
            expect(delivered).not.toBeNull();
            expect(delivered).not.toEqual(owner.secretKey);
            expect(delivered).not.toEqual(secret);
            expect((await new AES256Encryption(currentKey!).decrypt([decodeBase64(metadata)]))[0]).toEqual(editedMetadata);
            expect((await new AES256Encryption(currentKey!).decrypt([decodeBase64(daemonState)]))[0]).toEqual(editedState);
            const physical = machineRequests();
            expect(physical.every(request => request.home === 'resource' && request.accountId === 'alice')).toBe(true);
            expect(physical.filter(request => request.method === 'POST')).toHaveLength(1);
            if (variant === 'lost-ack') {
                expect(physical.filter(request => request.path === '/v1/machines/machine')).toHaveLength(1);
            }
            if (variant === 'dataKey') {
                const staleListRow = row();
                revision++;
                delivered = null;
                const staleListPreparation = { scope, machineId: 'machine', initialMachineRow: staleListRow };
                expect(await prepareMachineDataKeyEnvelopesForScope(staleListPreparation))
                    .toEqual({ kind: 'unavailable', code: 'machine_key_changed' });
                expect(delivered).toBeNull();
                // The fresh census fences a stale list observation before disclosure.
                // A later unseeded attempt still uses the ordinary fresh owner path.
                expect(await prepareMachineDataKeyEnvelopesForScope({ scope, machineId: 'machine' })).toEqual({ kind: 'prepared' });
                const accountModeReads = () => home.httpRequests.filter(request =>
                    request.home === 'resource' && request.path === '/v1/account/encryption').length;
                const beforeRepeatedPreparation = accountModeReads();
                for (let pass = 0; pass < 3; pass += 1) {
                    expect(await prepareMachineDataKeyEnvelopesForScope({ scope, machineId: 'machine' })).toEqual({ kind: 'prepared' });
                }
                // Explicit current Machine mode owns these resource reads. Repeated
                // invalidation must not perform an unrelated Account-mode N+1.
                expect(accountModeReads() - beforeRepeatedPreparation).toBe(0);
                expect(home.httpRequests.filter(request => request.path === '/v1/machines/machine')).toHaveLength(4);
                expect(machineRequests().filter(request => request.method === 'POST')).toHaveLength(1);
                const machine = createMachineFixture({ id: 'machine', active: false, dataEncryptionKey: ownerEnvelope,
                    keyBasis: row().keyBasis, metadataVersion: revision, daemonStateVersion: revision, access: { ...row().access, role: 'manage',
                        resourceMode: 'e2ee', accessState: 'ready' } });
                const recipientChangeCursors = new Map<string, number>();
                let lifetimeCurrent = true;
                const refresh = (activeAt: number) => prepareMachineDataKeyEnvelopesForMachines({ scope,
                    machines: [{ ...machine, activeAt, active: activeAt % 2 === 0 }],
                    publishedRows: [{ ...machine, ...row(), recipientWorkPending: delivered === null, recipientWorkCursor: 0 }],
                    recipientChangeCursors, isCurrent: () => lifetimeCurrent });
                const rowReadsBeforeRefresh = machineRequests().filter(request => request.path === '/v1/machines/machine').length;
                await refresh(1);
                expect(machineRequests().filter(request => request.path === '/v1/machines/machine')).toHaveLength(rowReadsBeforeRefresh);
                const censusReads = () => machineRequests().filter(request => request.path.endsWith('/data-key-envelopes') && request.method === 'GET').length;
                const before = censusReads();
                for (let presence = 2; presence <= 6; presence++) await refresh(presence);
                expect(censusReads() - before).toBe(0);
                recipientChangeCursors.set(machine.id, 1);
                const preparedKey = delivered;
                delivered = null; // A newly admitted recipient needs real delivery, not just a census.
                await refresh(7);
                expect(censusReads() - before).toBe(2); // Admission plus the existing final empty census.
                expect(delivered).toEqual(preparedKey);
                expect(machineRequests().filter(request => request.method === 'PATCH')).toHaveLength(3);
                await refresh(8);
                expect(censusReads() - before).toBe(2);
                const entered = createDeferred<void>();
                const release = createDeferred<void>();
                censusGate = release.promise;
                censusEntered = () => entered.resolve();
                recipientChangeCursors.set(machine.id, 2);
                const oldPass = refresh(9);
                await entered.promise;
                recipientChangeCursors.set(machine.id, 3);
                const changedWhileRunning = refresh(10);
                release.resolve();
                await Promise.all([oldPass, changedWhileRunning]);
                expect(censusReads() - before).toBe(6);
                const revokedEntered = createDeferred<void>();
                const revokedRelease = createDeferred<void>();
                censusGate = revokedRelease.promise;
                censusEntered = () => revokedEntered.resolve();
                recipientChangeCursors.set(machine.id, 4);
                const beforeAccessChange = refresh(11);
                await revokedEntered.promise;
                await prepareMachineDataKeyEnvelopesForMachines({ scope,
                    machines: [{ ...machine, access: { ...machine.access!, role: 'use' } }], recipientChangeCursors,
                    isCurrent: () => lifetimeCurrent });
                const afterAccessChange = refresh(12);
                revokedRelease.resolve();
                await Promise.all([beforeAccessChange, afterAccessChange]);
                // The completed pass delivered the key. Re-admitting Manage
                // with a settled work fact and the same cursor needs no pass.
                expect(censusReads() - before).toBe(8);
                censusGate = undefined;
                revision++;
                machine.keyBasis = row().keyBasis;
                await refresh(13); // Content revisions on the same owner envelope are not recipient demand.
                expect(censusReads() - before).toBe(8);
                machine.metadataVersion = revision;
                machine.daemonStateVersion = revision;
                await refresh(14);
                expect(censusReads() - before).toBe(8); // Hydrating that same published basis is not another input change.
                recipientChangeCursors.set(machine.id, 5);
                delivered = null;
                recipientBindingAvailable = false;
                await refresh(15);
                expect(delivered).toBeNull();
                recipientBindingAvailable = true;
                await refresh(16); // Missing binding is repaired without a Machine edit or cursor change.
                expect(delivered).toEqual(preparedKey);
                const beforeNewLifetime = censusReads();
                lifetimeCurrent = false;
                delivered = null;
                await prepareMachineDataKeyEnvelopesForMachines({ scope, machines: [machine], recipientChangeCursors, isCurrent: () => true });
                expect(censusReads() - beforeNewLifetime).toBe(2); // A retired crypto/Home lifetime cannot suppress new work.
                const beforeRetiredScope = machineRequests().length;
                const retiredScopePreparation = { scope, machineId: 'machine', initialMachineRow: row(), isCurrent: () => false };
                expect(await prepareMachineDataKeyEnvelopesForScope(retiredScopePreparation))
                    .toMatchObject({ kind: 'unavailable' });
                expect(machineRequests().slice(beforeRetiredScope)).toEqual([]);
            }
        } finally { await home.dispose(); }
    });
});
