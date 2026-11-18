import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import * as privacyKit from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { listOwedResourceRecipientsV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListPageV1';
import { type ArtifactAccessErrorCodeV1, type ArtifactAccessGrantsListInputV1, type ArtifactAccessGrantSetStorageInputV1, type ArtifactAccessGrantRemoveInputV1, type ArtifactAccessGrantsListResponseV1, type ArtifactAccessGrantMutationResponseV1, type ArtifactAccessRecipientCensusResponseV1, type ArtifactOwedRecipientCensusPageV1, type ArtifactCallerAccessV1, type ArtifactRecipientKeyEnvelopeCommitInputV1, type ArtifactRecipientKeyEnvelopeCommitResponseV1, type ArtifactRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import type { AccountAdmissionIntent } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { artifactOrdinarySqlPredicate, artifactVisibleWhere } from "./artifactClassification";
import { openArtifactStoredContentBytes, openArtifactProvenanceBytes, artifactProvenanceMatchesAccountMode } from "./artifactStoredContent";
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadiness } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { resolveResourceGrantAccessFromFacts, resolveResourceGrantAudienceFromFacts, resolveResourceGrantTeamIdsFromFacts,
    resolveResourceGrantAccessInTx, resolveResourceGrantAccessBatchInTx, resolveResourceGrantAudienceInTx,
    type ResourceGrantAccess, projectResourceRecipientEnvelope as projectRecipientEnvelope,
    projectResourceRecipientCensus, validateResourceRecipientEnvelopeCommit, applyResourceRecipientKeyEnvelopesInTx,
    mayManageResourceGrants, isResourceAccessLevelIncrease, validateResourceGrantPrincipalInTx, validateResourceGrantPrincipalsInTx,
    resolveResourceGrantMissingAudienceInTx, readResourceGrantPrincipalAudienceInTx, validateResourceRecipientKeyEnvelopes,
    type ResourceStoredRecipientEnvelope, type ResourceRecipientEnvelopeStorageAdapter } from '@/app/teams/resourceGrantAccess';
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ARTIFACT_BROWSER_NON_LISTED_KINDS_V1, getArtifactGrantInspectionPolicyV1, type ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { ArtifactCoarseKindV1Schema, decodeArtifactKindV1, type ArtifactCoarseKindV1, type ArtifactKindCoverageV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { mergeResourceGrantArmPages, resourceGrantPageAccessArms, resourceGrantAccessSqlPredicate } from '@/app/teams/resourceGrantAccess';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { artifactAccessFactsSelect, artifactGrantFacts, artifactGrantStorageAdapter, type ArtifactAccessFacts } from './artifactGrantStorageAdapter';
import { withArtifactSourceReadersInTx, readArtifactSourcePublicationReadersInTx } from './artifactSourceReaders';
import { projectTeamGroupNameForRecipient } from '@/app/teams/groups/privateLabels';
import { APPROVAL_ARTIFACT_KINDS_V1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import type { DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import type { ArtifactTemplateAcceptedVersionInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { projectAdmittedTemplateAcceptedVersionsInTx, writeAdmittedTemplateAcceptedVersionInTx } from './artifactTemplateAcceptedVersionStorage';
import { resolveTeamArtifactQueryInTx } from './artifactTeamResourceQuery';
import type { ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { ArtifactLockedAvailabilityV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { ResourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
export { countTeamSharedArtifactsInTx } from './artifactTeamResourceQuery';
import { publishWorkflowActionIndexChangedInTx } from '@/app/automations/automationActionIndex';
import type { ProjectSourcePublicationPatchV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ProjectSourceContentReference } from '@/app/projects/sources/projectSourceContentReferences';
import { mayAdmitReviewExternalGrantInTx } from '@/app/reviews/reviewCreationPolicy';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

export type ArtifactAccess = ResourceGrantAccess;

/** Retained anonymous or authenticated links both expose replacement Artifact bytes. */
export function projectArtifactPublicAudience(publication: Parameters<typeof isPublicSessionShareActive>[0], signedInLinkPresent: boolean): 'retained' | 'none' {
    return signedInLinkPresent || isPublicSessionShareActive(publication) ? 'retained' : 'none';
}

/** Request-private admission carried into the transaction that changes the Artifact. */
export type ArtifactMutationAdmission = Readonly<{
    publicationGrants: readonly (Pick<ArtifactAccessGrantSetStorageInputV1, 'principal' | 'accessLevel'> & { requiredByTeamPolicy?: boolean })[];
}>;
export interface ArtifactMutationTransactionGuard {
    admitInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>): Promise<ArtifactMutationAdmission | null>;
}

/** Lock every pending reader before the parent, then contain its existing audience. */
export async function admitArtifactMutationInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>,
    guard?: ArtifactMutationTransactionGuard,
    options: Readonly<{ intent?: AccountAdmissionIntent; additionalGrantPrincipal?: ArtifactAccessGrantSetStorageInputV1['principal'];
        additionalAccountIds?: readonly string[] }> = {},
): Promise<ArtifactMutationAdmission | null> {
    const admission = guard ? await guard.admitInTx(tx, input) : { publicationGrants: [] };
    if (!admission) return null;
    await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId, ...(options.additionalAccountIds ?? [])], {
        ...options,
        publicationGrants: { ownerAccountId: input.actorAccountId, principals: admission.publicationGrants.map(grant => grant.principal) },
    });
    if (guard && !await isArtifactAudienceContainedInTx(tx, { ...input,
        principals: admission.publicationGrants.map(grant => grant.principal) })) return null;
    return admission;
}

const artifactAddress = (artifactId: string) => ({ id: artifactId, ...artifactVisibleWhere });

function resolveArtifactAccessFromFacts(row: ArtifactAccessFacts, actorAccountId: string): ArtifactAccess | null {
    return resolveResourceGrantAccessFromFacts(artifactGrantFacts(row), actorAccountId);
}

/** One inspection decision for grants, census, selected-detail reads and envelope commits. */
function mayInspectArtifactAudience(kind: string | null, access: ArtifactAccess): boolean {
    return access.level === 'owner' || getArtifactGrantInspectionPolicyV1(decodeArtifactKindV1(kind).kindHint) === 'all';
}

/** The sole document access decision: ownership or the highest live grant. */
export async function resolveArtifactAccessInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<ArtifactAccess | null> {
    return resolveResourceGrantAccessInTx(tx, artifactGrantStorageAdapter, { resourceId: input.artifactId, actorAccountId: input.actorAccountId });
}

/** Structural consumers need the grant decision without requiring a recipient key envelope. */
export async function resolveArtifactAccessBatchInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[];
}>): Promise<ReadonlyMap<string, ArtifactAccess>> {
    const decisions = await resolveResourceGrantAccessBatchInTx(tx, artifactGrantStorageAdapter, {
        resourceIds: input.artifactIds, actorAccountId: input.actorAccountId,
    });
    return new Map(input.artifactIds.map((artifactId, index) => {
        const decision = decisions[index];
        return decision ? [artifactId, decision] as const : null;
    }).filter((entry): entry is readonly [string, ArtifactAccess] => entry !== null));
}

/** Candidate discovery is a database predicate per access arm; only the access owner admits rows.
 * `owned` is the caller's owner index (absent for a selected-Team scope); `received` arms
 * exclude the caller's own Artifacts and may overlap each other. */
export type ArtifactCandidateAccess = Readonly<{ owned: Prisma.ArtifactWhereInput | null; received: readonly Prisma.ArtifactWhereInput[] }>;

/** Index-servable access for ordered inventory pages and their counts (see the grant owner). */
export function readArtifactCandidateAccess(actorAccountId: string): ArtifactCandidateAccess {
    return resourceGrantPageAccessArms(actorAccountId, (arm, grantWhere): Prisma.ArtifactWhereInput =>
        ({ grants: { some: { ...grantWhere, principalKind: arm } } }));
}

/** Fan-out and recipient preparation consume the same live access decision. */
export async function resolveArtifactAudienceInTx(tx: Tx, artifactId: string): Promise<string[]> {
    return resolveResourceGrantAudienceInTx(tx, artifactGrantStorageAdapter, artifactId);
}

/** A retained recipient key or public link still exposes replacement bytes. */
export async function isArtifactAudienceContainedInTx(tx: Tx, input: Readonly<{
    artifactId: string; actorAccountId: string;
    principals?: readonly ArtifactAccessGrantSetStorageInputV1['principal'][];
}>): Promise<boolean> {
    // Current reader overlap cannot attenuate a stored principal: a foreign
    // Team can add members later, and a direct grant survives Team departure.
    const stored = await tx.artifact.findUnique({ where: { id: input.artifactId }, select: {
        accountId: true, grants: { select: { principalKind: true, accountId: true, teamId: true, teamGroupId: true } },
        signedInLink: { select: { artifactId: true } },
    } });
    const storedGrants = stored ? projectResourceGrantRows(stored.grants) : null;
    if (stored && storedGrants && (stored.signedInLink !== null || stored.accountId !== input.actorAccountId
        || storedGrants.accountGrants.some(grant => grant.accountId !== input.actorAccountId
            && !input.principals?.some(principal => principal.kind === 'account' && principal.accountId === grant.accountId))
        || storedGrants.teamGrants.some(grant => !input.principals?.some(principal => principal.kind === 'team' && principal.teamId === grant.teamId))
        || storedGrants.groupGrants.some(grant => !input.principals?.some(principal => principal.kind === 'group' && principal.groupId === grant.teamGroupId)))) return false;
    const allowed = new Set([input.actorAccountId, ...(await Promise.all((input.principals ?? []).map(principal =>
        readResourceGrantPrincipalAudienceInTx(tx, { ownerAccountId: input.actorAccountId, principal })))).flat()]);
    const [audience, recipients, publication] = await Promise.all([
        resolveArtifactAudienceInTx(tx, input.artifactId),
        tx.artifactKeyEnvelope.findMany({ where: { artifactId: input.artifactId }, select: { recipientAccountId: true } }),
        tx.publicSessionShare.findUnique({ where: { artifactId: input.artifactId }, select: { expiresAt: true } }),
    ]);
    return !isPublicSessionShareActive(publication) && audience.every(id => allowed.has(id))
        && recipients.every(recipient => allowed.has(recipient.recipientAccountId));
}

function resolveArtifactAudienceFromFacts(row: ArtifactAccessFacts): string[] {
    return resolveResourceGrantAudienceFromFacts(artifactGrantFacts(row));
}

/** Quota readers and all Artifact parent holders enter the same ordered cohort. */
export function resolveArtifactPublicationAdmissionIntent(intent: AccountAdmissionIntent = "content"): AccountAdmissionIntent {
    return intent === "content" && readArtifactStorageEnv(process.env).accountLimitBytes !== null
        ? "serializing" : intent;
}

/** Fence the complete publication audience before reading mode, head or storage budget. */
export async function acquireArtifactPublicationLocksInTx(tx: Tx, artifactId: string, additionalAccountIds: readonly string[] = [], options: Readonly<{
    intent?: AccountAdmissionIntent;
    additionalGrantPrincipal?: ArtifactAccessGrantSetStorageInputV1["principal"];
    publicationGrants?: Readonly<{ ownerAccountId: string; principals: readonly ArtifactAccessGrantSetStorageInputV1['principal'][] }>;
}> = {}): Promise<void> {
    // SQLite already admits one writer. PostgreSQL/MySQL use the same ordered
    // Account locks as publication, including the single-owner Artifact case.
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return;
    const readAudience = async () => {
        const audience = await resolveArtifactAudienceInTx(tx, artifactId);
        if (options.additionalGrantPrincipal) {
            const owner = await tx.artifact.findUnique({ where: { id: artifactId }, select: { accountId: true } });
            if (owner) audience.push(...await readResourceGrantPrincipalAudienceInTx(tx, {
                ownerAccountId: owner.accountId, principal: options.additionalGrantPrincipal,
            }));
        }
        if (options.publicationGrants) {
            for (const principal of options.publicationGrants.principals) {
                audience.push(...await readResourceGrantPrincipalAudienceInTx(tx, {
                    ownerAccountId: options.publicationGrants.ownerAccountId, principal,
                }));
            }
        }
        return [...new Set([...audience, ...additionalAccountIds])];
    };
    const accountIds = await readAudience();
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, {
        includeSingleAccount: true,
        // Grant/envelope writers also hold the Artifact before terminal Account
        // publication. Under quota, admitting them as content would invert the
        // order against a quota writer holding Account and waiting for Artifact.
        intent: resolveArtifactPublicationAdmissionIntent(options.intent),
    });
    // Head/budget writes and grant/envelope mutations share the parent lock.
    // Take it before child rows: physical deletion cascades to those rows and
    // cleans AccountChange FKs, reversing a child-first publication's order.
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres")) === "postgres") {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Artifact" WHERE "id" = $1 FOR NO KEY UPDATE', artifactId);
    } else {
        await tx.$queryRawUnsafe('SELECT `id` FROM `Artifact` WHERE `id` = ? FOR UPDATE', artifactId);
    }
    const captured = new Set(accountIds);
    // ReadCommitted may observe a newly granted recipient while acquiring the
    // locks. Replay instead of extending an already ordered lock set in place.
    if ((await readAudience()).some(accountId => !captured.has(accountId))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    beforeAccountChangePublication(tx, accountIds, async () => {
        assertAccountChangePublicationAudienceInTx(tx, await readAudience());
    });
}

export interface ArtifactForCaller {
    id: string;
    kind: ArtifactCoarseKindV1 | null;
    kindHint?: string | null;
    ownerAccountId: string;
    ownerDisplayName?: string | null;
    access: ArtifactCallerAccessV1;
    sharedTeamIds?: readonly string[];
    sharedWithTeamScope?: ResourceTeamShareScopeV1;
    encryptionMode: "plain" | "e2ee";
    header: Uint8Array<ArrayBuffer>;
    body: Uint8Array<ArrayBuffer>;
    headerVersion: number;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array<ArrayBuffer>;
    provenance: Uint8Array<ArrayBuffer> | null;
    provenanceDataEncryptionKey: Uint8Array<ArrayBuffer> | null;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}

type ArtifactReadFailure = Readonly<{ ok: false; error: "artifact_not_found" | "artifact_content_unavailable"; ownerAccountId?: string }>;
export type ArtifactReadResult = Readonly<{ ok: true; artifact: ArtifactForCaller }> | ArtifactReadFailure;
type ArtifactFullReadResult = Readonly<{ ok: true; artifact: ArtifactForCaller & { publicAudience: 'retained' | 'none' } }> | ArtifactReadFailure;
export type ArtifactHeaderForCaller = Omit<ArtifactForCaller, "body" | "bodyVersion" | "provenance">;
export type ArtifactListItemForCaller = ArtifactHeaderForCaller & Pick<ArtifactForCaller, "bodyVersion" | "provenance">
    & Partial<Pick<ArtifactForCaller, "body">> & Readonly<{ publicAudience: "retained" | "none" }>;
export type ArtifactLockedListItemForCaller = Pick<ArtifactListItemForCaller,
    'id' | 'kind' | 'kindHint' | 'ownerAccountId' | 'ownerDisplayName' | 'access' | 'sharedTeamIds' | 'sharedWithTeamScope'
    | 'headerVersion' | 'bodyVersion' | 'seq' | 'createdAt' | 'updatedAt' | 'publicAudience'>
    & Readonly<{ availability: ArtifactLockedAvailabilityV1; encryptionMode?: 'plain' | 'e2ee' }>;
export type ArtifactInventoryItemForCaller = ArtifactListItemForCaller | ArtifactLockedListItemForCaller;
export type ArtifactHeaderReadResult = Readonly<{ ok: true; artifact: ArtifactHeaderForCaller }> | ArtifactReadFailure;

/** Request-private exact content custody produced by authenticated finite-job admission, never by HTTP input. */
export interface ArtifactContentReadAdmission {
    readonly requesterAccountId: string;
    readonly content: DeploymentArtifactContentReferenceV1;
}

/** Project already-authorized Plain bytes once; E2EE remains client-opened. */
export function projectPlainArtifactSharingResourceV1(artifact: ArtifactForCaller): ArtifactSharingResourceV1 | null {
    if (artifact.encryptionMode !== 'plain') return null;
    const header = ArtifactHeaderMetadataV1Schema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.header)));
    const body = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.body)));
    if (!header.success || !body.success) return null;
    return { artifactId: artifact.id, header: header.data, body: body.data.body,
        ownerAccountId: artifact.ownerAccountId, access: artifact.access,
        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
}

