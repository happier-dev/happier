import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The GitHub endpoints and avatar host are faked through the global fetch stub below.
vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));
import { normalizeVerifiedEmail } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { prepareIdentityLink } from '@/app/auth/providers/accountIdentityLifecycle';
import { provisionFreshAccountInTx } from './provisionFreshAccountInTx';
import { prepareGithubConnect } from './providers/github/githubConnect';
import { Context } from '@/context';

describe('fresh Account verified mailbox admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-native-admission-', initAuth: true, initFiles: true, initEncrypt: true,
        });
    }, 120_000);
    afterEach(async () => {
        vi.unstubAllGlobals();
        await db.releasedUsername.deleteMany();
        await db.uploadedFile.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { await harness.close(); });

    it('admits fresh Accounts without claiming reserved or unavailable provider suggestions', async () => {
        const occupied = await db.account.create({ data: { publicKey: 'occupied-name', username: 'occupied' } });
        for (const username of ['admin', occupied.username!]) {
            const account = await inTx((tx) => provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: 'must_create', accountId: randomUUID() },
                publicKey: null, encryptionMode: 'plain', usernameChange: { kind: 'identity_fill', suggestion: username },
            }));
            expect(account.username).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBeNull();
        }
    });

    it('returns the current provider-filled username after prepared identity admission', async () => {
        const accountId = randomUUID();
        const identityConnection = await prepareIdentityLink({
            accountId, provider: 'github', providerUserId: 'fresh-name', providerLogin: 'fresh-name',
            profile: { login: 'fresh-name' }, presentation: { username: 'fresh-name' },
        });
        const account = await inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId },
            publicKey: null, encryptionMode: 'plain', identityConnection,
        }));
        expect(account.username).toBe('fresh-name');
    });

    it('uses the captured effective username policy for prepared provider presentation', async () => {
        const usernamePolicyEnv = { ...process.env, FRIENDS_USERNAME_MIN_LEN: '2' };
        const accountId = randomUUID();
        const identityConnection = await prepareGithubConnect(Context.create(accountId), {
            id: 12346, login: 'xy',
        }, '', { usernamePolicyEnv });
        const account = await inTx(tx => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId },
            publicKey: null, encryptionMode: 'plain', identityConnection,
        }), { isolationLevel: 'Serializable' });
        expect(account.username).toBe('xy');
    });

    it('keeps explicitly released Accounts unclaimed when a new identity is connected', async () => {
        const account = await db.account.create({ data: {
            publicKey: null, encryptionMode: 'plain', usernameAutoFillEnabled: false,
        } });
        const identityConnection = await prepareIdentityLink({
            accountId: account.id, provider: 'github', providerUserId: 'released-fill', providerLogin: 'released-fill',
            profile: { login: 'released-fill' }, presentation: { username: 'released-fill' },
        });
        await inTx(identityConnection.connectInTx, { isolationLevel: 'Serializable' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBeNull();
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(1);
    });

    it('admits a fresh provider presentation while preserving an obsolete release record', async () => {
        const retained = await db.releasedUsername.create({ data: { username: 'held-name', expiresAt: new Date(Date.now() + 86_400_000) } });
        const accountId = randomUUID();
        const identityConnection = await prepareIdentityLink({
            accountId, provider: 'github', providerUserId: 'held-fill', providerLogin: 'held-name',
            profile: { login: 'held-name' }, presentation: { username: 'held-name' },
        });
        const account = await inTx(tx => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId }, publicKey: null, encryptionMode: 'plain',
            usernameChange: { kind: 'identity_fill', suggestion: 'held-name' }, identityConnection,
        }), { isolationLevel: 'Serializable' });
        expect(account.username).toBe('held-name');
        expect(await db.releasedUsername.findUniqueOrThrow({ where: { username: 'held-name' } })).toEqual(retained);
        expect(await db.accountIdentity.count({ where: { accountId } })).toBe(1);
    });

    it('preserves a prepared provider avatar when its Account does not exist until admission', async () => {
        const image = await sharp({ create: {
            width: 1, height: 1, channels: 4,
            background: { r: 0, g: 0, b: 255, alpha: 0.5 },
        } }).png().toBuffer();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(image, { status: 200 })));
        const accountId = randomUUID();
        const identityConnection = await prepareGithubConnect(Context.create(accountId), {
            id: 12345, login: 'avatar-user', avatar_url: 'https://example.test/avatar.png', name: 'Avatar User',
            email: 'unproven-provider-profile@example.test',
        }, 'provider-token');
        expect(await db.account.count()).toBe(0);
        await inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId }, publicKey: null, encryptionMode: 'plain', identityConnection,
        }));
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.avatar).toMatchObject({ width: 1, height: 1 });
        expect(await db.uploadedFile.count({ where: { accountId } })).toBe(1);
        expect(await db.accountEmail.count({ where: { accountId } })).toBe(0);
    });

    it('permits idempotence only for the explicit verified signing-identity semantic', async () => {
        const publicKey = '01'.repeat(32);
        const first = await inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'idempotent_verified_signing_identity', publicKey },
            encryptionMode: 'e2ee',
        }));
        const originalTransaction = db.$transaction;
        let staleCaptureUsed = false;
        // Model a DB snapshot captured just before another transaction's
        // equal-key winner became visible. The upsert and transaction remain real.
        db.$transaction = new Proxy(originalTransaction, {
            apply(target, receiver, args: unknown[]) {
                const operation = args[0];
                if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: object) => operation(new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property !== 'account') return Reflect.get(target, property, receiver);
                        const account = Reflect.get(target, property);
                        return new Proxy(account, {
                            get(target, property, receiver) {
                                const method = Reflect.get(target, property, receiver);
                                if (property !== 'findUnique') return method;
                                return async (query: { where?: { publicKey?: string } }) => {
                                    if (!staleCaptureUsed && query.where?.publicKey === publicKey) {
                                        staleCaptureUsed = true;
                                        return null;
                                    }
                                    return Reflect.apply(method, target, [query]);
                                };
                            },
                        });
                    },
                })), ...args.slice(1)]);
            },
        });
        let repeated: Awaited<ReturnType<typeof provisionFreshAccountInTx>>;
        try {
            repeated = await inTx((tx) => provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: 'idempotent_verified_signing_identity', publicKey },
                encryptionMode: 'e2ee',
            }));
        } finally {
            db.$transaction = originalTransaction;
        }
        expect(staleCaptureUsed).toBe(true);
        expect(repeated.id).toBe(first.id);
        expect(await db.account.count()).toBe(1);

        const mustCreateId = randomUUID();
        await expect(inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId: mustCreateId },
            publicKey,
            encryptionMode: 'e2ee',
        }))).rejects.toThrow();
        expect(await db.account.count()).toBe(1);
        expect(await db.account.findUnique({ where: { id: mustCreateId } })).toBeNull();
    });

    it('persists proven evidence without merging Accounts or treating it as a login alias', async () => {
        const email = normalizeVerifiedEmail('Alice@Example.com')!;
        const first = await inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId: randomUUID() }, publicKey: null, encryptionMode: 'plain', verifiedMailbox: email,
        }));
        const second = await inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: 'must_create', accountId: randomUUID() }, publicKey: null, encryptionMode: 'plain', verifiedMailbox: email,
        }));
        expect(first.id).not.toBe(second.id);
        expect(await db.accountEmail.findMany({
            where: { normalizedEmail: email.normalizedEmail },
            select: { accountId: true, address: true },
        })).toEqual(expect.arrayContaining([
            { accountId: first.id, address: email.address },
            { accountId: second.id, address: email.address },
        ]));
        expect(await db.accountIdentity.count()).toBe(0);
        expect(first.publicKey).toBeNull();
        expect(first.contentPublicKey).toBeNull();
    });

    it('rolls back the Account and native identity when mailbox evidence cannot commit', async () => {
        const email = normalizeVerifiedEmail('native@example.com')!;
        const accountId = randomUUID();
        const identityConnection = await prepareIdentityLink({
            accountId, provider: 'email', providerUserId: email.normalizedEmail,
            providerLogin: null, profile: {}, showOnProfile: false,
        });
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_email_evidence_insert
            BEFORE INSERT ON AccountEmail
            BEGIN SELECT RAISE(ABORT, 'mailbox storage unavailable'); END`);
        try {
            await expect(inTx((tx) => provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: 'must_create', accountId }, publicKey: null, encryptionMode: 'plain', identityConnection, verifiedMailbox: email,
            }))).rejects.toThrow();
            expect(await db.account.count()).toBe(0);
            expect(await db.accountIdentity.count()).toBe(0);
            expect(await db.accountEmail.count()).toBe(0);
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER fail_email_evidence_insert');
        }
    });
});
