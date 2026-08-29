import * as privacyKit from "privacy-kit";
import { createHash, randomBytes } from "node:crypto";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { encodeBase64, sealBoxBundle } from "@happier-dev/protocol";
import { getPublicUrl } from "@/storage/blob/files";
import {
    AccountDirectoryError,
} from "./accountDirectoryErrors";
import {
    AccountDirectoryLinkPutRequestSchema,
    AccountDirectoryMeResponseSchema,
    AccountDirectoryHomePutRequestSchema,
    HomeConnectionDescriptorV1Schema,
    HomeLoginAssertionV1Schema,
    HomeLoginRedemptionResponseV1Schema,
    type AccountDirectoryMeResponseV1,
    type HomeConnectionDescriptorV1,
    type HomeLoginAssertionV1,
    type HomeLoginRedemptionResponseV1,
} from "./accountDirectorySchemas";
import {
    mintHomeLoginAssertion,
    verifyHomeLoginAssertionSignature,
} from "./accountDirectorySigner";

type Delegate = Readonly<{
    findUnique: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
    upsert?: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
}>;

type DirectoryDb = Readonly<{
    accountHomeDirectoryEntry: Delegate;
    accountDirectoryLink: Delegate;
}>;

function directoryDb(value: unknown = db): DirectoryDb {
    return value as DirectoryDb;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringField(value: unknown, name: string): string {
    const candidate = record(value)[name];
    return typeof candidate === "string" ? candidate : "";
}

function mapDescriptor(value: unknown): HomeConnectionDescriptorV1 {
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(value);
    if (!parsed.success) throw new AccountDirectoryError("invalid_request", "Invalid Home connection descriptor");
    return parsed.data;
}

function mapHomeRow(row: unknown, preferredHomeServerIdentityId: string | null) {
    const value = record(row);
    const homeServerIdentityId = stringField(value, "homeServerIdentityId");
    const descriptor = mapDescriptor(value.connectionDescriptor);
    return {
        v: 1 as const,
        homeServerIdentityId,
        canonicalServerUrl: stringField(value, "canonicalServerUrl"),
        label: stringField(value, "label"),
        connectionDescriptor: descriptor,
        createdAtMs: value.createdAt instanceof Date ? value.createdAt.getTime() : Number(value.createdAt ?? 0),
        updatedAtMs: value.updatedAt instanceof Date ? value.updatedAt.getTime() : Number(value.updatedAt ?? 0),
        preferred: preferredHomeServerIdentityId === homeServerIdentityId,
    };
}

export async function readAccountDirectoryMe(accountId: string): Promise<AccountDirectoryMeResponseV1> {
    const user = await db.account.findUnique({
        where: { id: accountId },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true,
            AccountIdentity: { select: { provider: true, providerUserId: true }, orderBy: { provider: "asc" } },
        },
    });
    if (!user) throw new AccountDirectoryError("not_found", "Account not found");
    const displayName = [user.firstName, user.lastName].filter((part): part is string => Boolean(part?.trim())).join(" ") || null;
    return AccountDirectoryMeResponseSchema.parse({
        v: 1,
        accountId: user.id,
        displayName,
        avatar: (() => {
            const avatar = user.avatar;
            if (!avatar || typeof avatar !== "object" || Array.isArray(avatar)) return null;
            const path = (avatar as Record<string, unknown>).path;
            return typeof path === "string" ? getPublicUrl(path) : null;
        })(),
        linkedAuthenticationMethods: user.AccountIdentity.map((identity) => ({
            providerId: identity.provider,
            login: identity.providerUserId,
        })),
    });
}

export async function listAccountHomeDirectory(accountId: string) {
    const account = await db.account.findUnique({ where: { id: accountId }, select: { preferredHomeServerIdentityId: true } });
    if (!account) throw new AccountDirectoryError("not_found", "Account not found");
    const rows = await directoryDb().accountHomeDirectoryEntry.findMany({
        where: { accountId },
        orderBy: [{ updatedAt: "desc" }, { homeServerIdentityId: "asc" }],
    });
    return {
        v: 1 as const,
        preferredHomeServerIdentityId: account.preferredHomeServerIdentityId ?? null,
        homes: (Array.isArray(rows) ? rows : []).map((row) => mapHomeRow(row, account.preferredHomeServerIdentityId ?? null)),
    };
}

