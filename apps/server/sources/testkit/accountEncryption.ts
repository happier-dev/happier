import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol/crypto/accountContentKeyBindingV1";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { expect } from "vitest";
import {
    AccountEncryptionMigrateSettingsHistoryInventoryPageSchema,
    AccountEncryptionMigrateBadRequestResponseSchema,
    attachAccountEncryptionMigrateProofSignatureV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
    type AccountEncryptionMigrateSettingsHistoryDirective,
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
} from "@happier-dev/protocol/account/encryptionMigrate";
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2HistoryDetailResponseSchema } from "@happier-dev/protocol/account/settings/accountSettingsApiV2";
import { AccountSettingsStoredContentEnvelopeSchema, type AccountSettingsStoredContentEnvelope } from "@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope";
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from "@happier-dev/protocol/crypto/accountScopedCipher";
import { accountSettingsSnapshotToContent } from "@/app/accountSettings/accountSettingsHistoryContent";
import { deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inReadSnapshot } from "@/storage/inTx";
import { observePrismaReads } from "@/testkit/observePrismaReads";
import { readAccountSettingsEncryptionMigrationInventoryInTx } from "@/app/accountSettings/migrateAccountSettingsEncryptionInTx";
import { updateAccountEncryptionMode } from "@/app/api/routes/account/updateAccountEncryptionMode";

export function createSignedAccountContentBinding(
    recipientPublicKey: Uint8Array = tweetnacl.box.keyPair().publicKey,
): Readonly<{
    publicKey: string;
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySig: Uint8Array<ArrayBuffer>;
}> {
    const signing = tweetnacl.sign.keyPair();
    const contentPublicKey = new Uint8Array(recipientPublicKey);
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey,
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey,
        }),
    };
}

type HistoryContractTransport = Readonly<{
    request(accountId: string, input: Readonly<{ method: "GET" | "POST"; url: string; payload?: object }>):
        Promise<Readonly<{ statusCode: number; json(): unknown }>>;
    trackAccount?(accountId: string): void;
}>;

/** Null snapshots retain a recorded mode and therefore are not an empty legacy inventory. */
export async function exerciseNullOnlySettingsHistoryLegacyTransitionContract(
    options: Pick<HistoryContractTransport, "trackAccount"> = {},
): Promise<void> {
    const account = await db.account.create({ data: { ...createSignedAccountContentBinding(),
        encryptionMode: "e2ee", settings: null, settingsVersion: 3 } });
    options.trackAccount?.(account.id);
    const snapshot = await db.accountSettingsSnapshot.create({ data: {
        accountId: account.id, version: 2, encryptionMode: "e2ee", contentKind: "empty", settingsDbValue: null,
    } });
    const result = await updateAccountEncryptionMode({ accountId: account.id, mode: "plain" });
    expect(result.status).toBe("migration_required");
    const current = await db.account.findUniqueOrThrow({ where: { id: account.id },
        select: { encryptionMode: true, settings: true, settingsVersion: true, seq: true } });
    expect(current).toEqual({ encryptionMode: "e2ee", settings: null, settingsVersion: 3, seq: account.seq });
    expect(await db.accountSettingsSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).toEqual(snapshot);
}