type StoredRecipientEnvelope = ResourceStoredRecipientEnvelope;

const headerContentSelect = {
    id: true, kind: true, header: true, headerVersion: true, dataEncryptionKey: true, seq: true, createdAt: true, updatedAt: true,
    provenanceDataEncryptionKey: true,
} as const;
type StoredArtifactHeader = Readonly<{
    id: string; kind: string | null; header: Uint8Array; headerVersion: number; dataEncryptionKey: Uint8Array;
    provenanceDataEncryptionKey: Uint8Array | null;
    seq: number; createdAt: Date; updatedAt: Date;
}>;

function projectArtifactHeader(row: StoredArtifactHeader, access: ArtifactAccess, key: Uint8Array<ArrayBuffer> | null,
    provenanceKey: Uint8Array<ArrayBuffer> | null): ArtifactHeaderReadResult {
    if (!access.encryptionMode || !key) return { ok: false, error: "artifact_content_unavailable", ownerAccountId: access.ownerAccountId };
    if (!artifactProvenanceMatchesAccountMode({ mode: access.encryptionMode, artifactId: row.id, bodyVersion: 0,
        provenance: null, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: access.ownerAccountId };
    const header = openArtifactStoredContentBytes({ accountId: access.ownerAccountId, artifactId: row.id,
        mode: access.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, content: row.header, field: "header" });
    if (!header) return { ok: false, error: "artifact_content_unavailable", ownerAccountId: access.ownerAccountId };
    const kind = decodeArtifactKindV1(row.kind);
    return { ok: true, artifact: { id: row.id, kind: kind.kind, ...(kind.classified ? { kindHint: kind.kindHint } : {}), ownerAccountId: access.ownerAccountId,
        access: access.level, encryptionMode: access.encryptionMode, header,
        headerVersion: row.headerVersion, dataEncryptionKey: key,
        provenanceDataEncryptionKey: provenanceKey,
        seq: row.seq, createdAt: row.createdAt, updatedAt: row.updatedAt } };
}

/** Revision-bound private metadata is available in header inventories without loading document bodies. */
function projectArtifactRevisionMetadata(header: ArtifactHeaderForCaller,
    row: Readonly<{ bodyVersion: number; dataEncryptionKey: Uint8Array; provenance: Uint8Array | null }>):
    Readonly<{ ok: true; artifact: Omit<ArtifactListItemForCaller, "publicAudience"> }> | ArtifactReadFailure {
    const provenance = row.provenance && (header.encryptionMode === 'plain' || header.provenanceDataEncryptionKey)
        ? openArtifactProvenanceBytes({ accountId: header.ownerAccountId, artifactId: header.id, mode: header.encryptionMode,
            dataEncryptionKey: row.dataEncryptionKey, content: row.provenance, bodyVersion: row.bodyVersion,
            provenanceDataEncryptionKey: header.provenanceDataEncryptionKey }) : null;
    if (row.provenance && (header.encryptionMode === 'plain' || header.provenanceDataEncryptionKey) && !provenance) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: header.ownerAccountId };
    }
    if (row.provenance && header.encryptionMode === 'e2ee' && header.access === 'owner' && !header.provenanceDataEncryptionKey) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: header.ownerAccountId };
    }
    return { ok: true, artifact: { ...header, bodyVersion: row.bodyVersion, provenance } };
}

function projectArtifactBody(header: ArtifactHeaderForCaller,
    row: Readonly<{ body: Uint8Array; bodyVersion: number; dataEncryptionKey: Uint8Array; provenance: Uint8Array | null }>): ArtifactReadResult {
    const metadata = projectArtifactRevisionMetadata(header, row);
    if (!metadata.ok) return metadata;
    const body = openArtifactStoredContentBytes({ accountId: header.ownerAccountId, artifactId: header.id,
        mode: header.encryptionMode, dataEncryptionKey: row.dataEncryptionKey, content: row.body, field: "body" });
    return body ? { ok: true, artifact: { ...metadata.artifact, body } }
        : { ok: false, error: "artifact_content_unavailable", ownerAccountId: header.ownerAccountId };
}

async function recipientEnvelopesInTx(tx: Tx, artifactId: string, actorAccountId: string) {
    const [account, envelope] = await Promise.all([
        tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT }),
        tx.artifactKeyEnvelope.findUnique({ where: { artifactId_recipientAccountId: { artifactId, recipientAccountId: actorAccountId } } }),
    ]);
    if (!account || !envelope) return { content: null, provenance: null };
    return { content: projectRecipientEnvelope(account, envelope), provenance: envelope.encryptedProvenanceDataKey
        ? projectRecipientEnvelope(account, { ...envelope, encryptedDataKey: envelope.encryptedProvenanceDataKey }) : null };
}

/** Header lists and exact reads share access, mode and the caller's envelope projection. */
export async function readArtifactHeaderForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string; projectSourceId?: string;
}>): Promise<ArtifactHeaderReadResult> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: artifactReadAdmissionSelect(input.actorAccountId) });
    return row ? projectArtifactAdmittedHeader((await withArtifactSourceReadersInTx(tx, [row], input.actorAccountId, input.projectSourceId))[0]!, input.actorAccountId)
        : { ok: false, error: "artifact_not_found" };
}

/** Open only server at-rest Plain content; E2EE stays opaque with the caller's envelope. */
export function readArtifactForCallerInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string; projection?: never;
    admittedContent?: ArtifactContentReadAdmission; projectSourceId?: string }>):
    Promise<ArtifactFullReadResult>;
export function readArtifactForCallerInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string; projection?: 'headers';
    admittedContent?: ArtifactContentReadAdmission; projectSourceId?: string }>):
    Promise<Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure>;
