import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getOrCreateServerIdentityId, initializeServerIdentityCache, readCachedServerIdentityIdForHotPath } from "@/app/serverIdentity/serverIdentity";
import { getPublicUrl } from "@/storage/blob/files";
import {
    readRequiredAuthenticatedHomeConnectionDescriptor,
} from "@/app/features/homeConnectionDescriptorPublication";
import { createHomeConnectionDescriptorContinuityStoreForServer } from "@/app/features/homeConnectionDescriptorContinuity";
import type { HomeApprovalGate } from "@/app/auth/homeApprovalGateContract";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { assertAccountActive, InactiveAccountError } from "@/app/auth/accountStatus";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveEffectiveHomeSignInServicePolicy } from "@/app/auth/methods/signInServicePolicy";
import { AccountDirectoryError } from "./accountDirectoryErrors";
import {
    AccountDirectoryLinkPutRequestSchema,
    AccountDirectoryMeResponseSchema,
    AccountDirectoryHomePutRequestSchema,
    AccountDirectoryHomePutResponseV1Schema,
    AccountDirectoryHomesResponseV1Schema,
    HomeConnectionDescriptorV1Schema,
    HomeLoginAssertionV1Schema,
    HomeLoginCredentialPayloadV1Schema,
    HomeLoginRedemptionResultV1Schema,
    HomeLoginRedemptionResponseV1Schema,
    type AccountDirectoryMeResponseV1,
    type HomeConnectionDescriptorV1,
    type HomeLoginAssertionV1,
    type HomeLoginRedemptionResultV1,
} from "./accountDirectorySchemas";
import { isAccountIdentityEligibleForGenericPresentation } from "@/app/auth/methods/registry";
import {
    accountDirectorySigningKeyMetadata,
    mintHomeLoginAssertion,
    verifyHomeLoginAssertionSignature,
} from "./accountDirectorySigner";
import {
    ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES,
    computeCanonicalDomainSeparatedDigest,
    createHomeCredentialDestinationDigestV1,
    createHomeLoginAssertionSigningBytesV1,
    decodeBase64,
    encodeBase64,
    isValidBoxBundlePublicKey,
    sealBoxBundle,
} from "@happier-dev/protocol";

const HOME_DIRECTORY_ENTRY_SELECT = {
    homeServerIdentityId: true,
    canonicalServerUrl: true,
    label: true,
    connectionDescriptor: true,
    createdAt: true,
    updatedAt: true,
} as const satisfies Prisma.AccountHomeDirectoryEntrySelect;

type HomeDirectoryEntryRow = Prisma.AccountHomeDirectoryEntryGetPayload<{
    select: typeof HOME_DIRECTORY_ENTRY_SELECT;
}>;

const ACCOUNT_DIRECTORY_LINK_SELECT = {
    accountId: true,
    issuerServerIdentityId: true,
    issuerSubjectId: true,
    issuerSigningKeyId: true,
    issuerSigningPublicKey: true,
    createdAt: true,
} as const satisfies Prisma.AccountDirectoryLinkSelect;

type AccountDirectoryLinkRow = Prisma.AccountDirectoryLinkGetPayload<{
    select: typeof ACCOUNT_DIRECTORY_LINK_SELECT;
}>;

const HOME_LOGIN_APPROVAL_BINDING_DOMAIN_V1 =
    "happier.account-directory.home-approval-binding.v1" as const;

function createHomeLoginApprovalBindingProof(
    assertion: HomeLoginAssertionV1,
    link: AccountDirectoryLinkRow,
): string {
    return computeCanonicalDomainSeparatedDigest(HOME_LOGIN_APPROVAL_BINDING_DOMAIN_V1, [
        createHomeLoginAssertionSigningBytesV1(assertion),
        assertion.signatureBase64Url,
        link.accountId,
        link.issuerServerIdentityId,
        link.issuerSubjectId,
        link.issuerSigningKeyId,
        link.issuerSigningPublicKey,
        String(link.createdAt.getTime()),
    ]);
}

async function invalidateAccountAssertionApprovalsForLink(
    tx: Tx,
    link: AccountDirectoryLinkRow,
): Promise<void> {
    await tx.authPairingSession.deleteMany({
        where: {
            accountId: link.accountId,
            flow: "account_assertion",
            requesterIssuerServerIdentityId: link.issuerServerIdentityId,
            requesterIssuerSubjectId: link.issuerSubjectId,
        },
    });
}

function mapDescriptor(value: unknown): HomeConnectionDescriptorV1 {
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(value);
    if (!parsed.success) throw new AccountDirectoryError("invalid_request", "Invalid Home connection descriptor");
    return parsed.data;
}

