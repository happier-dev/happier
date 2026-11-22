import { randomBytes } from "node:crypto";
import * as privacyKit from "privacy-kit";
import {
    TeamCredentialExternalApiKeyCreateInputV1Schema,
    TeamCredentialExternalApiKeyAuthorizeInputV1Schema,
    TeamCredentialExternalApiKeySummaryV1Schema,
    createTeamCredentialExternalApiKeyDisplayPrefixV1,
    formatTeamCredentialExternalApiKeyV1,
    parseTeamCredentialExternalApiKeyV1,
    type TeamCredentialExternalApiKeyCreateInputV1,
    type TeamCredentialExternalApiKeyCreateOutputV1,
    type TeamCredentialExternalApiKeyListOutputV1,
    type TeamCredentialExternalApiKeySummaryV1,
} from "@happier-dev/protocol/teams";
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '@happier-dev/protocol/auth/authToken';
import { parseAuthenticationEvidenceSnapshot, resolveCurrentAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";
import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";
import { AccountStatus } from "@/storage/enums.generated";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { publishTeamChangedInTx } from "../teamChanges";
import { resolveTeamCredentialEntitlementInTx } from "./resourceAccess";
import {
    recordTeamCredentialExternalApiKeyActivityInTx,
    type TeamCredentialActivityActor,
} from "./resourceActivity";
import { createSha256SecretDigest, sha256SecretDigestMatches } from "../../auth/secretDigest";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { admitTeamCredentialWithdrawalInTx } from "./resourceWithdrawalAdmission";
import { readTeamCredentialSourceBinding } from "./sourceBindingRead";
import {
    prepareTeamCredentialExternalApiKeyLabelForWriteInTx,
    projectTeamCredentialExternalApiKeyLabelForRecipient,
    readTeamCredentialExternalApiKeyLabelStored,
} from './privateLabels';

const EXTERNAL_API_KEY_SECRET_BYTES = 32;

type ExternalApiKeyRow = Readonly<{
    id: string;
    resourceId: string;
    teamMembershipId: string;
    label: string;
    displayPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    authenticationEvidence: unknown;
    membership: Readonly<{ accountId: string }>;
    resource: Readonly<{ team: Readonly<{ id: string; authenticationPolicy: unknown }> }>;
}>;

const SUMMARY_SELECT = {
    id: true, resourceId: true, teamMembershipId: true, label: true, displayPrefix: true,
    createdAt: true, lastUsedAt: true, expiresAt: true, authenticationEvidence: true,
    membership: { select: { accountId: true } },
    resource: { select: { custodianAccountId: true, team: { select: { id: true, authenticationPolicy: true } } } },
} as const;

export type CreateTeamCredentialExternalApiKeyResult =
    | Readonly<{ ok: true; token: string; key: TeamCredentialExternalApiKeyCreateOutputV1["key"] }>
    | Readonly<{ ok: false; error: "invalid_resource_input" | "resource_not_found" | "resource_forbidden" | "member_not_eligible" | "session_policy_incompatible" | "resource_changed" | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export type ListTeamCredentialExternalApiKeysResult =
    | Readonly<{ ok: true; keys: TeamCredentialExternalApiKeyListOutputV1["keys"] }>
    | Readonly<{ ok: false; error: "invalid_resource_input" | "resource_not_found" | "resource_forbidden" | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export type RevokeTeamCredentialExternalApiKeyResult =
    | Readonly<{ ok: true; keyId: string; revoked: boolean }>
    | Readonly<{ ok: false; error: "invalid_resource_input" | "resource_not_found" | "resource_forbidden" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export type RevokeAllTeamCredentialExternalApiKeysResult =
    | Readonly<{ ok: true; resourceId: string; revokedCount: number }>
    | Readonly<{ ok: false; error: "invalid_resource_input" | "resource_not_found" | "resource_forbidden" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export type VerifyTeamCredentialExternalApiKeyResult =
    | Readonly<{
        ok: true;
        keyId: string;
        resourceId: string;
        teamId: string;
        assignedAccountId: string;
        assignedTeamMembershipId: string;
        custodianAccountId: string;
        brokerMachineId: string | null;
        brokerPoolId: string | null;
        expiresAt: Date | null;
    }>
    | Readonly<{ ok: false; reason: "invalid_token" }>;

export type CurrentTeamCredentialExternalApiKeyAuthorityResult =
    | Readonly<{
        ok: true;
        keyId: string;
        resourceId: string;
        teamId: string;
        assignedAccountId: string;
        assignedTeamMembershipId: string;
        custodianAccountId: string;
        brokerMachineId: string | null;
        brokerPoolId: string | null;
        resourceRevision: number;
        sourceBindingJson: string;
        currentBrokerOperationJson: string | null;
        expiresAt: Date | null;
    }>
    | Readonly<{ ok: false; reason: "operation_not_current" | "resource_forbidden" }>;

function digestSecret(secret: string): string {
    return privacyKit.encodeBase64(new Uint8Array(createSha256SecretDigest(secret)), "base64url").replace(/=+$/u, "");
}

function digestMatches(storedDigest: string, suppliedSecret: string): boolean {
    return sha256SecretDigestMatches(storedDigest, suppliedSecret);
}

async function project(tx: Tx, row: ExternalApiKeyRow, actorAccountId: string, env = process.env): Promise<TeamCredentialExternalApiKeySummaryV1 | null> {
    const qualification = await qualifyTeamAuthenticationInTx(tx, {
        env, team: row.resource.team, accountId: row.membership.accountId,
        verifiedCredentialEvidence: parseAuthenticationEvidenceSnapshot(row.authenticationEvidence)?.evidence,
        operationContext: { kind: "account_automation" },
    });
    const entitlement = row.membership.accountId === actorAccountId
        ? await resolveTeamCredentialEntitlementInTx(tx, { resourceId: row.resourceId, accountId: actorAccountId })
        : null;
    const label = projectTeamCredentialExternalApiKeyLabelForRecipient({
        serialized: row.label,
        recipientAccountId: actorAccountId,
    });
    if (label === null) return null;
    return TeamCredentialExternalApiKeySummaryV1Schema.parse({
        keyId: row.id,
        resourceId: row.resourceId,
        teamMembershipId: row.teamMembershipId,
        label,
        displayPrefix: row.displayPrefix,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        authenticationStatus: qualification.status,
        canAuthorize: entitlement?.ok === true && entitlement.mayBroker
            && (row.expiresAt === null || row.expiresAt > new Date()),
    });
}

type ManagedTeamCredentialResource = Readonly<{
    id: string;
    teamId: string;
    custodianAccountId: string;
    sessionUsePolicy: string;
    sourceBindingJson: string;
}>;

/** Qualified Provider purposes are available to admitted Team Sessions and Runs. */
function isConnectedAccountProviderPurposeSource(sourceBindingJson: string): boolean {
    const source = readTeamCredentialSourceBinding(sourceBindingJson);
    return source.success && source.data.kind === "connected_account" && source.data.providerPurpose !== undefined;
}

/**
 * Outcome of the shared manager-authority preflight. Tagged so callers narrow a
 * real discriminated union instead of probing an optional qualification.
 */
type ManagedExternalApiKeyResource =
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "forbidden" }>
    | Readonly<{
        status: "unqualified";
        error: "team_authentication_required" | "team_authentication_policy_unavailable";
    }>
    | Readonly<{ status: "authorized"; resource: ManagedTeamCredentialResource }>;

/** Manager authority and the manager's own authentication are independent of assigned-key proof. */
async function resolveManagedResourceInTx(tx: Tx, input: Readonly<{
    resourceId: string;
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
}>): Promise<ManagedExternalApiKeyResource> {
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
    if (!resource) return { status: "missing" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: input.actorAccountId });
    if (!actor || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials) {
        return { status: "forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return { status: "unqualified", error: qualification.error };
    return { status: "authorized", resource };
}

function validExpiry(expiresAt: string | null, now: Date): Date | null | undefined {
    if (expiresAt === null) return null;
    const parsed = new Date(expiresAt);
    return Number.isFinite(parsed.getTime()) && parsed > now ? parsed : undefined;
}

/** Creates a resource-scoped bearer after re-reading both manager authority and assigned membership access. */
export async function createTeamCredentialExternalApiKeyInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; authentication: TeamOperationAuthenticationContext } & TeamCredentialExternalApiKeyCreateInputV1>,
    nowInput: Date = new Date(),
): Promise<CreateTeamCredentialExternalApiKeyResult> {
    const { actorAccountId, authentication, ...credentialInput } = input;
    const parsed = TeamCredentialExternalApiKeyCreateInputV1Schema.safeParse(credentialInput);
    if (!parsed.success) return { ok: false, error: "invalid_resource_input" };
    const resourceIdentity = await tx.teamCredentialResource.findUnique({
        where: { id: parsed.data.resourceId }, select: { custodianAccountId: true, teamId: true },
    });
    if (resourceIdentity) {
        await acquireTeamMembershipAccountAdmissionInTx(tx, {
            teamId: resourceIdentity.teamId, accountIds: [actorAccountId, resourceIdentity.custodianAccountId],
            membershipIds: [parsed.data.teamMembershipId],
        });
    }
    const now = new Date(nowInput.getTime());
    const expiresAt = validExpiry(parsed.data.expiresAt, now);
    if (expiresAt === undefined) return { ok: false, error: "invalid_resource_input" };
    const managed = await resolveManagedResourceInTx(tx, {
        resourceId: parsed.data.resourceId,
        actorAccountId,
        authentication,
    });
    if (managed.status === "missing") return { ok: false, error: "resource_not_found" };
    if (managed.status === "forbidden") return { ok: false, error: "resource_forbidden" };
    if (managed.status === "unqualified") return { ok: false, error: managed.error };
    const resource = managed.resource;
    if (resource.custodianAccountId !== resourceIdentity?.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    if (resource.sessionUsePolicy !== "personal_allowed") return { ok: false, error: "session_policy_incompatible" };
    if (isConnectedAccountProviderPurposeSource(resource.sourceBindingJson)) return { ok: false, error: "resource_forbidden" };

    const membership = await tx.teamMembership.findFirst({
        where: { id: parsed.data.teamMembershipId, teamId: resource.teamId },
        select: { id: true, accountId: true, status: true, account: { select: { status: true } } },
    });
    if (!membership || membership.status !== "active" || membership.account.status !== AccountStatus.active) {
        return { ok: false, error: "member_not_eligible" };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: membership.accountId });
    if (!entitlement.ok || !entitlement.mayBroker) return { ok: false, error: "member_not_eligible" };
    const label = await prepareTeamCredentialExternalApiKeyLabelForWriteInTx({
        tx,
        ownerAccountId: actorAccountId,
        teamId: resource.teamId,
        label: parsed.data.label,
    });
    if (label.kind !== 'ready') return { ok: false, error: 'invalid_resource_input' };

    const evidence = membership.accountId === actorAccountId
        ? await resolveCurrentAuthenticationEvidenceInTx(tx, {
            env: authentication.env ?? process.env, accountId: actorAccountId, evidence: authentication.authenticationEvidence,
        }) : [];

    const keyId = parsed.data.keyId;
    if (await tx.teamCredentialExternalApiKey.findUnique({ where: { id: keyId }, select: { id: true } })) {
        return { ok: false, error: 'resource_changed' };
    }
    const secret = privacyKit.encodeBase64(new Uint8Array(randomBytes(EXTERNAL_API_KEY_SECRET_BYTES)), "base64url").replace(/=+$/u, "");
    const displayPrefix = createTeamCredentialExternalApiKeyDisplayPrefixV1(keyId);
    const row = await tx.teamCredentialExternalApiKey.create({
        data: {
            id: keyId,
            resourceId: resource.id,
            teamMembershipId: membership.id,
            label: label.serialized,
            displayPrefix,
            secretDigest: digestSecret(secret),
            createdAt: now,
            expiresAt,
            ...(evidence.length > 0 ? { authenticationEvidence: AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence }) } : {}),
        },
        select: SUMMARY_SELECT,
    });
    await recordTeamCredentialExternalApiKeyActivityInTx(tx, {
        teamId: resource.teamId,
        resourceId: resource.id,
        externalApiKeyId: keyId,
        kind: "external_key_created",
        actor: { kind: "account", accountId: actorAccountId },
        label: label.label,
    });
    await publishTeamChangedInTx(tx, { teamId: resource.teamId, additionalAccountIds: [resource.custodianAccountId, actorAccountId, membership.accountId] });
    const key = await project(tx, row, actorAccountId, authentication.env);
    if (key === null) throw new Error('Validated external API-key label failed recipient projection');
    return { ok: true, token: formatTeamCredentialExternalApiKeyV1({ keyId, secret }), key };
}

/** Lists safe key metadata only; plaintext and digest never cross this boundary. */
export async function listTeamCredentialExternalApiKeysInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; authentication: TeamOperationAuthenticationContext }>,
): Promise<ListTeamCredentialExternalApiKeysResult> {
    if (!input.resourceId.trim()) return { ok: false, error: "invalid_resource_input" };
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
    if (!resource) return { ok: false, error: "resource_not_found" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: input.actorAccountId });
    const managerQualification = actor !== null && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials
        ? await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication) : null;
    const manager = managerQualification?.ok === true;
    if (!manager) {
        const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: input.actorAccountId });
        if (!entitlement.ok || !entitlement.mayBroker) return { ok: false, error: managerQualification?.ok === false
            ? managerQualification.error : "resource_forbidden" };
    }
    const rows = await tx.teamCredentialExternalApiKey.findMany({
        where: { resourceId: input.resourceId, ...(manager ? {} : { membership: { accountId: input.actorAccountId } }) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: SUMMARY_SELECT,
    });
    const keys = await Promise.all(rows.map(row => project(tx, row, input.actorAccountId, input.authentication.env)));
    return keys.some((key) => key === null)
        ? { ok: false, error: 'resource_corrupt' }
        : { ok: true, keys: keys.filter((key): key is TeamCredentialExternalApiKeySummaryV1 => key !== null) };
}