/** The same HTTP/storage contract runs on isolated SQLite and native database fixtures. */
export async function exerciseSettingsHistoryEncryptionMigrationContract(transport: HistoryContractTransport): Promise<void> {
    const signing = tweetnacl.sign.keyPair();
    const contentKey = tweetnacl.box.keyPair();
    const material = { type: "legacy" as const, secret: tweetnacl.randomBytes(32) };
    const account = await db.account.create({ data: {
        publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        contentPublicKey: new Uint8Array(contentKey.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
            contentPublicKey: contentKey.publicKey }),
        encryptionMode: "plain", settingsVersion: 12,
        settings: JSON.stringify({ t: "plain", v: { preferredLanguage: "en" } }),
    } });
    transport.trackAccount?.(account.id);
    const originals = Array.from({ length: 11 }, (_, index) => ({
        version: index + 1,
        createdAt: new Date(1_700_000_000_000 + index),
        content: index === 0 ? null : { t: "plain" as const,
            v: { preferredLanguage: index % 2 ? "fr" : "de", futureHistoryValue: index } },
    }));
    await db.accountSettingsSnapshot.createMany({ data: originals.map(item => ({
        accountId: account.id, version: item.version, createdAt: item.createdAt,
        encryptionMode: "plain", contentKind: item.content === null ? "empty" : "plain",
        settingsDbValue: item.content === null ? null : JSON.stringify(item.content),
    })) });
    const identities = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id },
        orderBy: { version: "asc" }, select: { id: true, version: true, createdAt: true } });
    const readState = async () => JSON.stringify(await Promise.all([
        db.account.findUniqueOrThrow({ where: { id: account.id } }),
        db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: "asc" } }),
        db.accountChange.count({ where: { accountId: account.id } }),
    ]), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    const open = (content: AccountSettingsStoredContentEnvelope | null): unknown => {
        if (content === null) return null;
        if (content.t === "plain") return content.v;
        const opened = openAccountScopedBlobCiphertext({ kind: "account_settings", material, ciphertext: content.c });
        if (!opened) throw new Error("History contract client could not open recorded envelope");
        return opened.value;
    };
    const reseal = (content: AccountSettingsStoredContentEnvelope | null, toMode: "plain" | "e2ee"):
        AccountSettingsStoredContentEnvelope | null => {
        if (content === null) return null;
        const value = open(content);
        if (toMode === "plain") {
            const plain = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: "plain", v: value });
            if (!plain.success) throw new Error("History fixture payload is not a plain envelope");
            return plain.data;
        }
        return { t: "encrypted", c: sealAccountScopedBlobCiphertext({ kind: "account_settings", material,
            payload: value, randomBytes: length => tweetnacl.randomBytes(length) }) };
    };
    const readInventory = async (beforeVersion?: number) => {
        const response = await transport.request(account.id, { method: "GET",
            url: `/v1/account/encryption/migrate/settings-history/inventory${beforeVersion === undefined ? "" : `?beforeVersion=${beforeVersion}`}` });
        expect(response.statusCode).toBe(200);
        const parsed = AccountEncryptionMigrateSettingsHistoryInventoryPageSchema.safeParse(response.json());
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw new Error("History inventory violated its protocol schema");
        return parsed.data;
    };
    const migrationRequest = async (toMode: "plain" | "e2ee", settingsHistory?: AccountEncryptionMigrateSettingsHistoryDirective): Promise<AccountEncryptionMigrateRequest> => {
        const current = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(current);
        const content = current.settings === null ? null : current.encryptionMode === "plain"
            ? accountSettingsSnapshotToContent({ accountId: account.id, encryptionMode: "plain", settingsDbValue: current.settings })
            : { t: "encrypted" as const, c: current.settings };
        const unsigned = {
            toMode, expectedAccountVersion: current.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: current.settingsVersion, settingsContent: reseal(content, toMode),
            ...(settingsHistory === undefined ? {} : { settingsHistory }),
            connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
            machines: { action: "assert_empty" }, todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" }, sessions: { action: "assert_empty" },
            reviewComments: { action: "assert_empty" }, sessionOrganization: { action: "assert_empty" },
            pets: { action: "assert_empty" },
        } satisfies AccountEncryptionMigrateUnsignedRequest;
        if (toMode === "plain") return unsigned;
        const request = { ...unsigned, keyProof: { v: 1 as const,
                publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
                contentPublicKey: privacyKit.encodeBase64(new Uint8Array(contentKey.publicKey)),
                contentPublicKeySig: privacyKit.encodeBase64(new Uint8Array(account.contentPublicKeySig!)),
            },
        };
        return attachAccountEncryptionMigrateProofSignatureV1({ request,
            signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(
                createAccountEncryptionMigrateProofSigningInputV1({ accountId: account.id, sourceMode: "plain", request }), signing.secretKey))) });
    };
    const inventory = await readInventory();
    expect(inventory.items.map(item => item.version)).toEqual(originals.map(item => item.version).reverse());
    expect(inventory.nextBeforeVersion).toBeNull();
    expect((await readInventory(6)).items.map(item => item.version)).toEqual([5, 4, 3, 2, 1]);

    for (const toMode of ["e2ee", "plain"] as const) {
        const source = await readInventory();
        const directive = { items: source.items.map(item => ({ version: item.version,
            expectedContent: item.content, content: reseal(item.content, toMode) })) };
        if (toMode === "e2ee") {
            const stale = directive.items.map((item, index) => index === 0
                ? { ...item, expectedContent: { t: "plain" as const, v: { stale: true } } } : item);
            const wrongTarget = directive.items.map((item, index) => index === 0
                ? { ...item, content: { t: "plain" as const, v: {} } } : item);
            const wrongNull = directive.items.map((item, index) => index === 0 ? { ...item, content: null } : item);
            for (const [scenario, candidate] of [
                ["missing", undefined], ["incomplete", { items: directive.items.slice(1) }], ["stale", { items: stale }],
                ["wrong-target-mode", { items: wrongTarget }], ["wrong-nullness", { items: wrongNull }],
            ] as const) {
                const before = await readState();
                const refused = await transport.request(account.id, { method: "POST", url: "/v1/account/encryption/migrate",
                    payload: await migrationRequest(toMode, candidate) });
                const badRequest = AccountEncryptionMigrateBadRequestResponseSchema.safeParse(refused.json());
                expect(refused.statusCode, `${scenario}: ${badRequest.success ? JSON.stringify(badRequest.data) : "invalid error contract"}`).toBe(400);
                expect(JSON.stringify(refused.json()) === JSON.stringify({ error: "invalid-params", reason: "migration_inventory_changed" })).toBe(true);
                expect(await readState() === before).toBe(true);
            }
            const first = await db.accountSettingsSnapshot.findUniqueOrThrow({ where: { accountId_version: { accountId: account.id, version: 2 } } });
            const mixedContent = reseal(originals[1].content, "e2ee");
            if (!mixedContent || mixedContent.t !== "encrypted") throw new Error("History fixture did not seal");
            for (const damage of [{ encryptionMode: "plain", settingsDbValue: "corrupt-history-fixture" },
                { encryptionMode: "e2ee", settingsDbValue: mixedContent.c }]) {
                await db.accountSettingsSnapshot.update({ where: { id: first.id }, data: damage });
                const before = await readState();
                const refusedInventory = await transport.request(account.id, { method: "GET", url: "/v1/account/encryption/migrate/settings-history/inventory" });
                expect(refusedInventory.statusCode).toBe(400);
                expect(JSON.stringify(refusedInventory.json()) === JSON.stringify({ error: "invalid-params", reason: "migration_inventory_changed" })).toBe(true);
                const refused = await transport.request(account.id, { method: "POST", url: "/v1/account/encryption/migrate",
                    payload: await migrationRequest(toMode, directive) });
                expect(refused.statusCode).toBe(400);
                expect(JSON.stringify(refused.json()) === JSON.stringify({ error: "invalid-params", reason: "migration_inventory_changed" })).toBe(true);
                expect(await readState() === before).toBe(true);
                await db.accountSettingsSnapshot.update({ where: { id: first.id }, data: {
                    encryptionMode: first.encryptionMode, settingsDbValue: first.settingsDbValue,
                } });
            }
        }
        const payload = await migrationRequest(toMode, directive);
        if (toMode === "e2ee") {
            const encryptedTargets = JSON.stringify({ settingsContent: payload.settingsContent,
                history: payload.settingsHistory?.items.map(item => item.content) });
            expect(encryptedTargets.includes("futureHistoryValue")).toBe(false);
            expect(encryptedTargets.includes("preferredLanguage")).toBe(false);
        }
        const response = await transport.request(account.id, { method: "POST", url: "/v1/account/encryption/migrate", payload });
        expect(response.statusCode).toBe(200);
        const rows = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: "asc" } });
        expect(rows.filter(row => row.version < 12).map(({ id, version, createdAt }) => ({ id, version, createdAt }))).toEqual(identities);
        expect(rows.length).toBe(source.items.length);
        expect(rows.every(row => row.encryptionMode === toMode && row.contentKind === (row.settingsDbValue === null ? "empty" : toMode === "plain" ? "plain" : "encrypted"))).toBe(true);
        const state = await readState();
        const replay = await transport.request(account.id, { method: "POST", url: "/v1/account/encryption/migrate", payload });
        expect(replay.statusCode).toBe(200);
        expect(await readState() === state).toBe(true);
        const converted = await readInventory();
        if (toMode === "e2ee") expect(JSON.stringify(converted).includes("futureHistoryValue")).toBe(false);
        for (const original of originals) {
            const retained = converted.items.find(item => item.version === original.version);
            expect(retained !== undefined && JSON.stringify(open(retained.content)) === JSON.stringify(original.content?.v ?? null)).toBe(true);
            const detail = await transport.request(account.id, { method: "GET", url: `/v2/account/settings/history/${original.version}` });
            expect(detail.statusCode).toBe(200);
            const snapshot = AccountSettingsV2HistoryDetailResponseSchema.safeParse(detail.json());
            expect(snapshot.success).toBe(true);
            if (!snapshot.success) throw new Error("Public history detail violated its protocol schema");
            expect(JSON.stringify(snapshot.data.content) === JSON.stringify(retained?.content)).toBe(true);
            const current = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settingsVersion: true } });
            const restore = await transport.request(account.id, { method: "POST", url: "/v2/account/settings", payload: {
                content: snapshot.data.content, expectedVersion: current.settingsVersion, expectedProfileTransferRevision: "absent",
            } });
            expect(restore.statusCode).toBe(200);
            expect(JSON.stringify(restore.json()).includes('"success":true')).toBe(true);
            const restored = await transport.request(account.id, { method: "GET", url: "/v2/account/settings" });
            expect(restored.statusCode).toBe(200);
            const parsed = AccountSettingsV2GetResponseSchema.safeParse(restored.json());
            expect(parsed.success && JSON.stringify(open(parsed.data.content)) === JSON.stringify(original.content?.v ?? null)).toBe(true);
        }
    }
}