function mapHomeRow(row: HomeDirectoryEntryRow, preferredHomeServerIdentityId: string | null) {
    const descriptor = mapDescriptor(row.connectionDescriptor);
    const mapped = {
        v: 1 as const,
        homeServerIdentityId: row.homeServerIdentityId,
        canonicalServerUrl: row.canonicalServerUrl,
        label: row.label,
        connectionDescriptor: descriptor,
        createdAtMs: row.createdAt.getTime(),
        updatedAtMs: row.updatedAt.getTime(),
        preferred: preferredHomeServerIdentityId === row.homeServerIdentityId,
    };
    const parsed = AccountDirectoryHomePutResponseV1Schema.safeParse(mapped);
    if (!parsed.success) throw new AccountDirectoryError("invalid_request", "Invalid stored Home directory entry");
    return parsed.data;
}

function descriptorsEqual(left: HomeConnectionDescriptorV1, right: HomeConnectionDescriptorV1): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export async function readAccountDirectoryMe(accountId: string): Promise<AccountDirectoryMeResponseV1> {
    const user = await inTx(tx => tx.account.findUnique({
        where: { id: accountId },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true,
            encryptionMode: true,
            AccountPasswordCredential: { select: { accountId: true } },
            AccountIdentity: { select: { provider: true, providerLogin: true }, orderBy: { provider: "asc" } },
        },
    }), { readOnly: true });
    if (!user) throw new AccountDirectoryError("not_found", "Account not found");
    const displayName = [user.firstName, user.lastName].filter((part): part is string => Boolean(part?.trim())).join(" ") || null;
    return AccountDirectoryMeResponseSchema.parse({
        v: 1,
        accountId: user.id,
        displayName,
        avatar: (() => {
            const avatar = user.avatar;
            if (!avatar || typeof avatar !== "object" || Array.isArray(avatar)) return null;
            const path = "path" in avatar ? avatar.path : null;
            return typeof path === "string" ? getPublicUrl(path) : null;
        })(),
        linkedAuthenticationMethods: user.AccountIdentity
            .filter((identity) => isAccountIdentityEligibleForGenericPresentation(process.env, identity.provider))
            .map((identity) => ({
                providerId: identity.provider,
                // The handle people know the identity by (GitHub username); a provider without
                // one reports none rather than leaking its opaque user id.
                login: identity.providerLogin ?? null,
            })),
        // The persisted mode is the authority (docs/encryption.md), never key presence. The login
        // email is not disclosed here; the unlock asks the person for it.
        recoveryKey: user.encryptionMode === "e2ee"
            ? user.AccountPasswordCredential ? "password_unlock" : "key_only"
            : "none",
    });
}

export async function listAccountHomeDirectory(accountId: string) {
    return inTx(async (tx) => {
        const account = await tx.account.findUnique({ where: { id: accountId }, select: { preferredHomeServerIdentityId: true } });
        if (!account) throw new AccountDirectoryError("not_found", "Account not found");
        const rows = await tx.accountHomeDirectoryEntry.findMany({
            where: { accountId },
            orderBy: [{ updatedAt: "desc" }, { homeServerIdentityId: "asc" }],
            select: HOME_DIRECTORY_ENTRY_SELECT,
        });
        return AccountDirectoryHomesResponseV1Schema.parse({
            v: 1 as const,
            preferredHomeServerIdentityId: account.preferredHomeServerIdentityId ?? null,
            homes: rows.map((row) => mapHomeRow(row, account.preferredHomeServerIdentityId ?? null)),
        });
    }, { readOnly: true });
}

async function upsertAccountHomeDirectoryEntryInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        homeServerIdentityId: string;
        label: string;
        preserveExistingLabel?: boolean;
        connectionDescriptor: HomeConnectionDescriptorV1;
    }>,
): Promise<ReturnType<typeof mapHomeRow>> {
    const account = await tx.account.findUnique({ where: { id: params.accountId }, select: { preferredHomeServerIdentityId: true } });
    if (!account) throw new AccountDirectoryError("not_found", "Account not found");
    const where = { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } };
    const existing = await tx.accountHomeDirectoryEntry.findUnique({
        where,
        select: HOME_DIRECTORY_ENTRY_SELECT,
    });
    const label = params.preserveExistingLabel && existing
        ? existing.label
        : params.label;
    const data = {
        canonicalServerUrl: params.connectionDescriptor.canonicalServerUrl,
        label,
        connectionDescriptor: params.connectionDescriptor,
    };
    const shouldAutoPrefer = account.preferredHomeServerIdentityId === null
        && !existing
        && (await tx.accountHomeDirectoryEntry.findFirst({
            where: { accountId: params.accountId },
            select: { homeServerIdentityId: true },
        })) === null;
    let row: HomeDirectoryEntryRow;
    if (!existing) {
        row = await tx.accountHomeDirectoryEntry.create({
            data: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId, ...data },
            select: HOME_DIRECTORY_ENTRY_SELECT,
        });
    } else {
        const currentDescriptor = mapDescriptor(existing.connectionDescriptor);
        const nextDescriptor = params.connectionDescriptor;
        if (nextDescriptor.revision < currentDescriptor.revision) {
            row = existing;
        } else if (nextDescriptor.revision === currentDescriptor.revision) {
            if (!descriptorsEqual(nextDescriptor, currentDescriptor)) {
                throw new AccountDirectoryError(
                    "descriptor_revision_conflict",
                    "Home descriptor revision conflicts with the current descriptor",
                );
            }
            row = label === existing.label
                ? existing
                : await tx.accountHomeDirectoryEntry.update({
                    where,
                    data: { label },
                    select: HOME_DIRECTORY_ENTRY_SELECT,
                });
        } else {
            row = await tx.accountHomeDirectoryEntry.update({ where, data, select: HOME_DIRECTORY_ENTRY_SELECT });
        }
    }
    let preferredHomeServerIdentityId = account.preferredHomeServerIdentityId ?? null;
    if (shouldAutoPrefer) {
        const preferred = await tx.account.updateMany({
            where: { id: params.accountId, preferredHomeServerIdentityId: null },
            data: { preferredHomeServerIdentityId: params.homeServerIdentityId },
        });
        if (preferred.count === 1) preferredHomeServerIdentityId = params.homeServerIdentityId;
        else {
            const refreshed = await tx.account.findUnique({
                where: { id: params.accountId },
                select: { preferredHomeServerIdentityId: true },
            });
            preferredHomeServerIdentityId = refreshed?.preferredHomeServerIdentityId ?? null;
        }
    }
    return mapHomeRow(row, preferredHomeServerIdentityId);
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
    return inTx((tx) => upsertAccountHomeDirectoryEntryInTx(tx, {
        accountId: params.accountId,
        homeServerIdentityId: params.homeServerIdentityId,
        label: body.label,
        connectionDescriptor: body.connectionDescriptor,
    }));
}

export async function deleteAccountHomeDirectoryEntry(params: Readonly<{ accountId: string; homeServerIdentityId: string }>): Promise<void> {
    await inTx(async (tx) => {
        await tx.accountHomeDirectoryEntry.deleteMany({ where: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } });
        await tx.account.updateMany({
            where: { id: params.accountId, preferredHomeServerIdentityId: params.homeServerIdentityId },
            data: { preferredHomeServerIdentityId: null },
        });
    });
}

export async function setPreferredAccountHome(params: Readonly<{ accountId: string; homeServerIdentityId: string | null }>): ReturnType<typeof listAccountHomeDirectory> {
    await inTx(async (tx) => {
        if (params.homeServerIdentityId !== null) {
            const exists = await tx.accountHomeDirectoryEntry.findUnique({
                where: { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } },
                select: { homeServerIdentityId: true },
            });
            if (!exists) throw new AccountDirectoryError("preferred_home_not_found", "Home is not present in the directory");
        }
        await tx.account.updateMany({ where: { id: params.accountId }, data: { preferredHomeServerIdentityId: params.homeServerIdentityId } });
    });
    return listAccountHomeDirectory(params.accountId);
}

function decodeAndValidateIssuerSigningPublicKey(params: Readonly<{
    issuerSigningKeyId: string;
    issuerSigningPublicKeyBase64Url: string;
}>): Uint8Array<ArrayBuffer> {
    let publicKey: Uint8Array;
    try {
        publicKey = decodeBase64(params.issuerSigningPublicKeyBase64Url, "base64url");
    } catch {
        throw new AccountDirectoryError("invalid_request", "Invalid issuer signing public key");
    }
    if (publicKey.length !== tweetnacl.sign.publicKeyLength) throw new AccountDirectoryError("invalid_request", "Invalid issuer signing public key");
    if (createHash("sha256").update(publicKey).digest("hex") !== params.issuerSigningKeyId) {
        throw new AccountDirectoryError("invalid_request", "Issuer signing key ID does not match the public key");
    }
    const storedPublicKey = new Uint8Array(publicKey.byteLength);
    storedPublicKey.set(publicKey);
    return storedPublicKey;
}

async function upsertAccountDirectoryLinkInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        issuerServerIdentityId: string;
        issuerSubjectId: string;
        issuerSigningKeyId: string;
        issuerSigningPublicKey: Uint8Array<ArrayBuffer>;
        relink?: boolean;
    }>,
): Promise<void> {
    const existing = await tx.accountDirectoryLink.findFirst({
        where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
        select: ACCOUNT_DIRECTORY_LINK_SELECT,
    });
    if (existing) {
        const subjectChanged = existing.issuerSubjectId !== params.issuerSubjectId;
        const keyIdChanged = existing.issuerSigningKeyId !== params.issuerSigningKeyId;
        const rawKeyChanged = !Buffer.from(existing.issuerSigningPublicKey).equals(Buffer.from(params.issuerSigningPublicKey));
        if (!subjectChanged && !keyIdChanged && !rawKeyChanged) return;
        if (params.relink !== true) {
            throw new AccountDirectoryError("directory_link_conflict", "Issuer link changes require explicit relink");
        }
        await invalidateAccountAssertionApprovalsForLink(tx, existing);
        if (subjectChanged) {
            await tx.accountDirectoryLink.deleteMany({
                where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
            });
            await tx.accountDirectoryLink.create({
                data: {
                    accountId: params.accountId,
                    issuerServerIdentityId: params.issuerServerIdentityId,
                    issuerSubjectId: params.issuerSubjectId,
                    issuerSigningKeyId: params.issuerSigningKeyId,
                    issuerSigningPublicKey: params.issuerSigningPublicKey,
                },
            });
            return;
        }
        await tx.accountDirectoryLink.update({
            where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: params.issuerServerIdentityId, issuerSubjectId: params.issuerSubjectId } },
            data: { issuerSigningKeyId: params.issuerSigningKeyId, issuerSigningPublicKey: params.issuerSigningPublicKey },
        });
        return;
    }
    await tx.accountDirectoryLink.create({
        data: {
            accountId: params.accountId,
            issuerServerIdentityId: params.issuerServerIdentityId,
            issuerSubjectId: params.issuerSubjectId,
            issuerSigningKeyId: params.issuerSigningKeyId,
            issuerSigningPublicKey: params.issuerSigningPublicKey,
        },
    });
}

export async function upsertAccountDirectoryLink(params: Readonly<{
    accountId: string;
    issuerServerIdentityId: string;
    issuerSubjectId: string;
    issuerSigningKeyId: string;
    issuerSigningPublicKeyBase64Url: string;
    relink?: boolean;
    bodyIssuerServerIdentityId?: string;
}>): Promise<void> {
    if (params.bodyIssuerServerIdentityId && params.bodyIssuerServerIdentityId !== params.issuerServerIdentityId) {
        throw new AccountDirectoryError("invalid_request", "Issuer identity does not match path");
    }
    const body = AccountDirectoryLinkPutRequestSchema.parse({
        v: 1,
        issuerServerIdentityId: params.issuerServerIdentityId,
        issuerSubjectId: params.issuerSubjectId,
        issuerSigningKeyId: params.issuerSigningKeyId,
        issuerSigningPublicKeyBase64Url: params.issuerSigningPublicKeyBase64Url,
        relink: params.relink ?? false,
    });
    const storedPublicKey = decodeAndValidateIssuerSigningPublicKey({
        issuerSigningKeyId: body.issuerSigningKeyId,
        issuerSigningPublicKeyBase64Url: body.issuerSigningPublicKeyBase64Url,
    });
    await inTx((tx) => upsertAccountDirectoryLinkInTx(tx, {
        accountId: params.accountId,
        issuerServerIdentityId: params.issuerServerIdentityId,
        issuerSubjectId: body.issuerSubjectId,
        issuerSigningKeyId: body.issuerSigningKeyId,
        issuerSigningPublicKey: storedPublicKey,
        relink: body.relink,
    }));
}

export async function deleteAccountDirectoryLink(params: Readonly<{ accountId: string; issuerServerIdentityId: string }>): Promise<void> {
    await inTx(async (tx) => {
        const existing = await tx.accountDirectoryLink.findFirst({
            where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
            select: ACCOUNT_DIRECTORY_LINK_SELECT,
        });
        const deleted = await tx.accountDirectoryLink.deleteMany({
            where: { accountId: params.accountId, issuerServerIdentityId: params.issuerServerIdentityId },
        });
        if (existing && deleted.count > 0) {
            await invalidateAccountAssertionApprovalsForLink(tx, existing);
        }
    });
}

export type SameServiceHomeEntryOutcome = Readonly<
    | { status: "ensured"; homeServerIdentityId: string; preferred: boolean }
    | {
        status: "not_dual_role";
        reason:
            | "sign_in_service_not_self"
            | "account_service_signing_metadata_unavailable"
            | "home_descriptor_unavailable"
            | "server_identity_mismatch";
    }
>;

export type SameServiceHomeEntryPreparation = Readonly<
    | SameServiceHomeEntryOutcome
    | {
        status: "ready";
        serverIdentityId: string;
        signingKeyId: string;
        signingPublicKey: Uint8Array<ArrayBuffer>;
        homeConnectionDescriptor: HomeConnectionDescriptorV1;
    }
>;

/**
 * The authoritative same-service decision: the one effective Home
 * sign-in-service composition, so a Home governance narrowing to `disabled`
 * refuses the dual-role bootstrap exactly as `/v1/auth/entry` and `/v1/features`
 * refuse to advertise the service. An unreadable Home policy fails closed the
 * same way. It runs inside the caller's write transaction, where the decision
 * and the rows it authorizes commit together.
 */
