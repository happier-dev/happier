import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import { encodeBase64 } from "@happier-dev/protocol/crypto/base64";

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { auth } from "./auth";

const PUBLIC_KEY_PREFIX = "api-token-mint-contention-";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "API-token minting under PostgreSQL Account contention",
    () => {
        let connected = false;

        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
            vi.stubEnv("HANDY_MASTER_SECRET", "api-token-mint-postgres-secret");
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            initDbPostgres();
            await db.$connect();
            await auth.init();
            connected = true;
        });

        afterEach(async () => {
            await db.account.deleteMany({
                where: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } },
            });
        });

        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        it("keeps child inventory and exact update readback within the authenticated Account", async () => {
            const account = await db.account.create({
                data: { publicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey), encryptionMode: "e2ee" },
            });
            const foreign = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const keyChallengeEnabled = process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
            try {
                const root = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: "CI root" });
                await auth.createApiToken({ accountId: foreign.id, tokenId: randomUUID(), label: "Foreign CI" });
                const principal = await auth.verifyPat(root.token);
                if (!principal.ok) throw new Error("Expected verified parent API token");
                const child = await auth.createChildApiToken({ principal, tokenId: randomUUID(), label: "CI child",
                    expiresAt: new Date(Date.now() + 3_600_000), grant: API_TOKEN_FULL_GRANT_V1 });

                expect((await auth.listApiTokens(account.id)).map(token => token.tokenId)).toEqual([root.tokenId]);
                expect((await auth.listApiTokens(account.id, { includeChildren: true })).map(token => token.tokenId).sort())
                    .toEqual([root.tokenId, child.tokenId].sort());
                const updated = await auth.updateApiToken({ accountId: account.id, tokenId: child.tokenId,
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }] });
                expect(updated.apiToken).toMatchObject({ tokenId: child.tokenId, parentTokenId: root.tokenId,
                    grant: child.grant, hasUnattendedTeamAccess: true });
                expect((await auth.listApiTokens(account.id, { includeChildren: true, tokenId: child.tokenId }))
                    .map(token => token.tokenId)).toEqual([child.tokenId]);
                expect(await auth.listApiTokens(foreign.id, { includeChildren: true, tokenId: child.tokenId })).toEqual([]);
                expect((await auth.verifyPat(child.token)).ok).toBe(true);
            } finally {
                vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", keyChallengeEnabled);
                // Generated real keys have no prefix; clean only this test's exact Accounts.
                await db.account.deleteMany({ where: { id: { in: [account.id, foreign.id] } } });
            }
        });

        it("commits a root token while another writer advances the Account before its fence", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            let releaseWriter!: () => void;
            let signalWriter!: () => void;
            const writerHeld = new Promise<void>((resolve) => { signalWriter = resolve; });
            const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
            const writing = inTx(async peerTx => {
                await peerTx.account.update({
                    where: { id: account.id },
                    data: { seq: { increment: 1 } },
                });
                signalWriter();
                await writerRelease;
            }, {
                isolationLevel: "ReadCommitted",
                transactionClass: "api-token-mint-contention-peer",
            });
            await writerHeld;

            const transaction = db.$transaction;
            let signalFence!: () => void;
            const fenceReached = new Promise<void>((resolve) => { signalFence = resolve; });
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        // Materialize the transaction snapshot while the peer's new
                        // Account version is uncommitted. This recreates the observed
                        // PostgreSQL attempt in which the later fence saw that version
                        // commit: Serializable aborts, while the fenced ReadCommitted
                        // owner waits and then consumes the committed row.
                        await tx.$queryRawUnsafe(
                            'SELECT "id" FROM "Account" WHERE "id" = $1',
                            account.id,
                        );
                        return callback(new Proxy(tx, {
                            get(inner, property, innerReceiver) {
                                if (property !== "$queryRawUnsafe") {
                                    return Reflect.get(inner, property, innerReceiver);
                                }
                                return async (query: string, ...values: unknown[]) => {
                                    if (query.includes('FROM "Account"') && query.includes("FOR UPDATE")) {
                                        signalFence();
                                    }
                                    return inner.$queryRawUnsafe(query, ...values);
                                };
                            },
                        }));
                    }, ...args.slice(1)]);
                },
            });

            const tokenId = randomUUID();
            const minting = auth.createApiToken({
                accountId: account.id,
                tokenId,
                label: "Concurrent root mint",
            });
            const mintAssertion = expect(minting).resolves.toMatchObject({ tokenId });
            try {
                await fenceReached;
                releaseWriter();
                await writing;
                await mintAssertion;
            } finally {
                releaseWriter();
                await writing.catch(() => undefined);
                db.$transaction = transaction;
            }

            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        });

        it("mints a child without conflicting with a concurrent Account cursor writer", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const parent = await auth.createApiToken({
                accountId: account.id,
                tokenId: randomUUID(),
                label: "Embed parent",
            });
            const principal = await auth.verifyPat(parent.token);
            if (!principal.ok) throw new Error("Expected the parent API token to verify");

            let releaseWriter!: () => void;
            let signalWriter!: () => void;
            const writerHeld = new Promise<void>((resolve) => { signalWriter = resolve; });
            const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
            const writing = inTx(async peerTx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(peerTx, account.id, "content");
                await peerTx.account.update({
                    where: { id: account.id },
                    data: { seq: { increment: 1 } },
                });
                signalWriter();
                await writerRelease;
            }, {
                isolationLevel: "ReadCommitted",
                transactionClass: "api-token-child-cursor-writer",
            });
            await writerHeld;

            const childTokenId = randomUUID();
            const transaction = db.$transaction;
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        // Bound only this disposable DB-contract interleaving. A
                        // compatible child lock never waits; an exclusive lock
                        // exposes the regression immediately.
                        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '50ms'");
                        return callback(tx);
                    }, ...args.slice(1)]);
                },
            });
            try {
                await expect(auth.createChildApiToken({
                    principal,
                    tokenId: childTokenId,
                    label: "Embed child",
                    expiresAt: new Date(Date.now() + 60_000),
                    grant: API_TOKEN_FULL_GRANT_V1,
                })).resolves.toMatchObject({ tokenId: childTokenId });
            } finally {
                releaseWriter();
                await writing;
                db.$transaction = transaction;
            }

            expect(await db.accountApiToken.findUnique({ where: { id: childTokenId } }))
                .toMatchObject({ accountId: account.id, parentTokenId: parent.tokenId });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        });

        it("does not mint a live credential after a waiting Account disable commits", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            let releaseFence!: () => void;
            let signalFence!: () => void;
            const held = new Promise<void>((resolve) => { signalFence = resolve; });
            const release = new Promise<void>((resolve) => { releaseFence = resolve; });
            const disabling = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                await setAccountStatusInTx(tx, {
                    actorAccountId: account.id,
                    targetAccountId: account.id,
                    status: "disabled",
                    authority: "account_erasure",
                });
                signalFence();
                await release;
            });
            await held;

            const minting = auth.createApiToken({
                accountId: account.id,
                tokenId: randomUUID(),
                label: "Waiting root mint",
            });
            releaseFence();
            await disabling;

            await expect(minting).rejects.toMatchObject({ code: "account-disabled" });
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
        });
    },
);
