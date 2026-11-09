import { afterEach, describe, expect, it } from 'vitest';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSocketAccountEncryptionObservation, invalidateAccountEncryptionModeCache, invalidateAccountEncryptionModeCacheForChanges } from '@/sync/api/account/apiAccountEncryptionMode';
import { encodeBase64 } from '@/encryption/base64';
import { createFakeCryptoWorker } from './nativeCryptoWorker/fakeCryptoWorker';
import { resolveScopedAccountEncryption } from './scopedAccountEncryption';
import { DataKeyOpeningCancelledError } from './dataKeyOpenings';
import { AccountEncryptionMaterialUnavailableError } from '@/auth/encryption/createEncryptionFromAuthCredentials';

afterEach(() => { invalidateAccountEncryptionModeCache(); resetRuntimeFetch(); });

describe('Home Account encryption material lifetime', () => {
    it('refuses self-consistent material that differs from the persisted Account key binding', async () => {
        const locks = installWebLockManagerMock();
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: 'material-mismatch-account' }))}.signature`,
            secret: encodeBase64(new Uint8Array(32).fill(43), 'base64url') };
        const url = 'https://material-mismatch.example.test';
        const currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(44) });
        setRuntimeFetch(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(currentness) : Response.json({ mode: 'e2ee', updatedAt: 1 }));
        try {
            const home = await upsertServerProfile({ serverUrl: url });
            const outcome = await resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url, credentials }).then(
                () => 'material-admitted',
                error => error instanceof AccountEncryptionMaterialUnavailableError ? error.code : 'unexpected-error',
            );
            expect(outcome).toBe('encryption-material-unavailable');
        } finally { locks.restore(); }
    });

    it('initializes from historical-custody keys: plain resolves without material, a re-enabled E2EE Account opens them', async () => {
        // After convert-to-plain or "Keep keys and continue" this device's keys are history, not authority.
        const locks = installWebLockManagerMock();
        const secret = new Uint8Array(32).fill(47);
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: 'historical-custody-account' }))}.signature`,
            secret: encodeBase64(secret, 'base64url'), custody: 'historical' as const };
        const url = 'https://historical-custody.example.test';
        let mode: 'plain' | 'e2ee' = 'plain';
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: mode === 'plain' ? 1 : 2 });
            if (path === '/v1/account/encryption/currentness') return Response.json(mode === 'plain'
                ? createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 })
                : { ...createLegacyAccountEncryptionCurrentnessFixture({ secret }), version: 2, updatedAt: 2 });
            return new Response(null, { status: 404 });
        });
        try {
            const home = await upsertServerProfile({ serverUrl: url });
            const resolve = () => resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url, credentials });
            await expect(resolve()).resolves.toBeNull();
            mode = 'e2ee';
            invalidateAccountEncryptionModeCache();
            expect(await resolve()).not.toBeNull();
        } finally { locks.restore(); }
    });

    it('retires retained material on a same-mode persisted key-binding change', async () => {
        const locks = installWebLockManagerMock();
        const secret = new Uint8Array(32).fill(45);
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: 'material-binding-account' }))}.signature`,
            secret: encodeBase64(secret, 'base64url') };
        const url = 'https://material-binding.example.test';
        let currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
        setRuntimeFetch(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
            ? Response.json(currentness) : Response.json({ mode: 'e2ee', updatedAt: currentness.updatedAt }));
        let observation: ReturnType<typeof createSocketAccountEncryptionObservation> | undefined;
        try {
            const home = await upsertServerProfile({ serverUrl: url });
            const resolve = () => resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url, credentials });
            const encryption = await resolve();
            if (!encryption) throw new Error('Expected E2EE material');
            const scope = encryption.getCurrentEncryptionGenerationScope();
            observation = createSocketAccountEncryptionObservation({ serverId: home.id, endpointUrl: url,
                runtimeOrigin: url, homeCarrierEndpointId: null, credentials, isCurrent: () => true,
                request: async () => Response.json(currentness) });
            observation.connected();
            await observation.binding.read();
            currentness = { ...createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(46) }),
                version: 2, updatedAt: 2 };
            observation.update({ id: 'new-binding', seq: 2, createdAt: 2,
                body: { t: 'update-account', id: 'material-binding-account', encryptionCurrentness: currentness } });
            expect(encryption.isCurrentEncryptionGenerationScope(scope)).toBe(false);
            const outcome = await resolve().then(() => 'material-admitted',
                error => error instanceof AccountEncryptionMaterialUnavailableError ? error.code : 'unexpected-error');
            expect(outcome).toBe('encryption-material-unavailable');
        } finally { observation?.dispose(); locks.restore(); }
    });

    it('rejects a 503 revalidation once while retaining the working owner and recovers on demand', async () => {
        const locks = installWebLockManagerMock();
        const secret = new Uint8Array(32).fill(18);
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: 'mode-failure-account' }))}.signature`,
            secret: encodeBase64(secret, 'base64url') };
        const url = 'https://material-mode-failure.example.test';
        let unavailable = false;
        let reads = 0;
        setRuntimeFetch(async input => {
            if (new URL(String(input)).pathname === '/v1/account/encryption/currentness') {
                reads += 1;
                return unavailable ? Response.json({ error: 'unavailable' }, { status: 503 })
                    : Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret }));
            }
            if (new URL(String(input)).pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            return Response.json({});
        });
        try {
            const home = await upsertServerProfile({ serverUrl: url });
            const resolve = () => resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url, credentials });
            const encryption = await resolve();
            if (!encryption) throw new Error('Expected E2EE material');
            const captured = encryption.getCurrentEncryptionGenerationScope();
            const key = new Uint8Array(32).fill(92);
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
            // Retired material cancels the opening; it never yields the key.
            const opens = async () => (await encryption.decryptEncryptionKey(envelope).catch((error: unknown) => {
                if (error instanceof DataKeyOpeningCancelledError) return null;
                throw error;
            }))?.every((byte, index) => byte === key[index]) === true;
            expect(await opens()).toBe(true);
            unavailable = true;
            invalidateAccountEncryptionModeCache({ serverId: home.id });
            const before = reads;
            await expect(resolve()).rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable', canTryAgain: true });
            expect(reads - before).toBe(1);
            expect(encryption.isCurrentEncryptionGenerationScope(captured)).toBe(true);
            expect(await opens()).toBe(true);
            unavailable = false;
            expect(await resolve() === encryption).toBe(true);
        } finally { locks.restore(); }
    });

    it('keeps admitted material through transport and equal-mode invalidations without extra mode reads or openings', async () => {
        const locks = installWebLockManagerMock();
        const secret = new Uint8Array(32).fill(17);
        const credentials = { token: `e30.${btoa(JSON.stringify({ sub: 'material-account' }))}.signature`,
            secret: encodeBase64(secret, 'base64url') };
        const url = 'https://material-lifetime.example.test';
        let modeReads = 0;
        let mode: 'plain' | 'e2ee' = 'e2ee';
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') { modeReads += 1; return Response.json({ mode, updatedAt: 1 }); }
            if (path === '/v1/account/encryption/currentness') return Response.json(mode === 'plain'
                ? createPlainAccountEncryptionCurrentnessFixture()
                : createLegacyAccountEncryptionCurrentnessFixture({ secret }));
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            return new Response(null, { status: 404 });
        });
        let observation: ReturnType<typeof createSocketAccountEncryptionObservation> | undefined;
        try {
            const home = await upsertServerProfile({ serverUrl: url });
            const resolve = () => resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url, credentials });
            const encryption = (await resolve())!;
            const worker = createFakeCryptoWorker();
            let openings = 0;
            encryption.configureNativeCryptoWorker({ worker: { ...worker, decryptDataKeyEnvelopeV1: async request => {
                openings += request.items.length;
                return worker.decryptDataKeyEnvelopeV1(request);
            } }, routing: { mode: 'require', minPayloadBytes: 0 } });
            const key = new Uint8Array(32).fill(91);
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(key));
            // Retired material cancels the opening; it never yields the key.
            const opens = async () => (await encryption.decryptEncryptionKey(envelope).catch((error: unknown) => {
                if (error instanceof DataKeyOpeningCancelledError) return null;
                throw error;
            }))?.every((byte, index) => byte === key[index]) === true;
            expect(await opens()).toBe(true);
            const context = encryption.captureMachineEncryptionContext('controller', { dataEncryptionKey: null, expectedDataEncryptionKey: null });
            expect(context.isCurrent()).toBe(true);
            observation = createSocketAccountEncryptionObservation({ serverId: home.id, endpointUrl: url,
                runtimeOrigin: url, homeCarrierEndpointId: null, credentials, isCurrent: () => true,
                request: async () => Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret })) });
            observation.connected();
            expect(context.isCurrent()).toBe(true);
            const readCount = modeReads;
            for (let cycle = 0; cycle < 20; cycle += 1) {
                observation.disconnected(); observation.connected();
                expect(await resolve() === encryption).toBe(true);
            }
            expect(modeReads).toBe(readCount);
            expect(context.isCurrent()).toBe(true);
            for (let revision = 2; revision < 22; revision += 1) {
                // Feed withdrawal can precede the admitted socket value for the
                // same change. That known equal mode must settle re-admission.
                invalidateAccountEncryptionModeCache({ serverId: home.id });
                observation.update({ id: `equal-mode-${revision}`, seq: revision, createdAt: revision,
                    body: { t: 'update-account', id: 'material-account', encryptionCurrentness: {
                        ...createLegacyAccountEncryptionCurrentnessFixture({ secret }), version: revision,
                    } } });
                expect(context.isCurrent()).toBe(true);
                expect(await resolve() === encryption).toBe(true);
                expect(await opens()).toBe(true);
            }
            expect(modeReads).toBe(readCount);
            expect(openings).toBe(1);
            // Current username publication emits string/null, also the moving
            // 0.2 predecessor's string shape. Neither changes encryption identity.
            for (const hint of [{ username: 'renamed' }, { username: null }, { name: true }, { linkedProviders: true }]) {
                invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint }], { serverId: home.id });
                expect(context.isCurrent()).toBe(true);
                expect(await resolve() === encryption).toBe(true);
            }
            expect(modeReads).toBe(readCount);
            mode = 'plain';
            observation.update({ id: 'plain-mode', seq: 30, createdAt: 30,
                body: { t: 'update-account', id: 'material-account', encryptionCurrentness:
                    createPlainAccountEncryptionCurrentnessFixture({ version: 30, updatedAt: 30 }) } });
            // This device still holds the keys as active: the push is the typed downgrade refusal,
            // publishes no plain, and captured material stays E2EE (never plaintext).
            await expect(resolve()).rejects.toMatchObject({ code: 'account_mode_downgrade_unverified' });
            expect(context.isCurrent()).toBe(true);
            // Once this device confirms its keys as history, plain resolves without material and
            // the active-custody owner retires.
            await expect(resolveScopedAccountEncryption({ serverId: home.id, serverUrl: url,
                credentials: { ...credentials, custody: 'historical' } })).resolves.toBeNull();
            expect(context.isCurrent()).toBe(false);
            expect(await opens()).toBe(false);
            mode = 'e2ee';
            observation.update({ id: 'e2ee-mode', seq: 31, createdAt: 31,
                body: { t: 'update-account', id: 'material-account', encryptionCurrentness: {
                    ...createLegacyAccountEncryptionCurrentnessFixture({ secret }), version: 31, updatedAt: 31,
                } } });
            const fresh = await resolve();
            if (!fresh) throw new Error('Expected fresh E2EE material');
            expect(fresh === encryption).toBe(false);
            expect((await fresh.decryptEncryptionKey(envelope))?.every((byte, index) => byte === key[index])).toBe(true);
            const freshContext = fresh.captureMachineEncryptionContext('controller', { dataEncryptionKey: null, expectedDataEncryptionKey: null });
            mode = 'plain';
            invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self',
                hint: { username: 'renamed', encryptionMode: 'plain' } }], { serverId: home.id });
            await expect(resolve()).rejects.toMatchObject({ code: 'account_mode_downgrade_unverified' });
            // A refused downgrade retires nothing: captured material stays E2EE, never plaintext.
            expect(freshContext.isCurrent()).toBe(true);
        } finally { observation?.dispose(); locks.restore(); }
    });
});