async function isSameServiceSignInSelfInTx(tx: Tx, env: NodeJS.ProcessEnv): Promise<boolean> {
    const effective = await resolveEffectiveHomeAuthMethodsInTx(tx, { env });
    return effective.status === "ready" && effective.signInService?.mode === "self";
}

/**
 * The deployment-level preflight, composed through the same owner with no
 * narrowing — the shape the synchronous `/v1/features` assembler uses, because
 * this runs before any transaction and must not open one: the finalize routes
 * call it while a concurrent finalization holds the row it will later write.
 * It is deliberately not the decision; the narrowing is applied in the
 * transaction above, which is the only place that authorizes a write.
 */
function isSameServiceSignInSelfForDeployment(env: NodeJS.ProcessEnv): boolean {
    return resolveEffectiveHomeSignInServicePolicy({
        envPolicy: resolveAuthPolicyFromEnv(env).signInService ?? null,
        narrowing: null,
        // The caller proved the Account Service signing metadata immediately
        // above, which is exactly this capability.
        accountDirectoryCapable: true,
    })?.mode === "self";
}

export async function prepareSameServiceHomeEntry(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    /** Narrow canonical-owner seam for owner tests; production resolves the live Home descriptor. */
    resolveHomeConnectionDescriptor?: HomeConnectionDescriptorResolver;
}>): Promise<SameServiceHomeEntryPreparation> {
    const env = params.env ?? process.env;
    // Signing metadata is read first: the effective sign-in-service decision
    // also withholds `self` when the Account Service cannot sign, and that
    // shared cause keeps its own diagnostic reason here.
    let signing: ReturnType<typeof accountDirectorySigningKeyMetadata>;
    try {
        signing = accountDirectorySigningKeyMetadata(env);
    } catch {
        return { status: "not_dual_role", reason: "account_service_signing_metadata_unavailable" };
    }
    if (!isSameServiceSignInSelfForDeployment(env)) {
        return { status: "not_dual_role", reason: "sign_in_service_not_self" };
    }
    const resolveHomeConnectionDescriptor = params.resolveHomeConnectionDescriptor
        ?? createCurrentHomeConnectionDescriptorResolver(env);
    const resolvedDescriptor = await resolveHomeConnectionDescriptor();
    const authoritativeDescriptor = resolvedDescriptor;
    if (!authoritativeDescriptor) {
        return { status: "not_dual_role", reason: "home_descriptor_unavailable" };
    }
    // The pinned link and the entry identity must name the exact issuer that
    // the existing assertion-mint owner signs with.
    const serverIdentityId = await getOrCreateServerIdentityId(env);
    if (authoritativeDescriptor.homeServerIdentityId !== serverIdentityId) {
        return { status: "not_dual_role", reason: "server_identity_mismatch" };
    }
    return {
        status: "ready",
        serverIdentityId,
        signingKeyId: signing.keyId,
        signingPublicKey: decodeAndValidateIssuerSigningPublicKey({
            issuerSigningKeyId: signing.keyId,
            issuerSigningPublicKeyBase64Url: signing.publicKeyBase64Url,
        }),
        homeConnectionDescriptor: authoritativeDescriptor,
    };
}

export async function ensureSameServiceHomeEntryInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        preparation: SameServiceHomeEntryPreparation;
        env?: NodeJS.ProcessEnv;
    }>,
): Promise<SameServiceHomeEntryOutcome> {
    if (params.preparation.status !== "ready") return params.preparation;
    const preparation = params.preparation;
    if (!(await isSameServiceSignInSelfInTx(tx, params.env ?? process.env))) {
        return { status: "not_dual_role", reason: "sign_in_service_not_self" };
    }
    const account = await tx.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { status: true } });
    assertAccountActive(account.status);
    await upsertAccountDirectoryLinkInTx(tx, {
        accountId: params.accountId,
        issuerServerIdentityId: preparation.serverIdentityId,
        issuerSubjectId: params.accountId,
        issuerSigningKeyId: preparation.signingKeyId,
        issuerSigningPublicKey: preparation.signingPublicKey,
    });
    const home = await upsertAccountHomeDirectoryEntryInTx(tx, {
        accountId: params.accountId,
        homeServerIdentityId: preparation.serverIdentityId,
        label: "Home",
        preserveExistingLabel: true,
        connectionDescriptor: preparation.homeConnectionDescriptor,
    });
    return {
        status: "ensured",
        homeServerIdentityId: home.homeServerIdentityId,
        preferred: home.preferred,
    };
}