export async function upsertAccountHomeDirectoryEntry(params: Readonly<{
    accountId: string;
    homeServerIdentityId: string;
    label: string;
    connectionDescriptor: unknown;
}>): Promise<ReturnType<typeof mapHomeRow>> {
    const body = AccountDirectoryHomePutRequestSchema.parse({
        v: 1,
        label: params.label,
        connectionDescriptor: params.connectionDescriptor,
    });
    if (body.connectionDescriptor.homeServerIdentityId !== params.homeServerIdentityId) {
        throw new AccountDirectoryError("invalid_request", "Home identity does not match descriptor");
    }
    if (body.canonicalServerUrl && body.canonicalServerUrl !== body.connectionDescriptor.canonicalServerUrl) {
        throw new AccountDirectoryError("invalid_request", "Canonical URL does not match descriptor");
    }
    const row = await directoryDb().accountHomeDirectoryEntry.upsert?.({
        where: { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } },
        create: {
            accountId: params.accountId,
            homeServerIdentityId: params.homeServerIdentityId,
            canonicalServerUrl: body.connectionDescriptor.canonicalServerUrl,
            label: body.label,
            connectionDescriptor: body.connectionDescriptor,
        },
        update: {
            canonicalServerUrl: body.connectionDescriptor.canonicalServerUrl,
            label: body.label,
            connectionDescriptor: body.connectionDescriptor,
        },
    });
    if (!row) throw new Error("Account directory model does not support upsert");
    const account = await db.account.findUnique({ where: { id: params.accountId }, select: { preferredHomeServerIdentityId: true } });
    return mapHomeRow(row, account?.preferredHomeServerIdentityId ?? null);
}

export async function deleteAccountHomeDirectoryEntry(params: Readonly<{ accountId: string; homeServerIdentityId: string }>): Promise<void> {
    await inTx(async (tx) => {
        const models = directoryDb(tx);
        await models.accountHomeDirectoryEntry.deleteMany({ where: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } });
        await tx.account.updateMany({
            where: { id: params.accountId, preferredHomeServerIdentityId: params.homeServerIdentityId },
            data: { preferredHomeServerIdentityId: null },
        });
    });
}

export async function setPreferredAccountHome(params: Readonly<{ accountId: string; homeServerIdentityId: string }>): ReturnType<typeof listAccountHomeDirectory> {
    if (params.homeServerIdentityId === null) {
        await db.account.update({ where: { id: params.accountId }, data: { preferredHomeServerIdentityId: null } });
        return listAccountHomeDirectory(params.accountId);
    }
    const exists = await directoryDb().accountHomeDirectoryEntry.findUnique({
        where: { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } },
        select: { homeServerIdentityId: true },
    });
    if (!exists) throw new AccountDirectoryError("preferred_home_not_found", "Home is not present in the directory");
    await db.account.update({ where: { id: params.accountId }, data: { preferredHomeServerIdentityId: params.homeServerIdentityId } });
    return listAccountHomeDirectory(params.accountId);
}

export async function upsertAccountDirectoryLink(params: Readonly<{
    accountId: string;
    issuerServerIdentityId: string;
    issuerSubjectId: string;
    issuerSigningKeyId: string;
    issuerSigningPublicKeyBase64Url: string;
}>): Promise<void> {
    const body = AccountDirectoryLinkPutRequestSchema.parse({
        v: 1,
        issuerServerIdentityId: params.issuerServerIdentityId,
        issuerSubjectId: params.issuerSubjectId,
        issuerSigningKeyId: params.issuerSigningKeyId,
        issuerSigningPublicKeyBase64Url: params.issuerSigningPublicKeyBase64Url,
    });
    let publicKey: Uint8Array;
    try {
        publicKey = privacyKit.decodeBase64(body.issuerSigningPublicKeyBase64Url);
    } catch {
        throw new AccountDirectoryError("invalid_request", "Invalid issuer signing public key");
    }
    if (publicKey.length !== tweetnacl.sign.publicKeyLength) throw new AccountDirectoryError("invalid_request", "Invalid issuer signing public key");
    const existing = await directoryDb().accountDirectoryLink.findFirst?.({
        where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
    });
    if (existing) {
        const current = record(existing);
        if (stringField(current, "issuerSubjectId") !== body.issuerSubjectId) {
            if (body.relink !== true) {
                throw new AccountDirectoryError("directory_link_conflict", "Issuer is already linked to another subject");
            }
            await directoryDb().accountDirectoryLink.deleteMany({
                where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
            });
            await directoryDb().accountDirectoryLink.create({
                data: {
                    accountId: params.accountId,
                    issuerServerIdentityId: params.issuerServerIdentityId,
                    issuerSubjectId: body.issuerSubjectId,
                    issuerSigningKeyId: body.issuerSigningKeyId,
                    issuerSigningPublicKey: publicKey,
                },
            });
            return;
        }
        await directoryDb().accountDirectoryLink.update({
            where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: params.issuerServerIdentityId, issuerSubjectId: body.issuerSubjectId } },
            data: { issuerSigningKeyId: body.issuerSigningKeyId, issuerSigningPublicKey: publicKey },
        });
        return;
    }
    await directoryDb().accountDirectoryLink.create({
        data: {
            accountId: params.accountId,
            issuerServerIdentityId: params.issuerServerIdentityId,
            issuerSubjectId: body.issuerSubjectId,
            issuerSigningKeyId: body.issuerSigningKeyId,
            issuerSigningPublicKey: publicKey,
        },
    });
}