/** The exact assignee replaces only the key's qualification snapshot, never its bearer. */
export async function authorizeTeamCredentialExternalApiKeyInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; keyId: string; authentication: TeamOperationAuthenticationContext }>,
): Promise<Readonly<{ ok: true; key: TeamCredentialExternalApiKeySummaryV1 }> | Extract<ListTeamCredentialExternalApiKeysResult, { ok: false }>> {
    const { actorAccountId, authentication, ...keyInput } = input;
    const parsed = TeamCredentialExternalApiKeyAuthorizeInputV1Schema.safeParse(keyInput);
    if (!parsed.success) return { ok: false, error: "invalid_resource_input" };
    const resourceIdentity = await tx.teamCredentialResource.findUnique({
        where: { id: parsed.data.resourceId }, select: { custodianAccountId: true, teamId: true },
    });
    if (resourceIdentity) {
        await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: resourceIdentity.teamId, accountIds: [actorAccountId, resourceIdentity.custodianAccountId] });
    }
    const row = await tx.teamCredentialExternalApiKey.findFirst({
        where: { id: parsed.data.keyId, resourceId: parsed.data.resourceId }, select: SUMMARY_SELECT,
    });
    if (!row || row.membership.accountId !== actorAccountId || (row.expiresAt !== null && row.expiresAt <= new Date())) {
        return { ok: false, error: "resource_forbidden" };
    }
    if (row.resource.custodianAccountId !== resourceIdentity?.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: row.resourceId, accountId: actorAccountId });
    if (!entitlement.ok || !entitlement.mayBroker) return { ok: false, error: "resource_forbidden" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: row.resource.team.id, actorAccountId });
    if (!actor) return { ok: false, error: "resource_forbidden" };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
    if (!qualification.ok) return { ok: false, error: qualification.error };
    const evidence = await resolveCurrentAuthenticationEvidenceInTx(tx, {
        env: authentication.env ?? process.env, accountId: actorAccountId, evidence: authentication.authenticationEvidence,
    });
    const updated = await tx.teamCredentialExternalApiKey.update({
        where: { id: row.id },
        data: { authenticationEvidence: evidence.length > 0
            ? AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence }) : getActivePrismaRuntime().DbNull },
        select: SUMMARY_SELECT,
    });
    await publishTeamChangedInTx(tx, { teamId: row.resource.team.id, additionalAccountIds: [actorAccountId] });
    const key = await project(tx, updated, actorAccountId, authentication.env);
    return key === null ? { ok: false, error: 'resource_corrupt' } : { ok: true, key };
}