export async function readArtifactForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string; projection?: 'headers'; admittedContent?: ArtifactContentReadAdmission; projectSourceId?: string;
}>): Promise<Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure> {
    if (input.admittedContent) {
        const { content, requesterAccountId } = input.admittedContent;
        if (requesterAccountId !== input.actorAccountId || content.contentArtifactId !== input.artifactId) {
            return { ok: false, error: 'artifact_not_found' };
        }
        const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
            ...artifactRecipientReadSelect(input.actorAccountId), body: input.projection !== 'headers', bodyVersion: true, provenance: true,
        } });
        if (!row) return { ok: false, error: 'artifact_not_found' };
        if (row.headerVersion !== content.contentHeaderVersion) return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: row.accountId };
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
        const header = projectArtifactHeaderForRecipient(row, input.actorAccountId, { ownerAccountId: row.accountId,
            level: row.accountId === input.actorAccountId ? 'owner' : 'view', encryptionMode: mode.status === 'ready' ? mode.mode : null });
        if (!header.ok) return header;
        const selected = row.bodyVersion === content.contentBodyVersion ? row : await tx.artifactRevision.findUnique({
            where: { artifactId_bodyVersion: { artifactId: row.id, bodyVersion: content.contentBodyVersion } },
        });
        if (!selected) return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: row.accountId };
        const body = { ...selected, dataEncryptionKey: row.dataEncryptionKey };
        const read = input.projection === 'headers' ? projectArtifactRevisionMetadata(header.artifact, body) : projectArtifactBody(header.artifact, body);
        if (!read.ok) return read;
        const publication = await tx.publicSessionShare.findUnique({ where: { artifactId: row.id }, select: { expiresAt: true } });
        return { ok: true, artifact: { ...read.artifact, publicAudience: projectArtifactPublicAudience(publication, row.signedInLink !== null) } };
    }
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactReadAdmissionSelect(input.actorAccountId), body: input.projection !== 'headers', bodyVersion: true, provenance: true,
    } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const admitted = (await withArtifactSourceReadersInTx(tx, [row], input.actorAccountId, input.projectSourceId))[0]!;
    const header = projectArtifactAdmittedHeader(admitted, input.actorAccountId);
    if (!header.ok) return header;
    if (admitted.projectSourceContentReference && admitted.projectSourceContentReference.contentBodyVersion !== row.bodyVersion) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: row.accountId };
    }
    const read = input.projection === 'headers' ? projectArtifactRevisionMetadata(header.artifact, row) : projectArtifactBody(header.artifact, row);
    if (!read.ok) return read;
    const publication = await tx.publicSessionShare.findUnique({ where: { artifactId: input.artifactId }, select: { expiresAt: true } });
    return { ok: true, artifact: { ...read.artifact, publicAudience: projectArtifactPublicAudience(publication, row.signedInLink !== null) } };
}

/**
 * Recipient custody of a committed update's publication: one bodyless read of the row
 * with its whole audience's grants and envelopes, admitted per recipient by the same
 * access, header and revision-metadata projections as a read. Recipients the access
 * owner does not admit are absent.
 */
export async function readArtifactRecipientPublicationsInTx(tx: Tx, input: Readonly<{
    artifactId: string; accountIds: readonly string[];
}>): Promise<ReadonlyMap<string, Pick<ArtifactListItemForCaller, 'provenance' | 'provenanceDataEncryptionKey'>>> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactReadAdmissionSelect(), bodyVersion: true, provenance: true,
    } });
    const publications = new Map<string, Pick<ArtifactListItemForCaller, 'provenance' | 'provenanceDataEncryptionKey'>>();
    if (!row) return publications;
    const admitted = (await withArtifactSourceReadersInTx(tx, [row]))[0]!;
    for (const accountId of input.accountIds) {
        const header = projectArtifactAdmittedHeader(admitted, accountId);
        const read = header.ok ? projectArtifactRevisionMetadata(header.artifact, row) : header;
        if (read.ok) publications.set(accountId, { provenance: read.artifact.provenance,
            provenanceDataEncryptionKey: read.artifact.provenanceDataEncryptionKey });
    }
    return publications;
}

/** Batched quote admission uses exact ids and the same body, mode and recipient-key projections as an opened Artifact. */
export async function readArtifactContentAvailabilityForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[];
}>): Promise<ReadonlySet<string>> {
    const readable = new Set<string>();
    const readRows = (ids: readonly string[]) => tx.artifact.findMany({ where: { id: { in: [...ids] }, ...artifactVisibleWhere }, select: {
        ...artifactReadAdmissionSelect(input.actorAccountId), body: true, bodyVersion: true, provenance: true,
    } });
    const rows: Awaited<ReturnType<typeof readRows>> = [];
    for (const ids of portableQueryChunks({ values: [...new Set(input.artifactIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        rows.push(...await readRows(ids));
    }
    for (const row of await withArtifactSourceReadersInTx(tx, rows, input.actorAccountId)) {
        const header = projectArtifactAdmittedHeader(row, input.actorAccountId);
        if (header.ok && projectArtifactBody(header.artifact, row).ok) readable.add(row.id);
    }
    return readable;
}

export async function readArtifactForCaller(input: Readonly<{ actorAccountId: string; artifactId: string;
    admittedContent?: ArtifactContentReadAdmission; projectSourceId?: string }>): Promise<ArtifactFullReadResult> {
    return await captureReadSnapshot<ArtifactFullReadResult>(
        tx => readArtifactForCallerInTx(tx, input), { transactionClass: "artifact-read" });
}

function artifactRecipientReadSelect(actorAccountId?: string) {
    return { accountId: true, account: { select: { encryptionMode: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } }, ...headerContentSelect,
        signedInLink: { select: { artifactId: true } },
        keyEnvelopes: { ...(actorAccountId === undefined ? {} : { where: { recipientAccountId: actorAccountId } }), select: {
            recipientAccountId: true,
            encryptedDataKey: true, recipientContentPublicKeyFingerprint: true, recipient: { select: RECIPIENT_READINESS_SELECT },
            encryptedProvenanceDataKey: true,
        } } } as const;
}

function artifactReadAdmissionSelect(actorAccountId?: string) {
    const facts = artifactAccessFactsSelect(actorAccountId);
    return { ...facts, ...artifactRecipientReadSelect(actorAccountId) } as const;
}

function projectArtifactHeaderForRecipient(row: Prisma.ArtifactGetPayload<{ select: ReturnType<typeof artifactRecipientReadSelect> }>,
    actorAccountId: string, access: ArtifactAccess, recipientReadiness?: AccountRecipientEnvelopeReadiness): ArtifactHeaderReadResult {
    const envelope = row.keyEnvelopes.find(envelope => envelope.recipientAccountId === actorAccountId);
    const readiness = envelope ? recipientReadiness ?? deriveAccountRecipientEnvelopeReadinessFromRow(envelope.recipient) : undefined;
    const key = access.level === "owner" || access.encryptionMode === "plain" ? new Uint8Array(row.dataEncryptionKey)
        : envelope ? projectRecipientEnvelope(envelope.recipient, envelope, readiness) : null;
    const privateKey = access.encryptionMode === "plain" ? null : access.level === "owner"
        ? row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null
        : envelope?.encryptedProvenanceDataKey ? projectRecipientEnvelope(envelope.recipient, { ...envelope, encryptedDataKey: envelope.encryptedProvenanceDataKey }, readiness) : null;
    const projected = projectArtifactHeader(row, access, key, privateKey);
    return projected.ok ? { ok: true, artifact: { ...projected.artifact, ownerDisplayName: resolveAccountDisplayLabelV1(row.account) } } : projected;
}

function projectArtifactAdmittedHeader(row: Prisma.ArtifactGetPayload<{ select: ReturnType<typeof artifactReadAdmissionSelect> }>
    & Pick<ArtifactAccessFacts, 'sourceReaderAccounts'> & Readonly<{ projectSourceContentReference?: ProjectSourceContentReference }>, actorAccountId: string,
    recipientReadiness?: AccountRecipientEnvelopeReadiness): ArtifactHeaderReadResult {
    const access = resolveArtifactAccessFromFacts(row, actorAccountId);
    if (!access) return { ok: false, error: 'artifact_not_found' };
    if (row.projectSourceContentReference && row.projectSourceContentReference.contentHeaderVersion !== row.headerVersion) {
        return { ok: false, error: 'artifact_content_unavailable', ownerAccountId: row.accountId };
    }
    const read = projectArtifactHeaderForRecipient(row, actorAccountId, access, recipientReadiness);
    return read.ok ? { ok: true, artifact: { ...read.artifact,
        sharedTeamIds: resolveResourceGrantTeamIdsFromFacts(artifactGrantFacts(row), actorAccountId) } } : read;
}

export type ArtifactPageReadRow = Prisma.ArtifactGetPayload<{ select: ReturnType<typeof artifactReadAdmissionSelect> }>
    & Pick<ArtifactAccessFacts, 'sourceReaderAccounts'>
    & Readonly<{ body: Uint8Array; bodyVersion: number; provenance: Uint8Array | null }>;

/** Composed page captures consume the ordinary Artifact admission and content projection. */
export function projectArtifactPageReadRow(row: ArtifactPageReadRow, actorAccountId: string,
    publication: Parameters<typeof projectArtifactPublicAudience>[0]): ArtifactFullReadResult {
    const header = projectArtifactAdmittedHeader(row, actorAccountId);
    if (!header.ok) return header;
    const read = projectArtifactBody(header.artifact, row);
    return read.ok ? { ok: true, artifact: { ...read.artifact,
        publicAudience: projectArtifactPublicAudience(publication, row.signedInLink !== null) } } : read;
}

const browserNonListedStoredKinds = ARTIFACT_BROWSER_NON_LISTED_KINDS_V1.flatMap(kind =>
    ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));

const approvalStoredKinds = Object.values(APPROVAL_ARTIFACT_KINDS_V1).flatMap(kind =>
    ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));
const approvalKindWhere: Prisma.ArtifactWhereInput = { OR: [
    { kind: { in: approvalStoredKinds } },
    ...ArtifactCoarseKindV1Schema.options.map(coarse => ({ kind: { startsWith: `v1:${coarse}:${APPROVAL_ARTIFACT_KINDS_V1.builtIn}#` } })),
] };

function artifactApprovalSelectionWhere(input: Readonly<{ approvalStates?: readonly ApprovalArtifactStateV1[]; approvalSessionIds?: readonly string[] }>): Prisma.ArtifactWhereInput[] {
    return [
        ...(input.approvalSessionIds === undefined ? [] : [{ approvalSessionId: { in: [...input.approvalSessionIds] } }]),
        ...(input.approvalStates === undefined ? [] : [{ OR: [
            { NOT: approvalKindWhere }, { approvalState: { in: [...new Set(input.approvalStates)] } },
        ] }]),
    ];
}

function artifactListFixedBindings(input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): number {
    // Access/lifecycle/recipient/keyset/LIMIT operands, at most one page of
    // merged received positions, then the optional selectors.
    return 4 + 5 + 4 + 3 + 2 + input.limit + (input.ownerAccountId === undefined ? 0 : 1) + (input.audience === 'received' ? 1 : 0)
        + (input.kind === undefined || input.kind === null ? 0 : 2)
        + (input.browserListed ? browserNonListedStoredKinds.length : 0)
        + (input.approvalStates === undefined ? 0
            : approvalStoredKinds.length + ArtifactCoarseKindV1Schema.options.length + new Set(input.approvalStates).size)
        + (input.kinds?.includes(APPROVAL_ARTIFACT_KINDS_V1.builtIn) ? ArtifactCoarseKindV1Schema.options.length : 0);
}

const compareArtifactPagePositions = (left: Readonly<{ id: string; updatedAt: Date }>, right: Readonly<{ id: string; updatedAt: Date }>) =>
    right.updatedAt.getTime() - left.updatedAt.getTime() || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

function mergeArtifactHeaderPages(rows: readonly ArtifactInventoryItemForCaller[], limit: number): ArtifactInventoryItemForCaller[] {
    return mergeResourceGrantArmPages([rows], compareArtifactPagePositions, limit);
}

/** The access arms a selection can match: owner filters and the received audience exclude whole arms. */
function selectArtifactCandidateArms(access: ArtifactCandidateAccess, input: Readonly<{
    actorAccountId: string; ownerAccountId?: string; audience?: 'received';
}>): ArtifactCandidateAccess {
    const ownedOnly = input.ownerAccountId === input.actorAccountId;
    return { owned: input.audience === 'received' || (input.ownerAccountId !== undefined && !ownedOnly) ? null : access.owned,
        received: ownedOnly ? [] : access.received };
}

/**
 * The candidate scope of one ordered page. One arm pages directly. Otherwise each
 * received arm contributes its own page-sized keyset positions under the same
 * selection, and the page reads the owner index plus at most `limit` merged ids:
 * the first `limit` rows of the union lie within that set.
 */
async function readArtifactCandidatePageScopeInTx(tx: Tx, access: ArtifactCandidateAccess,
    where: Prisma.ArtifactWhereInput, conditions: readonly Prisma.ArtifactWhereInput[], limit: number): Promise<Prisma.ArtifactWhereInput | null> {
    if (access.received.length === 0) return access.owned;
    if (access.owned === null && access.received.length === 1) return access.received[0]!;
    const positions = mergeResourceGrantArmPages(await Promise.all(access.received.map(arm => tx.artifact.findMany({
        where: { ...where, AND: [...conditions, arm] }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit,
        select: { id: true, updatedAt: true } }))), compareArtifactPagePositions, limit);
    const received: Prisma.ArtifactWhereInput | null = positions.length === 0 ? null : { id: { in: positions.map(row => row.id) } };
    return access.owned === null ? received : received === null ? access.owned : { OR: [access.owned, received] };
}

/** Batch list projection preserves the endpoint's existing keyset and page size without per-row queries. */
export async function listArtifactHeadersForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; limit: number; cursor: Readonly<{ updatedAt: Date; id: string }> | null;
    sharedWithTeamId?: string;
    teamResourceKind?: ArtifactTeamResourceKindV1;
    authentication?: Partial<TeamOperationAuthenticationContext>;
    includeBody?: boolean;
    audience?: 'received';
    ownerAccountId?: string;
    kind?: ArtifactCoarseKindV1 | null;
    kinds?: readonly string[];
    approvalStates?: readonly ApprovalArtifactStateV1[];
    approvalSessionIds?: readonly string[];
    browserListed?: true;
    unclassified?: boolean | 'coarse' | 'approval';
}>, candidateAccess?: ArtifactCandidateAccess,
    sharingScopes?: ReadonlyMap<string, ResourceTeamShareScopeV1>): Promise<ArtifactInventoryItemForCaller[]> {
    // One candidate access resolution serves every chunk and page of this read.
    const teamScope = candidateAccess === undefined && input.sharedWithTeamId !== undefined
        ? await resolveTeamArtifactQueryInTx(tx, { ...input, sharedWithTeamId: input.sharedWithTeamId }) : null;
    if (teamScope && !teamScope.ok) throw Object.assign(new Error(teamScope.error), { code: teamScope.error });
    const access = candidateAccess ?? (teamScope?.ok ? { owned: null, received: [teamScope.where] } : readArtifactCandidateAccess(input.actorAccountId));
    const scopes = teamScope?.ok ? teamScope.sharingScopes : sharingScopes;
    const projectScopes = (items: ArtifactInventoryItemForCaller[]) => scopes
        ? items.map(item => ({ ...item, sharedWithTeamScope: scopes.get(item.id) })) : items;
    if (input.approvalSessionIds !== undefined && !input.unclassified) {
        const selected: ArtifactInventoryItemForCaller[] = [];
        // Both sets can be unbounded. Reserve an equal bind share for kinds when
        // present; each physical query still uses the canonical portable ceiling.
        for (const sessionIds of portableQueryChunks({ values: [...new Set(input.approvalSessionIds)],
            bindingsPerValue: input.kinds === undefined ? 1 : 2, fixedBindings: artifactListFixedBindings(input) })) {
            selected.push(...await listArtifactHeaderQueryInTx(tx, { ...input, approvalSessionIds: sessionIds }, access));
        }
        return projectScopes(mergeArtifactHeaderPages(selected, input.limit));
    }
    return projectScopes(await listArtifactHeaderQueryInTx(tx, input, access));
}