export async function mintAccountHomeLoginAssertion(params: Readonly<{
    accountId: string;
    homeServerIdentityId: string;
    clientBoxPublicKeyBase64: string;
    env?: NodeJS.ProcessEnv;
}>): Promise<HomeLoginAssertionV1> {
    let clientKey: Uint8Array;
    try {
        clientKey = decodeBase64(params.clientBoxPublicKeyBase64, "base64");
    } catch {
        throw new AccountDirectoryError("invalid_request", "Invalid client public key");
    }
    if (
        clientKey.length !== tweetnacl.box.publicKeyLength
        || encodeBase64(clientKey, "base64") !== params.clientBoxPublicKeyBase64
    ) throw new AccountDirectoryError("invalid_request", "Invalid client public key");
    // A syntactically canonical low-order key would seal the assertion to a
    // shared secret unrelated private scalars can derive; reject it before
    // any directory work or signing.
    if (!isValidBoxBundlePublicKey(clientKey)) {
        throw new AccountDirectoryError("invalid_client_key", "Invalid client public key", 400);
    }
    const entry = await db.accountHomeDirectoryEntry.findUnique({
        where: { accountId_homeServerIdentityId: { accountId: params.accountId, homeServerIdentityId: params.homeServerIdentityId } },
        select: { homeServerIdentityId: true, canonicalServerUrl: true, connectionDescriptor: true },
    });
    if (!entry || entry.homeServerIdentityId !== params.homeServerIdentityId) throw new AccountDirectoryError("not_found", "Home is not present in the directory");
    const descriptor = mapDescriptor(entry.connectionDescriptor);
    if (descriptor.homeServerIdentityId !== params.homeServerIdentityId || descriptor.canonicalServerUrl !== entry.canonicalServerUrl) {
        throw new AccountDirectoryError("invalid_request", "Stored Home descriptor does not match its directory entry");
    }
    const account = await db.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { status: true } });
    assertAccountActive(account.status);
    return mintHomeLoginAssertion({
        issuerSubjectId: params.accountId,
        audienceHomeServerIdentityId: params.homeServerIdentityId,
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(descriptor),
        clientBoxPublicKeyBase64: params.clientBoxPublicKeyBase64,
        env: params.env,
    });
}

function validateAssertionAgainstLink(
    assertion: HomeLoginAssertionV1,
    link: AccountDirectoryLinkRow,
    nowMs: number | undefined,
): void {
    if (link.issuerServerIdentityId !== assertion.issuerServerIdentityId) {
        throw new AccountDirectoryError("assertion_issuer_untrusted");
    }
    if (link.issuerSubjectId !== assertion.issuerSubjectId) {
        throw new AccountDirectoryError("invalid_subject");
    }
    const keyId = link.issuerSigningKeyId;
    const publicKey = link.issuerSigningPublicKey;
    if (keyId !== assertion.keyId || createHash("sha256").update(publicKey).digest("hex") !== keyId) {
        throw new AccountDirectoryError("assertion_issuer_untrusted");
    }
    const signatureStatus = verifyHomeLoginAssertionSignature(assertion, publicKey, nowMs);
    if (signatureStatus === "expired") throw new AccountDirectoryError("assertion_expired");
    if (signatureStatus === "clock_skew") throw new AccountDirectoryError("assertion_clock_skew");
    if (signatureStatus !== "ok") throw new AccountDirectoryError("invalid_assertion");
}

export type HomeConnectionDescriptorResolver = (tx?: Tx) => Promise<HomeConnectionDescriptorV1 | undefined>;

function createCurrentHomeConnectionDescriptorResolver(
    env: NodeJS.ProcessEnv,
): HomeConnectionDescriptorResolver {
    return async (tx) => {
        // The canonical descriptor publication binds to the server identity
        // primed once at startup. Establish it through the canonical owner so
        // the dual-role classification cannot collapse the recoverable
        // "identity not yet established" fact into "not dual-role" in
        // entrypoints that register routes without the full startServer
        // sequence. No-op wherever startup already primed the cache; a
        // storage-less environment still fails soft to null and stays
        // classified not-dual-role.
        if (!tx) await initializeServerIdentityCache(env);
        const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(env);
        if (!continuityStore) return undefined;
        return readRequiredAuthenticatedHomeConnectionDescriptor({
            env,
            continuityStore,
            tx,
        });
    };
}

async function validateCredentialDestination(
    assertion: HomeLoginAssertionV1,
    resolveHomeConnectionDescriptor: HomeConnectionDescriptorResolver,
    tx?: Tx,
): Promise<void> {
    let descriptor: HomeConnectionDescriptorV1 | undefined;
    try {
        descriptor = await resolveHomeConnectionDescriptor(tx);
    } catch {
        throw new AccountDirectoryError(
            "home_redemption_unavailable",
            "Home connection descriptor is unavailable",
        );
    }
    if (!descriptor) {
        throw new AccountDirectoryError(
            "home_redemption_unavailable",
            "Home connection descriptor is unavailable",
        );
    }
    if (
        createHomeCredentialDestinationDigestV1(descriptor)
        !== assertion.credentialDestinationDigestBase64Url
    ) {
        throw new AccountDirectoryError(
            "credential_destination_mismatch",
            "Home credential destination does not match the assertion",
        );
    }
}