export async function revokeTeamCredentialExternalApiKeyInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; keyId: string; authentication: TeamOperationAuthenticationContext }>,
): Promise<RevokeTeamCredentialExternalApiKeyResult> {
    if (!input.resourceId.trim() || !input.keyId.trim()) return { ok: false, error: "invalid_resource_input" };
    if (!await admitTeamCredentialWithdrawalInTx(tx, input)) return { ok: false, error: "resource_not_found" };
    const managed = await resolveManagedResourceInTx(tx, input);
    if (managed.status === "missing") return { ok: false, error: "resource_not_found" };
    if (managed.status === "forbidden") return { ok: false, error: "resource_forbidden" };
    if (managed.status === "unqualified") return { ok: false, error: managed.error };
    const key = await tx.teamCredentialExternalApiKey.findFirst({
        where: { id: input.keyId, resourceId: input.resourceId },
        select: { id: true, label: true },
    });
    if (!key) return { ok: true, keyId: input.keyId, revoked: false };
    const deleted = await tx.teamCredentialExternalApiKey.deleteMany({ where: { id: input.keyId, resourceId: input.resourceId } });
    if (deleted.count !== 1) return { ok: true, keyId: input.keyId, revoked: false };
    const label = readTeamCredentialExternalApiKeyLabelStored(key.label);
    if (label !== null) {
        await recordTeamCredentialExternalApiKeyActivityInTx(tx, {
            teamId: managed.resource.teamId,
            resourceId: managed.resource.id,
            externalApiKeyId: key.id,
            kind: "external_key_revoked",
            actor: { kind: "account", accountId: input.actorAccountId },
            label,
        });
    }
    await publishTeamChangedInTx(tx, { teamId: managed.resource.teamId, additionalAccountIds: [managed.resource.custodianAccountId, input.actorAccountId] });
    return { ok: true, keyId: input.keyId, revoked: true };
}