async function listArtifactHeaderQueryInTx(tx: Tx, input: Parameters<typeof listArtifactHeadersForCallerInTx>[1],
    candidateAccess: ArtifactCandidateAccess): Promise<ArtifactInventoryItemForCaller[]> {
    if (input.browserListed) {
        // MySQL's retained text collation folds unknown case/accent/space variants.
        // Byte-exact candidate paging preserves the kind policy's ordinary documents.
        if (getDbProviderFromEnv(process.env, 'postgres') === 'mysql') return listBrowserArtifactHeadersMysqlInTx(tx, input, candidateAccess);
        return listArtifactHeaderSelectionInTx(tx, input, candidateAccess, { OR: [
            { kind: null }, { kind: { notIn: browserNonListedStoredKinds } },
        ] });
    }
    if (input.kinds !== undefined) {
        // Exact strings use indexed equality over every existing family. Chunk at
        // the DB transport boundary, merging only selected page-sized projections.
        const exactKinds = new Set(input.kinds);
        const values = [...exactKinds].flatMap(kind => ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));
        const selected: ArtifactInventoryItemForCaller[] = [];
        for (const kinds of portableQueryChunks({ values, bindingsPerValue: 1,
            fixedBindings: artifactListFixedBindings(input) + (input.approvalSessionIds?.length ?? 0) })) {
            const annotations = exactKinds.has(APPROVAL_ARTIFACT_KINDS_V1.builtIn)
                ? kinds.filter(kind => kind.endsWith(`:${APPROVAL_ARTIFACT_KINDS_V1.builtIn}`)) : [];
            selected.push(...await listArtifactHeaderSelectionInTx(tx, input, candidateAccess, { OR: [
                { kind: { in: [...kinds] } }, ...annotations.map(kind => ({ kind: { startsWith: `${kind}#` } })),
            ] }, new Set(kinds), annotations));
        }
        return mergeArtifactHeaderPages(selected, input.limit);
    }
    const selection: Prisma.ArtifactWhereInput = input.unclassified
        ? artifactUnclassifiedWhere(input.unclassified === 'coarse')
        : input.kind === null ? { kind: null }
            : input.kind === undefined ? {} : { OR: [{ kind: input.kind }, { kind: { startsWith: `v1:${input.kind}:` } }] };
    return listArtifactHeaderSelectionInTx(tx, input, candidateAccess, selection);
}