export async function redeemHomeLoginAssertion(params: Readonly<{
    assertion: unknown;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    approvalId?: string;
    /** Narrow canonical-owner seam for owner tests; production resolves the live Home descriptor. */
    resolveHomeConnectionDescriptor?: HomeConnectionDescriptorResolver;
    /** Home/Lane-05 owns approval and final Home-local token issuance. */
    homeApprovalGate?: HomeApprovalGate;
    issueHomeToken?: (tx: Tx, accountId: string) => Promise<string>;
}>): Promise<HomeLoginRedemptionResultV1> {
    const parsed = HomeLoginAssertionV1Schema.safeParse(params.assertion);
    if (!parsed.success) throw new AccountDirectoryError("invalid_assertion", "Invalid Home login assertion");
    const assertion = parsed.data;
    const currentServerIdentityId = readCachedServerIdentityIdForHotPath(params.env ?? process.env);
    if (!currentServerIdentityId) throw new AccountDirectoryError("home_redemption_unavailable", "Home identity is not established");
    if (assertion.audienceHomeServerIdentityId !== currentServerIdentityId) throw new AccountDirectoryError("assertion_wrong_audience");
    const link: AccountDirectoryLinkRow | null = await db.accountDirectoryLink.findUnique({
        where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: assertion.issuerServerIdentityId, issuerSubjectId: assertion.issuerSubjectId } },
        select: ACCOUNT_DIRECTORY_LINK_SELECT,
    });
    if (!link) {
        const issuerLink = await db.accountDirectoryLink.findFirst({
            where: { issuerServerIdentityId: assertion.issuerServerIdentityId },
            select: { issuerSubjectId: true },
        });
        throw new AccountDirectoryError(issuerLink ? "invalid_subject" : "directory_link_not_found");
    }
    validateAssertionAgainstLink(assertion, link, params.nowMs);
    let clientPublicKey: Uint8Array;
    try { clientPublicKey = decodeBase64(assertion.clientBoxPublicKeyBase64, "base64"); } catch { throw new AccountDirectoryError("invalid_client_key"); }
    // The sealed token must be bound to this exact high-order client key;
    // low-order keys defeat that binding and are rejected before the approval
    // gate or any token issuance.
    if (!isValidBoxBundlePublicKey(clientPublicKey)) throw new AccountDirectoryError("invalid_client_key");
    const resolveHomeConnectionDescriptor = params.resolveHomeConnectionDescriptor
        ?? createCurrentHomeConnectionDescriptorResolver(params.env ?? process.env);
    await validateCredentialDestination(assertion, resolveHomeConnectionDescriptor);
    const eligibility = await enforceLoginEligibility({
        accountId: link.accountId,
        env: params.env ?? process.env,
    });
    if (!eligibility.ok) {
        if (eligibility.error === "account-disabled") throw new AccountDirectoryError("account_disabled");
        throw new AccountDirectoryError("home_unavailable", eligibility.error, eligibility.statusCode);
    }
    // Account Service assertions are inputs to the target Home only. The gate
    // and token issuer are injected from the Home auth/pairing owner; without
    // that owner this route fails closed and cannot mint an Account token.
    if (!params.homeApprovalGate) {
        throw new AccountDirectoryError("home_redemption_unavailable", "Home approval gate is unavailable");
    }
    const decision = await params.homeApprovalGate.evaluate({
        accountId: link.accountId,
        issuerServerIdentityId: assertion.issuerServerIdentityId,
        issuerSubjectId: assertion.issuerSubjectId,
        requesterBoxPublicKeyBase64: assertion.clientBoxPublicKeyBase64,
        approvalBindingProof: createHomeLoginApprovalBindingProof(assertion, link),
        assertionExpiresAtMs: assertion.expiresAtMs,
        deviceLabel: null,
        ...(params.approvalId ? { approvalId: params.approvalId } : {}),
    });
    if (decision.kind === "approval_required") {
        return HomeLoginRedemptionResultV1Schema.parse({
            v: 1,
            outcome: "approval_required",
            homeServerIdentityId: currentServerIdentityId,
            approvalId: decision.request.approvalId,
            deviceLabel: decision.request.deviceLabel,
            expiresAtMs: Math.min(decision.request.expiresAtMs, assertion.expiresAtMs),
        });
    }
    if (decision.kind !== "allowed") {
        const code = decision.kind === "rejected"
            ? "approval_rejected"
            : decision.kind === "expired"
                ? "approval_expired"
                : "approval_invalid";
        throw new AccountDirectoryError(code);
    }
    const issueHomeToken = params.issueHomeToken;
    if (!issueHomeToken) throw new AccountDirectoryError("home_redemption_unavailable", "Home token issuer is unavailable");
    const issuedAtMs = params.nowMs ?? Date.now();
    const token = await inTx(async (tx) => {
        const currentLink: AccountDirectoryLinkRow | null = await tx.accountDirectoryLink.findUnique({
            where: { issuerServerIdentityId_issuerSubjectId: { issuerServerIdentityId: assertion.issuerServerIdentityId, issuerSubjectId: assertion.issuerSubjectId } },
            select: ACCOUNT_DIRECTORY_LINK_SELECT,
        });
        if (!currentLink) {
            if (decision.approvedRequest) {
                throw new AccountDirectoryError("approval_invalid", "Home approval no longer matches a current directory link");
            }
            const currentIssuerLink = await tx.accountDirectoryLink.findFirst({
                where: { issuerServerIdentityId: assertion.issuerServerIdentityId },
                select: { issuerSubjectId: true },
            });
            throw new AccountDirectoryError(currentIssuerLink ? "invalid_subject" : "directory_link_not_found");
        }
        if (currentLink.accountId !== link.accountId) {
            throw new AccountDirectoryError(
                decision.approvedRequest ? "approval_invalid" : "assertion_issuer_untrusted",
            );
        }
        try {
            validateAssertionAgainstLink(assertion, currentLink, params.nowMs);
        } catch (error) {
            if (decision.approvedRequest) {
                throw new AccountDirectoryError("approval_invalid", "Home approval no longer matches the current directory link");
            }
            throw error;
        }
        let currentApprovalExpiresAtMs: number | null = null;
        if (decision.approvedRequest) {
            const currentBindingProof = createHomeLoginApprovalBindingProof(assertion, currentLink);
            if (currentBindingProof !== decision.approvedRequest.bindingProof) {
                throw new AccountDirectoryError("approval_invalid", "Home approval no longer matches the current directory link");
            }
            const currentApproval = await tx.authPairingSession.findFirst({
                where: {
                    id: decision.approvedRequest.approvalId,
                    accountId: currentLink.accountId,
                    flow: "account_assertion",
                    approvalStatus: "approved",
                    expiresAt: { gt: new Date() },
                    requestedBindingProof: currentBindingProof,
                },
                select: { id: true, expiresAt: true },
            });
            if (!currentApproval) {
                throw new AccountDirectoryError("approval_invalid", "Home approval is no longer current");
            }
            currentApprovalExpiresAtMs = currentApproval.expiresAt.getTime();
        }
        // Approval binds the assertion signing bytes, including the destination
        // digest. Re-read the canonical Home owner after every transactional
        // trust check and immediately before issuance, so a destination change
        // while approval was pending cannot produce a usable Home credential.
        await validateCredentialDestination(assertion, resolveHomeConnectionDescriptor, tx);
        if (params.nowMs === undefined) {
            const issuanceBoundaryNowMs = Date.now();
            if (assertion.expiresAtMs <= issuanceBoundaryNowMs) {
                throw new AccountDirectoryError("assertion_expired");
            }
            if (
                decision.approvedRequest
                && currentApprovalExpiresAtMs !== null
                && currentApprovalExpiresAtMs <= issuanceBoundaryNowMs
            ) {
                throw new AccountDirectoryError("approval_expired");
            }
        }
        const account = await tx.account.findUniqueOrThrow({ where: { id: currentLink.accountId }, select: { status: true } });
        try {
            assertAccountActive(account.status);
            return await issueHomeToken(tx, currentLink.accountId);
        } catch (error) {
            // This path has validated the fresh assertion, destination and
            // approval. Only this proof-complete boundary may reveal status.
            if (error instanceof InactiveAccountError) throw new AccountDirectoryError("account_disabled");
            throw error;
        }
    });
    const credentialPayload = HomeLoginCredentialPayloadV1Schema.safeParse({ token });
    if (!credentialPayload.success) {
        throw new AccountDirectoryError("home_redemption_unavailable", "Home token issuer returned invalid credentials");
    }
    const credentialPlaintext = new TextEncoder().encode(JSON.stringify(credentialPayload.data));
    if (credentialPlaintext.byteLength > ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES) {
        throw new AccountDirectoryError("home_redemption_unavailable", "Home credential payload exceeds its plaintext bound");
    }
    return HomeLoginRedemptionResponseV1Schema.parse({
        v: 1,
        homeServerIdentityId: currentServerIdentityId,
        sealedHomeTokenBase64Url: encodeBase64(sealBoxBundle({
            plaintext: credentialPlaintext,
            recipientPublicKey: clientPublicKey,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
        }), "base64url"),
        issuedAtMs,
        // The wire name is locked. This is the assertion/redemption validity
        // window; the ordinary Home credential itself remains durable.
        expiresAtMs: assertion.expiresAtMs,
    });
}