export async function revokeAllTeamCredentialExternalApiKeysInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; authentication: TeamOperationAuthenticationContext }>,
): Promise<RevokeAllTeamCredentialExternalApiKeysResult> {
    if (!input.resourceId.trim()) return { ok: false, error: "invalid_resource_input" };
    if (!await admitTeamCredentialWithdrawalInTx(tx, input)) return { ok: false, error: "resource_not_found" };
    const managed = await resolveManagedResourceInTx(tx, input);
    if (managed.status === "missing") return { ok: false, error: "resource_not_found" };
    if (managed.status === "forbidden") return { ok: false, error: "resource_forbidden" };
    if (managed.status === "unqualified") return { ok: false, error: managed.error };
    const keys = await tx.teamCredentialExternalApiKey.findMany({ where: { resourceId: input.resourceId }, select: { id: true, label: true } });
    if (keys.length === 0) return { ok: true, resourceId: input.resourceId, revokedCount: 0 };
    const deleted = await tx.teamCredentialExternalApiKey.deleteMany({ where: { resourceId: input.resourceId } });
    for (const key of keys) {
        const label = readTeamCredentialExternalApiKeyLabelStored(key.label);
        if (label !== null) {
            await recordTeamCredentialExternalApiKeyActivityInTx(tx, {
                teamId: managed.resource.teamId,
                resourceId: managed.resource.id,
                externalApiKeyId: key.id,
                kind: "external_key_revoked",
                actor: { kind: "account", accountId: input.actorAccountId },
                label,
            });
        }
    }
    await publishTeamChangedInTx(tx, { teamId: managed.resource.teamId, additionalAccountIds: [managed.resource.custodianAccountId, input.actorAccountId] });
    return { ok: true, resourceId: input.resourceId, revokedCount: deleted.count };
}