/** Only page-sized identities cross the MySQL bytewise-query/Prisma-content boundary. */
async function listBrowserArtifactHeadersMysqlInTx(tx: Tx, input: Parameters<typeof listArtifactHeadersForCallerInTx>[1],
    candidateAccess: ArtifactCandidateAccess): Promise<ArtifactInventoryItemForCaller[]> {
    const sql = prismaRuntime.sql;
    const access = resourceGrantAccessSqlPredicate({ actorAccountId: input.actorAccountId,
        resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' });
    const listed = browserNonListedStoredKinds.length === 0 ? sql`TRUE`
        : sql`(a.\`kind\` IS NULL OR CAST(a.\`kind\` AS BINARY) NOT IN
            (${prismaRuntime.join(browserNonListedStoredKinds.map(kind => sql`CAST(${kind} AS BINARY)`))}))`;
    const result: ArtifactInventoryItemForCaller[] = [];
    let cursor = input.cursor;
    while (result.length < input.limit) {
        const positions = await tx.$queryRaw<Array<{ id: string; updatedAt: Date }>>(sql`
            SELECT a.\`id\`, a.\`updatedAt\` FROM \`Artifact\` a
            WHERE a.\`deletedAt\` IS NULL AND ${prismaRuntime.raw(artifactOrdinarySqlPredicate(true))}
                AND ${access} AND ${listed}
                ${input.audience === 'received' ? sql`AND a.\`accountId\` <> ${input.actorAccountId}` : prismaRuntime.empty}
                ${input.ownerAccountId === undefined ? prismaRuntime.empty : sql`AND a.\`accountId\` = ${input.ownerAccountId}`}
                ${cursor ? sql`AND (a.\`updatedAt\` < ${cursor.updatedAt}
                    OR (a.\`updatedAt\` = ${cursor.updatedAt} AND a.\`id\` < ${cursor.id}))` : prismaRuntime.empty}
            ORDER BY a.\`updatedAt\` DESC, a.\`id\` DESC LIMIT ${input.limit}`);
        if (positions.length === 0) break;
        result.push(...await listArtifactHeaderSelectionInTx(tx, { ...input, cursor, limit: input.limit - result.length },
            candidateAccess, { id: { in: positions.map(row => row.id) } }));
        if (positions.length < input.limit) break;
        cursor = positions[positions.length - 1];
    }
    return result;
}

function artifactUnclassifiedWhere(coarseOnly = false, includeApprovalState = true): Prisma.ArtifactWhereInput {
    if (coarseOnly) return { kind: null };
    return { OR: [{ kind: null }, { kind: { in: [...ArtifactCoarseKindV1Schema.options] } },
        ...(includeApprovalState ? [{ AND: [approvalKindWhere, { approvalState: null }] }] : [])] };
}

async function listArtifactHeaderSelectionInTx(tx: Tx, input: Parameters<typeof listArtifactHeadersForCallerInTx>[1],
    candidateAccess: ArtifactCandidateAccess, selection: Prisma.ArtifactWhereInput, storedKinds?: ReadonlySet<string>,
    annotations: readonly string[] = []): Promise<ArtifactInventoryItemForCaller[]> {
    const result: ArtifactInventoryItemForCaller[] = [];
    const access = selectArtifactCandidateArms(candidateAccess, input);
    let cursor = input.cursor;
    while (result.length < input.limit) {
        const where: Prisma.ArtifactWhereInput = { ...artifactVisibleWhere, ...selection,
            ...(input.ownerAccountId === undefined ? {} : { accountId: input.ownerAccountId }) };
        const conditions: Prisma.ArtifactWhereInput[] = [
            ...(input.audience === 'received' ? [{ accountId: { not: input.actorAccountId } }] : []),
            ...(input.unclassified ? [] : artifactApprovalSelectionWhere(input)), ...(cursor ? [{ OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
            ] }] : [])];
        const scope = await readArtifactCandidatePageScopeInTx(tx, access, where, conditions, input.limit);
        if (scope === null) break;
        const rows = await tx.artifact.findMany({
            // Populated PostgreSQL inventories spend most page time JIT-compiling
            // the joined access projection before LIMIT.
            // Prisma batches these relations inside the same read snapshot.
            ...(getDbProviderFromEnv(process.env, "postgres") === "postgres" ? { relationLoadStrategy: "query" as const } : {}),
            where: { ...where, AND: [scope, ...conditions] },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: input.limit, select: {
                ...artifactReadAdmissionSelect(input.actorAccountId),
                body: !input.unclassified && input.includeBody === true, bodyVersion: true, provenance: true,
                publicShare: { select: { expiresAt: true } },
            } });
        for (const row of await withArtifactSourceReadersInTx(tx, rows, input.actorAccountId)) {
            // MySQL's retained column collation is case-insensitive. Indexed SQL
            // narrows candidates; exact literal membership precedes private opening.
            if (storedKinds && (row.kind === null || (!storedKinds.has(row.kind)
                && !annotations.some(kind => row.kind?.startsWith(`${kind}#`))))) continue;
            if (input.kind !== undefined && input.kind !== null && row.kind !== input.kind
                && !row.kind?.startsWith(`v1:${input.kind}:`)) continue;
            const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
            if (!access) continue;
            const decodedKind = decodeArtifactKindV1(row.kind);
            const locked = (): ArtifactLockedListItemForCaller => ({ id: row.id,
                kind: decodedKind.kind, kindHint: decodedKind.kindHint, ownerAccountId: access.ownerAccountId,
                access: access.level, ...(access.encryptionMode === null ? {} : { encryptionMode: access.encryptionMode }),
                ownerDisplayName: resolveAccountDisplayLabelV1(row.account),
                sharedTeamIds: resolveResourceGrantTeamIdsFromFacts(artifactGrantFacts(row), input.actorAccountId),
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
                headerVersion: row.headerVersion, bodyVersion: row.bodyVersion, seq: row.seq,
                createdAt: row.createdAt, updatedAt: row.updatedAt,
                publicAudience: projectArtifactPublicAudience(row.publicShare, row.signedInLink !== null) });
            const read = projectArtifactAdmittedHeader(row, input.actorAccountId);
            if (!read.ok) {
                if (input.sharedWithTeamId !== undefined) {
                    result.push(locked());
                    if (result.length === input.limit) return result;
                    continue;
                }
                if (access.level === "owner") throw new Error("Artifact content is unavailable");
                continue;
            }
            const content = input.includeBody && !input.unclassified ? projectArtifactBody(read.artifact, row) : projectArtifactRevisionMetadata(read.artifact, row);
            if (!content.ok) {
                if (input.sharedWithTeamId !== undefined) {
                    result.push(locked());
                    if (result.length === input.limit) return result;
                    continue;
                }
                if (access.level === "owner") throw new Error("Artifact content is unavailable");
                continue;
            }
            result.push({ ...content.artifact,
                publicAudience: projectArtifactPublicAudience(row.publicShare, row.signedInLink !== null) });
            if (result.length === input.limit) return result;
        }
        if (rows.length < input.limit) break;
        const last = rows[rows.length - 1];
        cursor = { updatedAt: last.updatedAt, id: last.id };
    }
    return result;
}

/** Completeness is an access fact, never a reason to open unrelated private content.
 * Owned rows are disjoint from received arms; overlapping received arms count distinct
 * identities, which are legacy unclassified rows only. */
async function countUnclassifiedArtifactsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; ownerAccountId?: string; audience?: 'received'; coarseOnly: boolean; includeApprovalState?: boolean;
    candidateAccess: ArtifactCandidateAccess;
}>): Promise<number> {
    const access = selectArtifactCandidateArms(input.candidateAccess, input);
    const where = (arm: Prisma.ArtifactWhereInput): Prisma.ArtifactWhereInput => ({ ...artifactVisibleWhere,
        ...artifactUnclassifiedWhere(input.coarseOnly, input.includeApprovalState),
        ...(input.ownerAccountId === undefined ? {} : { accountId: input.ownerAccountId }),
        AND: [arm, ...(input.audience === 'received' ? [{ accountId: { not: input.actorAccountId } }] : [])] });
    const owned = access.owned === null ? 0 : await tx.artifact.count({ where: where(access.owned) });
    if (access.received.length <= 1) return owned + (access.received[0] ? await tx.artifact.count({ where: where(access.received[0]) }) : 0);
    const received = await Promise.all(access.received.map(arm => tx.artifact.findMany({ where: where(arm), select: { id: true } })));
    return owned + new Set(received.flat().map(row => row.id)).size;
}

/** The filtered page and its completeness witness share the canonical stable read snapshot. */
export async function listArtifactHeaderPageForCaller(input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): Promise<{
    items: ArtifactInventoryItemForCaller[]; hasUnclassified: boolean; coverage: ArtifactKindCoverageV1;
}> {
    if (input.approvalSessionIds?.length === 0) return { items: [], hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } };
    const readCount = async (tx: Tx, candidateAccess: ArtifactCandidateAccess) => input.kind !== undefined || input.kinds !== undefined
        || input.browserListed || input.unclassified
        || input.approvalStates !== undefined || input.approvalSessionIds !== undefined || input.audience !== undefined
        ? await countUnclassifiedArtifactsInTx(tx, { ...input, coarseOnly: input.kind !== undefined || input.unclassified === 'coarse',
            includeApprovalState: !input.browserListed, candidateAccess }) : 0;
    const capture = async (tx: Tx) => {
        // The page and its completeness witness share one candidate access resolution in this snapshot.
        const teamScope = input.sharedWithTeamId === undefined ? null : await resolveTeamArtifactQueryInTx(tx, {
            actorAccountId: input.actorAccountId, sharedWithTeamId: input.sharedWithTeamId,
            teamResourceKind: input.teamResourceKind, authentication: input.authentication,
        });
        if (teamScope && !teamScope.ok) throw Object.assign(new Error(teamScope.error), { code: teamScope.error });
        const candidateAccess = teamScope?.ok ? { owned: null, received: [teamScope.where] } : readArtifactCandidateAccess(input.actorAccountId);
        const items = await listArtifactHeadersForCallerInTx(tx, input, candidateAccess, teamScope?.ok ? teamScope.sharingScopes : undefined);
        const unclassifiedCount = await readCount(tx, candidateAccess);
        const coverage: ArtifactKindCoverageV1 = unclassifiedCount === 0
            ? { status: 'complete', unclassifiedCount: 0 }
            : { status: 'partial', unclassifiedCount, reason: 'unclassified_legacy_rows' };
        return { items, coverage, hasUnclassified: unclassifiedCount > 0 };
    };
    return await captureReadSnapshot(capture);
}

export async function listArtifactAccessGrants(input: Parameters<typeof listArtifactAccessGrantsInTx>[1]): Promise<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>> {
    return await captureReadSnapshot<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>>(
        tx => listArtifactAccessGrantsInTx(tx, input));
}

export async function readArtifactRecipientCensus(input: Parameters<typeof readArtifactRecipientCensusInTx>[1]): Promise<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>> {
    return await captureReadSnapshot<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>>(
        tx => readArtifactRecipientCensusInTx(tx, input));
}

type ArtifactBatchReadItem = Readonly<{
    artifactId: string;
    read: Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure;
    census: Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>> | null;
}>;

/** Full audience facts and every stored envelope, batched so reads do not multiply with the Artifact count. */
async function readArtifactAudienceRowsInTx(tx: Tx, artifactIds: readonly string[]) {
    const readAudienceRows = (ids: readonly string[]) => tx.artifact.findMany({ where: { id: { in: [...ids] }, ...artifactVisibleWhere },
        select: { ...artifactAccessFactsSelect(), dataEncryptionKey: true, provenanceDataEncryptionKey: true,
            keyEnvelopes: artifactRecipientReadSelect().keyEnvelopes } });
    const audienceRows: Awaited<ReturnType<typeof readAudienceRows>> = [];
    for (const ids of portableQueryChunks({ values: artifactIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        audienceRows.push(...await readAudienceRows(ids));
    }
    return withArtifactSourceReadersInTx(tx, audienceRows);
}

/** Each shared recipient's readiness row, read once per capture rather than once per Artifact. */
async function readArtifactCensusAccountsInTx(tx: Tx, accountIds: readonly string[]) {
    const readAccounts = (ids: readonly string[]) => tx.account.findMany({ where: { id: { in: [...ids] } },
        select: RECIPIENT_READINESS_SELECT, orderBy: { id: 'asc' } });
    const accounts: Awaited<ReturnType<typeof readAccounts>> = [];
    for (const ids of portableQueryChunks({ values: [...new Set(accountIds)].sort(), bindingsPerValue: 1, fixedBindings: 1 })) {
        accounts.push(...await readAccounts(ids));
    }
    return accounts;
}

/** Capture the same admission and census facts for the whole request in one snapshot. */
async function captureArtifactBatchInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[]; projection?: 'headers';
}>, includeContent: boolean) {
    const readRows = (artifactIds: readonly string[]) => tx.artifact.findMany({ where: { id: { in: [...artifactIds] }, ...artifactVisibleWhere }, select: {
        ...artifactReadAdmissionSelect(input.actorAccountId),
        body: includeContent && input.projection !== 'headers', bodyVersion: true, provenance: includeContent,
    } });
    const rows: Awaited<ReturnType<typeof readRows>> = [];
    // Admission carries only the caller's grants, memberships and key envelope.
    // SQL chunks stay inside this request's single admitted capture.
    for (const ids of portableQueryChunks({ values: input.artifactIds, bindingsPerValue: 1,
        fixedBindings: 2 })) {
        rows.push(...await readRows(ids));
    }
    const admittedRows = await withArtifactSourceReadersInTx(tx, rows, input.actorAccountId);
    const accessByArtifact = new Map<string, ArtifactAccess>();
    const audienceByArtifact = new Map<string, string[]>();
    const fullAudienceIds: string[] = [];
    for (const row of admittedRows) {
        const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
        if (!access) continue;
        accessByArtifact.set(row.id, access);
        if (input.projection === 'headers' || access.encryptionMode !== 'e2ee') continue;
        if (mayInspectArtifactAudience(row.kind, access)) fullAudienceIds.push(row.id);
        else audienceByArtifact.set(row.id, [input.actorAccountId]);
    }
    const byId = new Map(admittedRows.map(row => [row.id, row]));
    // Only admitted full-inspection resources collect their complete audience.
    for (const row of await readArtifactAudienceRowsInTx(tx, fullAudienceIds)) {
        audienceByArtifact.set(row.id, resolveArtifactAudienceFromFacts(row));
        byId.get(row.id)!.keyEnvelopes = row.keyEnvelopes;
    }
    const accounts = await readArtifactCensusAccountsInTx(tx, [...audienceByArtifact.values()].flat());
    const readPublications = (ids: readonly string[]) => tx.publicSessionShare.findMany({ where: { artifactId: { in: [...ids] } },
        select: { artifactId: true, expiresAt: true } });
    const publications: Awaited<ReturnType<typeof readPublications>> = [];
    if (includeContent) {
        for (const ids of portableQueryChunks({ values: rows.map(row => row.id), bindingsPerValue: 1, fixedBindings: 1 })) {
            publications.push(...await readPublications(ids));
        }
    }
    return { rows: admittedRows, accessByArtifact, audienceByArtifact, accounts, publications };
}