/** Retained predecessor history can exceed current writer retention; paging must not truncate it. */
export async function exerciseSettingsHistoryMigrationPagingContract(transport: HistoryContractTransport): Promise<void> {
    const total = ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS + 1;
    const material = { type: "legacy" as const, secret: tweetnacl.randomBytes(32) };
    const account = await db.account.create({ data: { ...createSignedAccountContentBinding(),
        encryptionMode: "e2ee", settingsVersion: total + 1 } });
    transport.trackAccount?.(account.id);
    await db.accountSettingsSnapshot.createMany({ data: Array.from({ length: total }, (_, index) => ({
        accountId: account.id, version: index + 1, createdAt: new Date(1_700_000_000_000 + index),
        encryptionMode: "e2ee", contentKind: "encrypted",
        settingsDbValue: sealAccountScopedBlobCiphertext({ kind: "account_settings", material,
            payload: { futureHistoryValue: index }, randomBytes: length => tweetnacl.randomBytes(length) }),
    })) });
    const before = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id },
        orderBy: { version: "asc" }, select: { id: true, version: true, createdAt: true } });
    const items: AccountEncryptionMigrateSettingsHistoryDirective["items"] = [];
    let beforeVersion: number | undefined;
    const pageSizes: number[] = [];
    const readsPerPage: number[] = [];
    do {
        const measured = await inReadSnapshot(async tx => {
            const observer = observePrismaReads(tx, ["account", "accountSettingsSnapshot"]);
            const result = await readAccountSettingsEncryptionMigrationInventoryInTx({ tx: observer.tx,
                accountId: account.id, ...(beforeVersion === undefined ? {} : { beforeVersion }) });
            return { result, reads: observer.reads };
        });
        expect(measured.reads).toEqual(["account.findUnique", "accountSettingsSnapshot.findMany"]);
        readsPerPage.push(measured.reads.length);
        const response = await transport.request(account.id, { method: "GET",
            url: `/v1/account/encryption/migrate/settings-history/inventory${beforeVersion === undefined ? "" : `?beforeVersion=${beforeVersion}`}` });
        expect(response.statusCode).toBe(200);
        const page = AccountEncryptionMigrateSettingsHistoryInventoryPageSchema.safeParse(response.json());
        expect(page.success).toBe(true);
        if (!page.success || measured.result.status !== "ready") throw new Error("Paged history inventory unavailable");
        expect(JSON.stringify(measured.result.page) === JSON.stringify(page.data)).toBe(true);
        expect(JSON.stringify(page.data).includes("futureHistoryValue")).toBe(false);
        pageSizes.push(page.data.items.length);
        for (const item of page.data.items) {
            if (!item.content || item.content.t !== "encrypted") throw new Error("Unexpected encrypted history source");
            const opened = openAccountScopedBlobCiphertext({ kind: "account_settings", material, ciphertext: item.content.c });
            if (!opened) throw new Error("Recorded history could not be opened by authorized client");
            const plain = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: "plain", v: opened.value });
            if (!plain.success) throw new Error("Recorded history payload violated the envelope contract");
            items.push({ version: item.version, expectedContent: item.content, content: plain.data });
        }
        beforeVersion = page.data.nextBeforeVersion ?? undefined;
    } while (beforeVersion !== undefined);
    expect(pageSizes).toEqual([ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS, 1]);
    expect(items.length).toBe(total);
    const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
    const payload: AccountEncryptionMigrateRequest = {
        toMode: "plain", expectedAccountVersion: account.seq,
        expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
        expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        expectedSettingsVersion: account.settingsVersion, settingsContent: null, settingsHistory: { items },
        connectedServices: { action: "assert_empty" }, automations: { action: "assert_empty" },
        machines: { action: "assert_empty" }, todos: { action: "assert_empty" },
        artifacts: { action: "assert_empty" }, sessions: { action: "assert_empty" },
        reviewComments: { action: "assert_empty" }, sessionOrganization: { action: "assert_empty" }, pets: { action: "assert_empty" },
    };
    const converted = await transport.request(account.id, { method: "POST", url: "/v1/account/encryption/migrate", payload });
    expect(converted.statusCode).toBe(200);
    const after = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: "asc" } });
    expect(after.map(({ id, version, createdAt }) => ({ id, version, createdAt }))).toEqual(before);
    expect(after.every(row => row.encryptionMode === "plain" && row.contentKind === "plain"
        && JSON.stringify(accountSettingsSnapshotToContent(row)) === JSON.stringify({ t: "plain", v: { futureHistoryValue: row.version - 1 } }))).toBe(true);
    console.info("ENCHIST_HISTORY_PAGE_COST", JSON.stringify({ provider: process.env.HAPPIER_DB_PROVIDER,
        pageSizes, modelReadsPerPage: readsPerPage, convertedRows: after.length }));
}