export async function deleteAccountDirectoryLink(params: Readonly<{ accountId: string; issuerServerIdentityId: string }>): Promise<void> {
    await directoryDb().accountDirectoryLink.deleteMany({ where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId } });
}

export async function mintAccountHomeLoginAssertion(params: Readonly<{
    accountId: string;
    homeServerIdentityId: string;
    clientBoxPublicKeyBase64: string;
    env?: NodeJS.ProcessEnv;
}>): Promise<HomeLoginAssertionV1> {
    let clientKey: Uint8Array;
    try {
        clientKey = privacyKit.decodeBase64(params.clientBoxPublicKeyBase64);
    } catch {
        throw new AccountDirectoryError("invalid_request", "Invalid client public key");
    }
    if (clientKey.length !== tweetnacl.box.publicKeyLength) throw new AccountDirectoryError("invalid_request", "Invalid client public key");
    const entry = await directoryDb().accountHomeDirectoryEntry.findUnique({
        where: { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } },
        select: { homeServerIdentityId: true, connectionDescriptor: true },
    });
    if (!entry || stringField(entry, "homeServerIdentityId") !== params.homeServerIdentityId) throw new AccountDirectoryError("not_found", "Home is not present in the directory");
    mapDescriptor(record(entry).connectionDescriptor);
    return mintHomeLoginAssertion({
        issuerSubjectId: params.accountId,
        audienceHomeServerIdentityId: params.homeServerIdentityId,
        clientBoxPublicKeyBase64: params.clientBoxPublicKeyBase64,
        env: params.env,
    });
}

export async function redeemHomeLoginAssertion(params: Readonly<{
    assertion: unknown;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
}>): Promise<HomeLoginRedemptionResponseV1> {
    const parsed = HomeLoginAssertionV1Schema.safeParse(params.assertion);
    if (!parsed.success) throw new AccountDirectoryError("invalid_assertion", "Invalid Home login assertion");
    const assertion = parsed.data;
    const currentServerIdentityId = await getOrCreateServerIdentityId(params.env ?? process.env);
    if (assertion.audienceHomeServerIdentityId !== currentServerIdentityId) throw new AccountDirectoryError("assertion_wrong_audience");
    const link = await directoryDb().accountDirectoryLink.findUnique({
        where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: assertion.issuerServerIdentityId, issuerSubjectId: assertion.issuerSubjectId } },
    });
    if (!link) throw new AccountDirectoryError("assertion_issuer_untrusted", "No matching Account Service link");
    const linkValue = record(link);
    const keyId = stringField(linkValue, "issuerSigningKeyId");
    const publicKeyRaw = linkValue.issuerSigningPublicKey;
    const publicKey = publicKeyRaw instanceof Uint8Array ? publicKeyRaw : Buffer.isBuffer(publicKeyRaw) ? new Uint8Array(publicKeyRaw) : null;
    if (!publicKey || keyId !== assertion.keyId || createHash("sha256").update(publicKey).digest("hex") !== keyId) throw new AccountDirectoryError("assertion_issuer_untrusted");
    const signatureStatus = verifyHomeLoginAssertionSignature(assertion, publicKey, params.nowMs);
    if (signatureStatus === "expired") throw new AccountDirectoryError("assertion_expired");
    if (signatureStatus !== "ok") throw new AccountDirectoryError("invalid_assertion");
    let clientPublicKey: Uint8Array;
    try { clientPublicKey = privacyKit.decodeBase64(assertion.clientBoxPublicKeyBase64); } catch { throw new AccountDirectoryError("assertion_client_key_mismatch"); }
    if (clientPublicKey.length !== tweetnacl.box.publicKeyLength) throw new AccountDirectoryError("assertion_client_key_mismatch");
    const issuedAtMs = params.nowMs ?? Date.now();
    await auth.init();
    const token = await auth.createToken(stringField(linkValue, "accountId"));
    return HomeLoginRedemptionResponseV1Schema.parse({
        v: 1,
        outcome: "authorized",
        homeServerIdentityId: currentServerIdentityId,
        sealedHomeTokenBase64Url: encodeBase64(sealBoxBundle({
            plaintext: new TextEncoder().encode(token),
            recipientPublicKey: clientPublicKey,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
        }), "base64url"),
        issuedAtMs,
        expiresAtMs: assertion.expiresAtMs,
    });
}