type ArtifactBatchCapture = Awaited<ReturnType<typeof captureArtifactBatchInTx>>;
type ArtifactCensusAccount = Readonly<{ account: RecipientReadinessRow; readiness: AccountRecipientEnvelopeReadiness }>;

function projectArtifactBatchAccounts(captured: ArtifactBatchCapture): Map<string, ArtifactCensusAccount> {
    // Shared recipients are verified once for this snapshot, not once per document.
    return new Map(captured.accounts.map(account => [account.id, { account,
        readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) }]));
}

function projectArtifactBatchCensus(captured: ArtifactBatchCapture, row: ArtifactBatchCapture['rows'][number],
    accounts: ReadonlyMap<string, ArtifactCensusAccount>, header: ArtifactHeaderForCaller): AccessResult<ArtifactAccessRecipientCensusResponseV1> {
    const audience = new Set(captured.audienceByArtifact.get(row.id) ?? []);
    const recipients = [...accounts.values()].filter(({ account }) => audience.has(account.id));
    return projectArtifactRecipientCensus(row.id, { ownerAccountId: header.ownerAccountId, level: header.access,
        encryptionMode: header.encryptionMode }, row, recipients, row.keyEnvelopes,
        { content: header.dataEncryptionKey, provenance: header.provenanceDataEncryptionKey });
}

function materializeArtifactBatch(captured: ArtifactBatchCapture, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[]; projection?: 'headers';
}>): ArtifactBatchReadItem[] {
    const byId = new Map(captured.rows.map(row => [row.id, row]));
    const accounts = projectArtifactBatchAccounts(captured);
    const publications = new Map(captured.publications.map(row => [row.artifactId, row]));
    return input.artifactIds.map((artifactId): ArtifactBatchReadItem => {
        const row = byId.get(artifactId);
        if (!row) return { artifactId, read: { ok: false, error: 'artifact_not_found' }, census: null };
        const access = captured.accessByArtifact.get(artifactId);
        if (!access) return { artifactId, read: { ok: false, error: 'artifact_not_found' }, census: null };
        const header = projectArtifactHeaderForRecipient(row, input.actorAccountId, access, accounts.get(input.actorAccountId)?.readiness);
        if (!header.ok) return { artifactId, read: header, census: null };
        const artifact = { ...header.artifact, sharedTeamIds: resolveResourceGrantTeamIdsFromFacts(artifactGrantFacts(row), input.actorAccountId) };
        const content = input.projection === 'headers' ? projectArtifactRevisionMetadata(artifact, row)
            : projectArtifactBody(artifact, row);
        if (!content.ok) return { artifactId, read: content, census: null };
        return { artifactId, read: { ok: true, artifact: { ...content.artifact,
            publicAudience: projectArtifactPublicAudience(publications.get(artifactId) ?? null, row.signedInLink !== null) } },
            census: input.projection !== 'headers' && header.artifact.encryptionMode === 'e2ee'
                ? projectArtifactBatchCensus(captured, row, accounts, header.artifact) : null };
    });
}

/** Parent readers share their transaction's exact admitted headers, without nested snapshots or private bodies. */
export async function readArtifactHeadersForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[];
}>): Promise<ArtifactBatchReadItem[]> {
    const selection = { ...input, artifactIds: [...new Set(input.artifactIds)], projection: 'headers' as const };
    return materializeArtifactBatch(await captureArtifactBatchInTx(tx, selection, true), selection);
}

export async function readArtifactBatchForCaller(input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[]; projection?: 'headers';
}>): Promise<ArtifactBatchReadItem[]> {
    return await captureReadSnapshot<ArtifactBatchReadItem[], ArtifactBatchCapture>({
        capture: tx => captureArtifactBatchInTx(tx, input, true),
        materialize: async captured => materializeArtifactBatch(captured, input),
    }, { transactionClass: "artifact-details-read" });
}

type AccessResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ArtifactAccessErrorCodeV1 }>;

/**
 * One candidate page of the owner's owed census. Only owned Artifacts with a grant can owe a later member an
 * envelope; each candidate's census is the ordinary owner census (grants, live membership, Project Source
 * readers, envelope rows and recipient readiness), and the shared owed predicate keeps only what it owes.
 */
async function readOwedArtifactRecipientCensusPageInTx(tx: Tx, actorAccountId: string, cursor: string | null) {
    const candidates = await tx.artifact.findMany({ where: { accountId: actorAccountId, ...artifactVisibleWhere, grants: { some: {} },
        ...(cursor === null ? {} : { id: { gt: cursor } }) }, orderBy: { id: 'asc' }, take: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, select: { id: true } });
    const rows = await readArtifactAudienceRowsInTx(tx, candidates.map(candidate => candidate.id));
    const audiences = new Map(rows.map(row => [row.id, resolveArtifactAudienceFromFacts(row)]));
    // Shared recipients are verified once for this page, not once per Artifact.
    const accounts = new Map((await readArtifactCensusAccountsInTx(tx, [...audiences.values()].flat()))
        .map(account => [account.id, { account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) }]));
    const items: ArtifactAccessRecipientCensusResponseV1[] = [];
    for (const row of rows) {
        const access = resolveArtifactAccessFromFacts(row, actorAccountId);
        if (access?.level !== 'owner' || access.encryptionMode !== 'e2ee') continue;
        const recipients = [...new Set(audiences.get(row.id))].sort().flatMap(accountId => accounts.get(accountId) ?? []);
        const census = projectArtifactRecipientCensus(row.id, access, row, recipients, row.keyEnvelopes, null);
        if (!census.ok) continue;
        const owed = listOwedResourceRecipientsV1(census.value, { provenance: census.value.provenanceDataEncryptionKey != null });
        if (owed.length) items.push({ ...census.value, recipients: owed });
    }
    items.sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0);
    return { items, lastCandidateId: candidates.at(-1)?.id ?? null, exhausted: candidates.length < ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 };
}

/**
 * The owner's owed census (`GET /v1/artifacts/access/recipients/owed`), read on the Team-change wake. Walks the
 * caller's owned, granted Artifacts in id order, one read snapshot per candidate page, and answers with the first
 * page that owes something. Nothing owed walks every candidate in one request and returns no cursor. Owed is
 * computed from grants and envelope rows; nothing is stored, and the server never sees a data key.
 */
export async function listOwedArtifactRecipientCensusesForCaller(input: Readonly<{
    actorAccountId: string; cursor?: string;
}>): Promise<ArtifactOwedRecipientCensusPageV1> {
    let cursor = input.cursor ?? null;
    for (;;) {
        const page = await captureReadSnapshot(tx => readOwedArtifactRecipientCensusPageInTx(tx, input.actorAccountId, cursor));
        if (page.exhausted) return { items: page.items, nextCursor: null };
        if (page.items.length) return { items: page.items, nextCursor: page.lastCandidateId };
        cursor = page.lastCandidateId;
    }
}

/** Kind-owned inspection scope is selected before loading any grant display profile. */
export async function listArtifactAccessGrantsInTx(tx: Tx, input: ArtifactAccessGrantsListInputV1 & Readonly<{
    actorAccountId: string;
}>): Promise<AccessResult<ArtifactAccessGrantsListResponseV1>> {
    const membershipAccountId = input.requestedAudience === undefined ? input.actorAccountId : undefined;
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: { ...artifactAccessFactsSelect(membershipAccountId), kind: true } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const admittedRow = (await withArtifactSourceReadersInTx(tx, [row], membershipAccountId))[0]!;
    const access = resolveArtifactAccessFromFacts(admittedRow, input.actorAccountId);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (input.requestedAudience !== undefined && !mayManageResourceGrants(access)) {
        return { ok: false, error: 'artifact_access_forbidden' };
    }
    const selfAccountId = input.requestedAudience !== undefined || mayInspectArtifactAudience(row.kind, access) ? undefined : input.actorAccountId;
    const grants = await readArtifactAccessGrantsForAdmittedCustodyInTx(tx, input.artifactId, selfAccountId, input.actorAccountId);
    if (input.requestedAudience !== undefined) {
        const requested = input.requestedAudience.filter(principal => principal.kind !== 'account' || principal.accountId !== access.ownerAccountId);
        const stored = requested.filter(principal => grants.some(grant => isDeepStrictEqual(grant.principal, principal)));
        const prospective = requested.filter(principal => !grants.some(grant => isDeepStrictEqual(grant.principal, principal)));
        for (const [principals, hasExistingGrant] of [[stored, true], [prospective, false]] as const) {
            const error = await validateResourceGrantPrincipalsInTx(tx, { actorAccountId: input.actorAccountId,
                ownerAccountId: access.ownerAccountId, principals, hasExistingGrant });
            if (error) return { ok: false, error: `artifact_${error}` };
        }
    }
    const missingAudience = input.requestedAudience === undefined ? undefined
        : await resolveResourceGrantMissingAudienceInTx(tx, {
            facts: artifactGrantFacts(admittedRow), requestedAudience: input.requestedAudience,
        });
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId, access: access.level,
        ...(missingAudience === undefined ? {} : { missingAudience }),
        grants: selfAccountId === undefined && decodeArtifactKindV1(row.kind).kindHint === 'bot_template.v1'
            ? await projectAdmittedTemplateAcceptedVersionsInTx(tx, input.artifactId, grants) : grants } };
}

/** A report attributes only the authenticated Account with current effective Artifact access. */
export async function reportArtifactTemplateAcceptedVersionInTx(tx: Tx,
    input: ArtifactTemplateAcceptedVersionInputV1 & { actorAccountId: string },
): Promise<AccessResult<{ changed: boolean }>> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: { ...artifactAccessFactsSelect(input.actorAccountId), kind: true } });
    if (!row) return { ok: false, error: 'artifact_not_found' };
    const access = resolveArtifactAccessFromFacts((await withArtifactSourceReadersInTx(tx, [row], input.actorAccountId))[0]!, input.actorAccountId);
    if (!access) return { ok: false, error: 'artifact_not_found' };
    if (decodeArtifactKindV1(row.kind).kindHint !== 'bot_template.v1') return { ok: false, error: 'artifact_kind_not_shareable' };
    return { ok: true, value: await writeAdmittedTemplateAcceptedVersionInTx(tx, { ...input, ownerAccountId: access.ownerAccountId }) };
}