/** Revokes all keys for an ended membership lifetime before its FK row disappears. */
export async function revokeTeamCredentialExternalApiKeysForMembershipInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; membershipId: string; actor: TeamCredentialActivityActor }>,
): Promise<number> {
    const keys = await tx.teamCredentialExternalApiKey.findMany({
        where: { teamMembershipId: input.membershipId, resource: { teamId: input.teamId } },
        select: { id: true, label: true, resourceId: true },
    });
    for (const key of keys) {
        const label = readTeamCredentialExternalApiKeyLabelStored(key.label);
        if (label !== null) {
            await recordTeamCredentialExternalApiKeyActivityInTx(tx, {
                teamId: input.teamId,
                resourceId: key.resourceId,
                externalApiKeyId: key.id,
                kind: "external_key_revoked",
                actor: input.actor,
                label,
            });
        }
    }
    const deleted = await tx.teamCredentialExternalApiKey.deleteMany({
        where: { id: { in: keys.map((key) => key.id) } },
    });
    return deleted.count;
}

/**
 * The one currentness evaluator shared by public bearer verification and the
 * broker's per-request admission recheck. The admitted-key arm is internal
 * provenance: the public bearer is stripped at the Home edge and is never sent
 * to the broker Machine.
 */
export async function resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx(
    tx: Tx,
    input:
        | Readonly<{ kind: "bearer"; token: string }>
        | Readonly<{ kind: "admitted_key"; keyId: string }>,
    nowInput: Date = new Date(),
): Promise<CurrentTeamCredentialExternalApiKeyAuthorityResult> {
    let keyId: string;
    let suppliedSecret: string | null = null;
    if (input.kind === "bearer") {
        try {
            const parsed = parseTeamCredentialExternalApiKeyV1(input.token);
            keyId = parsed.keyId;
            suppliedSecret = parsed.secret;
        } catch {
            return { ok: false, reason: "operation_not_current" };
        }
    } else {
        keyId = input.keyId;
    }
    const identity = await tx.teamCredentialExternalApiKey.findUnique({
        where: { id: keyId },
        select: { teamMembershipId: true, resource: { select: { custodianAccountId: true, teamId: true } } },
    });
    if (!identity) return { ok: false, reason: "operation_not_current" };
    await acquireTeamMembershipAccountAdmissionInTx(tx, {
        teamId: identity.resource.teamId,
        accountIds: [identity.resource.custodianAccountId], membershipIds: [identity.teamMembershipId],
    });
    const row = await tx.teamCredentialExternalApiKey.findUnique({
        where: { id: keyId },
        select: {
            id: true, resourceId: true, teamMembershipId: true, secretDigest: true,
            expiresAt: true, authenticationEvidence: true, currentBrokerOperationJson: true,
            resource: {
                select: {
                    teamId: true,
                    custodianAccountId: true,
                    brokerMachineId: true,
                    brokerPoolId: true,
                    revision: true,
                    sourceBindingJson: true,
                    enabled: true,
                    sessionUsePolicy: true,
                },
            },
            membership: { select: { accountId: true, status: true, account: { select: { status: true } } } },
        },
    });
    if (row && row.resource.custodianAccountId !== identity.resource.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    const now = new Date(nowInput.getTime());
    if (!row || (suppliedSecret !== null && !digestMatches(row.secretDigest, suppliedSecret))
        || (row.expiresAt !== null && row.expiresAt <= now)
        || row.membership.status !== "active"
        || row.membership.account.status !== AccountStatus.active) {
        return { ok: false, reason: "operation_not_current" };
    }
    if (!row.resource.enabled || row.resource.sessionUsePolicy !== "personal_allowed"
        || isConnectedAccountProviderPurposeSource(row.resource.sourceBindingJson)) {
        return { ok: false, reason: "resource_forbidden" };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: row.resourceId, accountId: row.membership.accountId });
    if (!entitlement.ok || !entitlement.mayBroker) return { ok: false, reason: "resource_forbidden" };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: row.resource.teamId, actorAccountId: row.membership.accountId });
    if (!actor) return { ok: false, reason: "resource_forbidden" };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, {
        authenticationAuthority: "account_automation",
        authenticationEvidence: parseAuthenticationEvidenceSnapshot(row.authenticationEvidence)?.evidence,
    });
    if (!qualification.ok) return { ok: false, reason: "resource_forbidden" };
    return {
        ok: true,
        keyId: row.id,
        resourceId: row.resourceId,
        teamId: row.resource.teamId,
        assignedAccountId: row.membership.accountId,
        assignedTeamMembershipId: row.teamMembershipId,
        custodianAccountId: row.resource.custodianAccountId,
        brokerMachineId: row.resource.brokerMachineId,
        brokerPoolId: row.resource.brokerPoolId,
        resourceRevision: row.resource.revision,
        sourceBindingJson: row.resource.sourceBindingJson,
        currentBrokerOperationJson: row.currentBrokerOperationJson,
        expiresAt: row.expiresAt,
    };
}

/** Verifies and rechecks current resource/member entitlement before any broker dispatch. */
export async function verifyTeamCredentialExternalApiKeyInTx(
    tx: Tx,
    input: Readonly<{ token: string }>,
    nowInput: Date = new Date(),
): Promise<VerifyTeamCredentialExternalApiKeyResult> {
    const result = await resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx(
        tx,
        { kind: "bearer", token: input.token },
        nowInput,
    );
    if (!result.ok) return { ok: false, reason: "invalid_token" };
    const {
        resourceRevision: _resourceRevision, sourceBindingJson: _sourceBindingJson,
        currentBrokerOperationJson: _currentBrokerOperationJson, ...verified
    } = result;
    return verified;
}