/** Internal grant facts for an already admitted resource relationship; never admits a caller. */
export async function readArtifactAccessGrantsForAdmittedCustodyInTx(tx: Tx,
    artifactId: string, selfAccountId?: string, recipientAccountId?: string): Promise<ArtifactAccessGrantsListResponseV1['grants']> {
    const { accountGrants: accounts, teamGrants: teams, groupGrants: groups } = projectResourceGrantRows(
        await tx.artifactGrant.findMany({ where: { artifactId, ...(selfAccountId === undefined ? {}
            : { principalKind: 'account', accountId: selfAccountId }) }, include: {
            account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT }, team: { select: { name: true } },
            teamGroup: { select: { name: true, teamId: true } },
        } }));
    return [
            ...accounts.map(row => ({ principal: { kind: "account" as const, accountId: row.accountId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), requiredByTeamPolicy: row.requiredByTeamPolicy, display: { name: resolveAccountDisplayLabelV1(row.account), username: row.account.username } })),
            ...teams.map(row => ({ principal: { kind: "team" as const, teamId: row.teamId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), requiredByTeamPolicy: row.requiredByTeamPolicy, display: { name: row.team.name } })),
            ...groups.map(row => ({ principal: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroupId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), requiredByTeamPolicy: row.requiredByTeamPolicy, display: { name: null },
                groupName: recipientAccountId === undefined ? { kind: 'unavailable' as const }
                    : projectTeamGroupNameForRecipient({ serialized: row.teamGroup.name, recipientAccountId }) })),
        ];
}

/** Owner/admin idempotent grant writes; only the owner may assign admin. */
export async function setArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantSetStorageInputV1 & { actorAccountId: string; authentication?: SessionAccessAuthentication },
    mutationGuard?: ArtifactMutationTransactionGuard,
): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    if (!await admitArtifactMutationInTx(tx, input, mutationGuard, {
        intent: "content", additionalGrantPrincipal: input.principal,
    })) return { ok: false, error: 'artifact_access_forbidden' };
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!mayManageResourceGrants(access, input.accessLevel)) return { ok: false, error: "artifact_access_forbidden" };
    const mutation = await readArtifactGrantMutationInTx(tx, input);
    if (mutation.previous?.requiredByTeamPolicy && isResourceAccessLevelIncrease(input.accessLevel, 'edit')) {
        return { ok: false, error: 'artifact_access_forbidden' };
    }
    const principalError = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
        ownerAccountId: access.ownerAccountId, principal: input.principal, hasExistingGrant: mutation.previous !== null });
    if (principalError) return { ok: false, error: `artifact_${principalError}` };
    const increasesAccess = isResourceAccessLevelIncrease(mutation.previous?.accessLevel ?? null, input.accessLevel);
    if (increasesAccess && !await mayAdmitReviewExternalGrantInTx(tx, input)) {
        return { ok: false, error: 'artifact_access_forbidden' };
    }
    const changed = mutation.previous?.accessLevel !== input.accessLevel;
    const previousAudience = changed ? await resolveArtifactAudienceInTx(tx, input.artifactId) : [];
    if (changed) await mutation.upsert();
    if (changed) {
        const audience = await resolveArtifactAudienceInTx(tx, input.artifactId);
        const recipients = await markAccountsChanged(tx, { accountIds: audience, kind: "artifact", entityId: input.artifactId });
        await publishWorkflowActionIndexChangedInTx(tx, { workflowId: input.artifactId, recipients,
            admittedAccountIds: audience, previousAccountIds: previousAudience });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return listed.ok ? { ok: true, value: { ...listed.value, changed } } : listed;
}

/** The caller has admitted and locked these exact principals before any write. */
export async function applyArtifactPublicationGrantsInTx(tx: Tx, input: Readonly<{
    artifactId: string; actorAccountId: string; publicationGrants: ArtifactMutationAdmission['publicationGrants'];
}>): Promise<void> {
    for (const grant of input.publicationGrants) {
        if (grant.principal.kind === 'account' && grant.principal.accountId === input.actorAccountId) continue;
        const mutation = await readArtifactGrantMutationInTx(tx, { ...input, ...grant });
        if (mutation.previous?.accessLevel !== grant.accessLevel
            || (grant.requiredByTeamPolicy === true && mutation.previous?.requiredByTeamPolicy !== true)) await mutation.upsert();
    }
}

/** A live authenticated link admits only its caller's ordinary Can-copy grant. */
export async function joinArtifactSignedInLinkAccessInTx(tx: Tx, input: Readonly<{
    artifactId: string; authorAccountId: string; actorAccountId: string; encryptionMode: 'plain' | 'e2ee';
    keyEnvelope?: ArtifactRecipientKeyEnvelopeInputV1;
}>) {
    if (input.keyEnvelope && input.keyEnvelope.recipientAccountId !== input.actorAccountId) {
        return { ok: false, error: 'artifact_access_forbidden' } as const;
    }
    const current = await resolveArtifactAccessInTx(tx, input);
    if (input.actorAccountId === input.authorAccountId) {
        return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: input.authorAccountId, access: 'owner' } } as const;
    }
    if (input.encryptionMode === 'plain') {
        if (input.keyEnvelope) return { ok: false, error: 'data_key_not_required' } as const;
    } else {
        const recipient = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT });
        if (!recipient) return { ok: false, error: 'artifact_access_forbidden' } as const;
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(recipient);
        if (readiness.status === 'unavailable') return { ok: false, error: 'recipient_key_unavailable', reason: readiness.reason } as const;
        if (!input.keyEnvelope || !validateResourceRecipientKeyEnvelopes([input.keyEnvelope])) {
            return { ok: false, error: 'invalid_recipient_envelope' } as const;
        }
        if (input.keyEnvelope.recipientContentPublicKeyFingerprint !== readiness.binding.contentPublicKeyFingerprint) {
            return { ok: false, error: 'recipient_key_changed' } as const;
        }
    }
    const mutation = await readArtifactGrantMutationInTx(tx, { artifactId: input.artifactId, actorAccountId: input.authorAccountId,
        principal: { kind: 'account', accountId: input.actorAccountId }, accessLevel: 'view' });
    if (!mutation.previous) await mutation.upsert();
    const becameReadable = input.keyEnvelope
        ? await writeArtifactRecipientEnvelopeInTx(tx, input.artifactId, input.keyEnvelope) : false;
    const admittedAccountIds = [input.authorAccountId, input.actorAccountId];
    const recipients = await markAccountsChanged(tx, { accountIds: admittedAccountIds, kind: 'artifact', entityId: input.artifactId });
    await publishWorkflowActionIndexChangedInTx(tx, { workflowId: input.artifactId, recipients, admittedAccountIds,
        previousAccountIds: current && !becameReadable ? admittedAccountIds : [input.authorAccountId] });
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: input.authorAccountId, access: current?.level ?? 'view' } } as const;
}

async function readArtifactGrantMutationInTx(tx: Tx, input: ArtifactAccessGrantSetStorageInputV1 & { actorAccountId: string; requiredByTeamPolicy?: boolean }) {
    const principal = input.principal;
    const data = { accessLevel: input.accessLevel, createdByAccountId: input.actorAccountId,
        ...(input.requiredByTeamPolicy === true ? { requiredByTeamPolicy: true } : {}) };
    let previous: Readonly<{ accessLevel: ArtifactAccessGrantSetStorageInputV1['accessLevel']; requiredByTeamPolicy: boolean }> | null;
    let upsert: () => Promise<unknown>;
    if (principal.kind === "account") {
        const where = { artifactId_accountId: { artifactId: input.artifactId, accountId: principal.accountId } };
        previous = await tx.artifactGrant.findUnique({ where: { ...where, principalKind: 'account' } });
        upsert = () => tx.artifactGrant.upsert({ where: { ...where, principalKind: 'account' }, create: { principalKind: 'account', artifactId: input.artifactId, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === "team") {
        const where = { artifactId_teamId: { artifactId: input.artifactId, teamId: principal.teamId } };
        previous = await tx.artifactGrant.findUnique({ where: { ...where, principalKind: 'team' } });
        upsert = () => tx.artifactGrant.upsert({ where: { ...where, principalKind: 'team' }, create: { principalKind: 'team', artifactId: input.artifactId, teamId: principal.teamId, ...data }, update: data });
    } else {
        const where = { artifactId_teamGroupId: { artifactId: input.artifactId, teamGroupId: principal.groupId } };
        previous = await tx.artifactGrant.findUnique({ where: { ...where, principalKind: 'group' } });
        upsert = () => tx.artifactGrant.upsert({ where: { ...where, principalKind: 'group' }, create: { principalKind: 'group', artifactId: input.artifactId, teamGroupId: principal.groupId, ...data }, update: data });
    }
    return { previous, upsert };
}

/** Revocation removes unreachable envelopes and reports success without a roster when the caller loses access. */
export async function removeArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantRemoveInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId], { intent: "content" });
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!mayManageResourceGrants(access)) return { ok: false, error: "artifact_access_forbidden" };
    const principal = input.principal;
    if (principal.kind === "group") {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true } });
        if (!group || group.teamId !== principal.teamId) return { ok: false, error: "artifact_subject_not_found" };
    }
    const where: Prisma.ArtifactGrantWhereInput = { artifactId: input.artifactId,
        ...(principal.kind === 'account' ? { principalKind: 'account', accountId: principal.accountId }
            : principal.kind === 'team' ? { principalKind: 'team', teamId: principal.teamId }
                : { principalKind: 'group', teamGroupId: principal.groupId }) };
    const grant = await tx.artifactGrant.findFirst({ where, select: { requiredByTeamPolicy: true } });
    if (grant?.requiredByTeamPolicy) return { ok: false, error: 'artifact_access_forbidden' };
    const previousAudience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    const deleted = await tx.artifactGrant.deleteMany({ where });
    const audience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    await tx.artifactKeyEnvelope.deleteMany({ where: { artifactId: input.artifactId, recipientAccountId: { notIn: audience } } });
    if (deleted.count > 0) {
        const recipients = await markAccountsChanged(tx, { accountIds: previousAudience, kind: "artifact", entityId: input.artifactId });
        await publishWorkflowActionIndexChangedInTx(tx, { workflowId: input.artifactId, recipients,
            admittedAccountIds: audience, previousAccountIds: previousAudience });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return { ok: true, value: listed.ok
        ? { ...listed.value, changed: deleted.count > 0 }
        : { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId,
            access: null, grants: [], changed: deleted.count > 0 } };
}

/** Current audience plus verified binding and envelope state for a key-holding host. */
export async function readArtifactRecipientCensusInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string;
    projectSourceId?: string; projectSourcePatch?: ProjectSourcePublicationPatchV1 }>): Promise<AccessResult<ArtifactAccessRecipientCensusResponseV1>> {
    if (input.projectSourcePatch && !input.projectSourceId) return { ok: false, error: 'artifact_access_forbidden' };
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactAccessFactsSelect(input.actorAccountId), kind: true, dataEncryptionKey: true, provenanceDataEncryptionKey: true,
    } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const sourceReaders = input.projectSourceId ? await readArtifactSourcePublicationReadersInTx(tx, {
        ...input, artifact: row, projectSourceId: input.projectSourceId }) : [];
    if (!sourceReaders) return { ok: false, error: 'artifact_access_forbidden' };
    const admitted = (await withArtifactSourceReadersInTx(tx, [row], input.actorAccountId))[0]!;
    const access = resolveArtifactAccessFromFacts({ ...admitted, sourceReaderAccounts: [...admitted.sourceReaderAccounts, ...sourceReaders] }, input.actorAccountId);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!access.encryptionMode) return { ok: false, error: "artifact_content_unavailable" };
    const inspectAudience = mayInspectArtifactAudience(row.kind, access);
    const audience = inspectAudience ? [...new Set([...await resolveArtifactAudienceInTx(tx, input.artifactId),
        ...sourceReaders.map(reader => reader.accountId)])] : [input.actorAccountId];
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: audience } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: "asc" } }),
        tx.artifactKeyEnvelope.findMany({ where: { artifactId: input.artifactId,
            ...(inspectAudience ? {} : { recipientAccountId: input.actorAccountId }) } }),
    ]);
    const plain = access.encryptionMode === "plain";
    const callerEnvelopes = !plain && access.level !== 'owner' ? await recipientEnvelopesInTx(tx, input.artifactId, input.actorAccountId) : null;
    return projectArtifactRecipientCensus(input.artifactId, access, row,
        accounts.map(account => ({ account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) })), envelopes, callerEnvelopes);
}

function projectArtifactRecipientCensus(artifactId: string, access: ArtifactAccess,
    row: Pick<StoredArtifactHeader, 'dataEncryptionKey' | 'provenanceDataEncryptionKey'>,
    accounts: readonly ArtifactCensusAccount[],
    envelopes: readonly (StoredRecipientEnvelope & Readonly<{ recipientAccountId: string; encryptedProvenanceDataKey: Uint8Array | null }>)[],
    callerEnvelopes: Awaited<ReturnType<typeof recipientEnvelopesInTx>> | null): AccessResult<ArtifactAccessRecipientCensusResponseV1> {
    if (!access.encryptionMode || !artifactProvenanceMatchesAccountMode({ mode: access.encryptionMode, artifactId, bodyVersion: 0,
        provenance: null, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { ok: false, error: 'artifact_content_unavailable' };
    const byAccount = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    const plain = access.encryptionMode === 'plain';
    const contentCensus = projectResourceRecipientCensus({ access, ownerDataEncryptionKey: row.dataEncryptionKey,
        callerDataEncryptionKey: callerEnvelopes?.content ?? null, accounts, envelopes });
    if (!contentCensus.ok) return { ok: false, error: 'artifact_content_unavailable' };
    const callerPrivateKey = plain ? null : access.level === 'owner'
        ? row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null : callerEnvelopes?.provenance ?? null;
    return { ok: true, value: { ...contentCensus.value, artifactId,
        provenanceDataEncryptionKey: !plain && row.provenanceDataEncryptionKey ? privacyKit.encodeBase64(new Uint8Array(row.provenanceDataEncryptionKey)) : null,
        callerProvenanceDataEncryptionKey: callerPrivateKey ? privacyKit.encodeBase64(callerPrivateKey) : null,
        recipients: contentCensus.value.recipients.map(content => {
            const envelope = byAccount.get(content.recipientAccountId);
            const ownerEnvelope = content.encryptedDataKey !== null && content.recipientAccountId === access.ownerAccountId
                && parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey) !== null;
            const current = content.encryptedDataKey !== null && !ownerEnvelope;
            return { ...content,
                encryptedProvenanceDataKey: ownerEnvelope && row.provenanceDataEncryptionKey ? privacyKit.encodeBase64(new Uint8Array(row.provenanceDataEncryptionKey))
                    : current && envelope?.encryptedProvenanceDataKey && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedProvenanceDataKey)
                        ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedProvenanceDataKey)) : null,
            };
        }) } };
}

/** Commit opaque client-prepared tuples only while owner key, caller and recipient remain current. */
export async function commitArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: ArtifactRecipientKeyEnvelopeCommitInputV1 & { actorAccountId: string },
    mutationGuard?: ArtifactMutationTransactionGuard,
): Promise<AccessResult<ArtifactRecipientKeyEnvelopeCommitResponseV1>> {
    if (input.projectSourcePatch && !input.projectSourceId) return { ok: false, error: 'artifact_access_forbidden' };
    const sourceRow = input.projectSourceId ? await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: artifactAccessFactsSelect() }) : null;
    const sourceReaders = input.projectSourceId && sourceRow ? await readArtifactSourcePublicationReadersInTx(tx, {
        ...input, artifact: sourceRow, projectSourceId: input.projectSourceId }) : [];
    if (input.projectSourceId && (!sourceRow || !sourceReaders)) return { ok: false, error: 'artifact_access_forbidden' };
    const sourceFacts = sourceRow && sourceReaders ? artifactGrantFacts({ ...sourceRow, sourceReaderAccounts: sourceReaders }) : undefined;
    if (!await admitArtifactMutationInTx(tx, input, mutationGuard, { intent: 'content',
        additionalAccountIds: sourceReaders?.map(reader => reader.accountId) })) {
        return { ok: false, error: 'artifact_access_forbidden' };
    }
    const access = sourceFacts ? resolveResourceGrantAccessFromFacts(sourceFacts, input.actorAccountId) : await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (access.encryptionMode === "plain") return { ok: false, error: "data_key_not_required" };
    if (access.encryptionMode !== "e2ee") return { ok: false, error: "artifact_content_unavailable" };
    const caller = await readArtifactForCallerInTx(tx, input);
    if (!caller.ok) return caller;
    const row = await tx.artifact.findUniqueOrThrow({ where: { id: input.artifactId }, select: { kind: true, dataEncryptionKey: true, provenanceDataEncryptionKey: true } });
    if (!mayInspectArtifactAudience(row.kind, access) && input.recipientKeyEnvelopes.some(envelope => envelope.recipientAccountId !== input.actorAccountId)) {
        return { ok: false, error: 'artifact_access_forbidden' };
    }
    const envelopeCommitError = validateResourceRecipientEnvelopeCommit({ ownerDataEncryptionKey: row.dataEncryptionKey, ...input });
    if (envelopeCommitError === 'data_key_changed') {
        return { ok: false, error: "artifact_data_key_changed" };
    }
    const expectedPrivate = input.expectedProvenanceDataEncryptionKey == null ? null : privacyKit.decodeBase64(input.expectedProvenanceDataEncryptionKey);
    if ((input.expectedProvenanceDataEncryptionKey !== undefined || input.recipientKeyEnvelopes.some(envelope => envelope.encryptedProvenanceDataKey !== undefined))
        && !isDeepStrictEqual(row.provenanceDataEncryptionKey ? new Uint8Array(row.provenanceDataEncryptionKey) : null, expectedPrivate)) {
        return { ok: false, error: 'artifact_data_key_changed' };
    }
    if (envelopeCommitError === 'invalid_recipient_envelope') return { ok: false, error: 'artifact_invalid_recipient_envelope' };
    for (const envelope of input.recipientKeyEnvelopes) {
        if (envelope.encryptedProvenanceDataKey !== undefined && (!row.provenanceDataEncryptionKey
            || !parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey)))) {
            return { ok: false, error: 'artifact_invalid_recipient_envelope' };
        }
    }
    return { ok: true, value: await applyArtifactRecipientKeyEnvelopesInTx(tx, input, sourceFacts) };
}

/** Both fenced commits and Account transitions revalidate recipients through this owner. */
export async function applyArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: Readonly<{
    artifactId: string;
    recipientKeyEnvelopes: readonly ArtifactRecipientKeyEnvelopeInputV1[];
}>, admittedFacts?: ReturnType<typeof artifactGrantFacts>): Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1> {
    const newlyReadable = new Set<string>();
    const adapter: typeof artifactRecipientEnvelopeStorageAdapter = { ...artifactRecipientEnvelopeStorageAdapter,
        ...(admittedFacts ? { readAccessFactsInTx: async () => admittedFacts } : {}),
        async writeRecipientEnvelopeInTx(tx, artifactId, envelope) {
            if (await writeArtifactRecipientEnvelopeInTx(tx, artifactId, envelope)) newlyReadable.add(envelope.recipientAccountId);
        },
        async publishRecipientsChangedInTx(tx, artifactId, accountIds) {
            const recipients = await markAccountsChanged(tx, { accountIds: [...accountIds], kind: 'artifact', entityId: artifactId });
            await publishWorkflowActionIndexChangedInTx(tx, { workflowId: artifactId,
                recipients: recipients.filter(recipient => newlyReadable.has(recipient.accountId)),
                admittedAccountIds: accountIds });
        },
    };
    return applyResourceRecipientKeyEnvelopesInTx(tx, adapter,
        { resourceId: input.artifactId, recipientKeyEnvelopes: input.recipientKeyEnvelopes });
}

async function writeArtifactRecipientEnvelopeInTx(tx: Tx, artifactId: string,
    envelope: ArtifactRecipientKeyEnvelopeInputV1): Promise<boolean> {
    const bytes = privacyKit.decodeBase64(envelope.encryptedDataKey);
    const previous = await tx.artifactKeyEnvelope.findUnique({ where: { artifactId_recipientAccountId: {
        artifactId, recipientAccountId: envelope.recipientAccountId } },
        select: { recipientContentPublicKeyFingerprint: true, encryptedDataKey: true } });
    const data = { encryptedDataKey: bytes, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
        ...(envelope.encryptedProvenanceDataKey === undefined
            ? previous && previous.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint
                ? { encryptedProvenanceDataKey: null } : {}
            : { encryptedProvenanceDataKey: privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey) }) };
    await tx.artifactKeyEnvelope.upsert({ where: { artifactId_recipientAccountId: {
        artifactId, recipientAccountId: envelope.recipientAccountId } },
        create: { artifactId, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
    return !previous || previous.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint
    || parseEncryptedDataKeyEnvelopeV1(previous.encryptedDataKey) === null;
}

/** Only Artifact persistence/provenance semantics remain in this adapter. */
const artifactRecipientEnvelopeStorageAdapter: ResourceRecipientEnvelopeStorageAdapter<ArtifactRecipientKeyEnvelopeInputV1> = {
    // Delegate at call time: the grant adapter sits in a runtime import cycle (teams ↔ discussions ↔ artifacts).
    readAccessFactsBatchInTx: (tx, resourceIds, actorAccountId) => artifactGrantStorageAdapter.readAccessFactsBatchInTx(tx, resourceIds, actorAccountId),
    readAccessFactsInTx: (tx, resourceId, actorAccountId) => artifactGrantStorageAdapter.readAccessFactsInTx(tx, resourceId, actorAccountId),
    async writeRecipientEnvelopeInTx(tx, artifactId, envelope) {
        await writeArtifactRecipientEnvelopeInTx(tx, artifactId, envelope);
    },
    async publishRecipientsChangedInTx(tx, artifactId, accountIds) {
        await markAccountsChanged(tx, { accountIds: [...accountIds], kind: 'artifact', entityId: artifactId });
    },
};
