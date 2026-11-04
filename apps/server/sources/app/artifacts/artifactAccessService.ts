import { projectAdmittedTemplateAcceptedVersionsInTx, writeAdmittedTemplateAcceptedVersionInTx } from './artifactTemplateAcceptedVersionStorage';
import type { ArtifactTemplateAcceptedVersionInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { resolveResourceGrantTeamIdsFromFacts } from '@/app/teams/resourceGrantAccess';
import { getArtifactGrantInspectionPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import * as privacyKit from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { type ArtifactAccessErrorCodeV1, type ArtifactAccessGrantSetStorageInputV1, type ArtifactAccessGrantRemoveInputV1, type ArtifactAccessGrantsListResponseV1, type ArtifactAccessGrantMutationResponseV1, type ArtifactAccessRecipientCensusResponseV1, type ArtifactCallerAccessV1, type ArtifactRecipientKeyEnvelopeCommitInputV1, type ArtifactRecipientKeyEnvelopeCommitResponseV1, type ArtifactRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import type { AccountAdmissionIntent } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { artifactOrdinarySqlPredicate, artifactVisibleWhere } from "./artifactClassification";
import { openArtifactStoredContentBytes, openArtifactProvenanceBytes, artifactProvenanceMatchesAccountMode } from "./artifactStoredContent";
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadiness } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { resolveResourceGrantAccessFromFacts, resolveResourceGrantAudienceFromFacts,
    resolveResourceGrantAccessInTx, resolveResourceGrantAudienceInTx,
    type ResourceGrantAccess, projectResourceRecipientEnvelope as projectRecipientEnvelope,
    projectResourceRecipientCensus, validateResourceRecipientEnvelopeCommit, applyResourceRecipientKeyEnvelopesInTx,
    mayManageResourceGrants, validateResourceGrantPrincipalInTx, readResourceGrantPrincipalAudienceInTx, validateResourceRecipientKeyEnvelopes,
    type ResourceStoredRecipientEnvelope, type ResourceRecipientEnvelopeStorageAdapter } from '@/app/teams/resourceGrantAccess';
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ARTIFACT_BROWSER_NON_LISTED_KINDS_V1, type ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { ArtifactCoarseKindV1Schema, decodeArtifactKindV1, type ArtifactCoarseKindV1, type ArtifactKindCoverageV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { resourceGrantAccessWhere, resourceGrantAccessSqlPredicate } from '@/app/teams/resourceGrantAccess';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { artifactAccessFactsSelect, artifactGrantFacts, artifactGrantStorageAdapter, type ArtifactAccessFacts } from './artifactGrantStorageAdapter';
import { APPROVAL_ARTIFACT_KINDS_V1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

export type ArtifactAccess = ResourceGrantAccess;

/** Retained anonymous or authenticated links both expose replacement Artifact bytes. */
const artifactAddress = (artifactId: string) => ({ id: artifactId, ...artifactVisibleWhere });

function resolveArtifactAccessFromFacts(row: ArtifactAccessFacts, actorAccountId: string): ArtifactAccess | null {
    return resolveResourceGrantAccessFromFacts(artifactGrantFacts(row), actorAccountId);
}

/** One inspection decision for grants, census, selected-detail reads and envelope commits. */
export async function resolveArtifactAccessInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<ArtifactAccess | null> {
    return resolveResourceGrantAccessInTx(tx, artifactGrantStorageAdapter, { resourceId: input.artifactId, actorAccountId: input.actorAccountId });
}

/** Candidate discovery is a database predicate; only the access owner admits rows. */
function artifactCandidateWhere(actorAccountId: string): Prisma.ArtifactWhereInput {
    return resourceGrantAccessWhere(actorAccountId);
}

/** Fan-out and recipient preparation consume the same live access decision. */
export async function resolveArtifactAudienceInTx(tx: Tx, artifactId: string): Promise<string[]> {
    return resolveResourceGrantAudienceInTx(tx, artifactGrantStorageAdapter, artifactId);
}

/** A retained recipient key or public link still exposes replacement bytes. */
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
    if (getDbProviderFromEnv(process.env, "postgres") === "postgres") {
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
export type ArtifactHeaderReadResult = Readonly<{ ok: true; artifact: ArtifactHeaderForCaller }> | ArtifactReadFailure;

/** Request-private exact content custody produced by authenticated finite-job admission, never by HTTP input. */
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
    actorAccountId: string; artifactId: string;
}>): Promise<ArtifactHeaderReadResult> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: artifactReadAdmissionSelect(input.actorAccountId) });
    return row ? projectArtifactAdmittedHeader(row, input.actorAccountId)
        : { ok: false, error: "artifact_not_found" };
}

/** Open only server at-rest Plain content; E2EE stays opaque with the caller's envelope. */
export function readArtifactForCallerInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string; projection?: never }>):
    Promise<ArtifactFullReadResult>;
export function readArtifactForCallerInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string; projection?: 'headers' }>):
    Promise<Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure>;
export async function readArtifactForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string; projection?: 'headers';
}>): Promise<Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactReadAdmissionSelect(input.actorAccountId), body: input.projection !== 'headers', bodyVersion: true, provenance: true,
    } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const header = projectArtifactAdmittedHeader(row, input.actorAccountId);
    if (!header.ok) return header;
    const read = input.projection === 'headers' ? projectArtifactRevisionMetadata(header.artifact, row) : projectArtifactBody(header.artifact, row);
    if (!read.ok) return read;
    const publication = await tx.publicSessionShare.findUnique({ where: { artifactId: input.artifactId }, select: { expiresAt: true } });
    return { ok: true, artifact: { ...read.artifact, publicAudience: projectArtifactPublicAudience(publication, row.signedInLink !== null) } };
}

/** Re-admit captured content through the same mode and recipient-key owner. */
export async function readmitArtifactContentInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>,
    captured: Pick<ArtifactHeaderForCaller, "ownerAccountId" | "encryptionMode" | "dataEncryptionKey" | "provenanceDataEncryptionKey">): Promise<ArtifactHeaderReadResult> {
    const current = await readArtifactHeaderForCallerInTx(tx, input);
    if (!current.ok) return current;
    if (!artifactContentAdmissionMatches(current.artifact, captured)) {
        return { ok: false, error: "artifact_content_unavailable", ownerAccountId: current.artifact.ownerAccountId };
    }
    return current;
}

export async function readArtifactForCaller(input: Readonly<{ actorAccountId: string; artifactId: string }>): Promise<ArtifactFullReadResult> {
    return await readSnapshotWithCurrentAdmission<ArtifactFullReadResult>(
        tx => readArtifactForCallerInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await readmitArtifactContentInTx(tx, input, captured.artifact);
            if (!current.ok) return current;
            return { ...captured, artifact: { ...captured.artifact, access: current.artifact.access } };
        }, { transactionClass: "artifact-read" });
}

function artifactReadAdmissionSelect(actorAccountId?: string) {
    const facts = artifactAccessFactsSelect(actorAccountId);
    return { ...facts, ...artifactRecipientReadSelect(actorAccountId),
        teamGrants: { select: { ...facts.teamGrants.select, teamId: true } },
    } as const;
}

function projectArtifactAdmittedHeader(row: Prisma.ArtifactGetPayload<{ select: ReturnType<typeof artifactReadAdmissionSelect> }>, actorAccountId: string,
    recipientReadiness?: AccountRecipientEnvelopeReadiness): ArtifactHeaderReadResult {
    const access = resolveArtifactAccessFromFacts(row, actorAccountId);
    if (!access) return { ok: false, error: 'artifact_not_found' };
    const read = projectArtifactHeaderForRecipient(row, actorAccountId, access, recipientReadiness);
    return read.ok ? { ok: true, artifact: { ...read.artifact,
        sharedTeamIds: resolveResourceGrantTeamIdsFromFacts(artifactGrantFacts(row), actorAccountId) } } : read;
}

function artifactContentAdmissionMatches(current: ArtifactHeaderForCaller, captured: Pick<ArtifactHeaderForCaller,
    "ownerAccountId" | "encryptionMode" | "dataEncryptionKey" | "provenanceDataEncryptionKey">): boolean {
    return current.ownerAccountId === captured.ownerAccountId && current.encryptionMode === captured.encryptionMode
        && isDeepStrictEqual(current.dataEncryptionKey, captured.dataEncryptionKey)
        && isDeepStrictEqual(current.provenanceDataEncryptionKey, captured.provenanceDataEncryptionKey);
}

const browserNonListedStoredKinds = ARTIFACT_BROWSER_NON_LISTED_KINDS_V1.flatMap(kind =>
    ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));

const approvalStoredKinds = Object.values(APPROVAL_ARTIFACT_KINDS_V1).flatMap(kind =>
    ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));
const approvalKindWhere: Prisma.ArtifactWhereInput = { OR: [
    { kind: { in: approvalStoredKinds } },
    ...ArtifactCoarseKindV1Schema.options.map(coarse => ({ kind: { startsWith: `v1:${coarse}:${APPROVAL_ARTIFACT_KINDS_V1.builtIn}#managed-delete:` } })),
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
    // Access/lifecycle/recipient/keyset/LIMIT operands, then the optional selectors.
    return 4 + 5 + 4 + 3 + 2 + (input.ownerAccountId === undefined ? 0 : 1) + (input.audience === 'received' ? 1 : 0)
        + (input.kind === undefined || input.kind === null ? 0 : 2)
        + (input.browserListed ? browserNonListedStoredKinds.length : 0)
        + (input.approvalStates === undefined ? 0
            : approvalStoredKinds.length + ArtifactCoarseKindV1Schema.options.length + new Set(input.approvalStates).size)
        + (input.kinds?.includes(APPROVAL_ARTIFACT_KINDS_V1.builtIn) ? ArtifactCoarseKindV1Schema.options.length : 0);
}

function mergeArtifactHeaderPages(rows: readonly ArtifactListItemForCaller[], limit: number): ArtifactListItemForCaller[] {
    return [...new Map(rows.map(row => [row.id, row])).values()].sort((left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)).slice(0, limit);
}

/** Batch list projection preserves the endpoint's existing keyset and page size without per-row queries. */
export async function listArtifactHeadersForCallerInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; limit: number; cursor: Readonly<{ updatedAt: Date; id: string }> | null;
    includeBody?: boolean;
    audience?: 'received';
    ownerAccountId?: string;
    kind?: ArtifactCoarseKindV1 | null;
    kinds?: readonly string[];
    approvalStates?: readonly ApprovalArtifactStateV1[];
    approvalSessionIds?: readonly string[];
    browserListed?: true;
    unclassified?: boolean | 'coarse' | 'approval';
}>): Promise<ArtifactListItemForCaller[]> {
    if (input.approvalSessionIds !== undefined && !input.unclassified) {
        const selected: ArtifactListItemForCaller[] = [];
        // Both sets can be unbounded. Reserve an equal bind share for kinds when
        // present; each physical query still uses the canonical portable ceiling.
        for (const sessionIds of portableQueryChunks({ values: [...new Set(input.approvalSessionIds)],
            bindingsPerValue: input.kinds === undefined ? 1 : 2, fixedBindings: artifactListFixedBindings(input) })) {
            selected.push(...await listArtifactHeaderQueryInTx(tx, { ...input, approvalSessionIds: sessionIds }));
        }
        return mergeArtifactHeaderPages(selected, input.limit);
    }
    return listArtifactHeaderQueryInTx(tx, input);
}

async function listArtifactHeaderQueryInTx(tx: Tx, input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): Promise<ArtifactListItemForCaller[]> {
    if (input.browserListed) {
        // MySQL's retained text collation folds unknown case/accent/space variants.
        // Byte-exact candidate paging preserves the kind policy's ordinary documents.
        if (getDbProviderFromEnv(process.env, 'postgres') === 'mysql') return listBrowserArtifactHeadersMysqlInTx(tx, input);
        return listArtifactHeaderSelectionInTx(tx, input, { OR: [
            { kind: null }, { kind: { notIn: browserNonListedStoredKinds } },
        ] });
    }
    if (input.kinds !== undefined) {
        // Exact strings use indexed equality over every existing family. Chunk at
        // the DB transport boundary, merging only selected page-sized projections.
        const exactKinds = new Set(input.kinds);
        const values = [...exactKinds].flatMap(kind => ArtifactCoarseKindV1Schema.options.map(coarse => `v1:${coarse}:${kind}`));
        const selected: ArtifactListItemForCaller[] = [];
        for (const kinds of portableQueryChunks({ values, bindingsPerValue: 1,
            fixedBindings: artifactListFixedBindings(input) + (input.approvalSessionIds?.length ?? 0) })) {
            const annotations = exactKinds.has(APPROVAL_ARTIFACT_KINDS_V1.builtIn)
                ? kinds.filter(kind => kind.endsWith(`:${APPROVAL_ARTIFACT_KINDS_V1.builtIn}`)) : [];
            selected.push(...await listArtifactHeaderSelectionInTx(tx, input, { OR: [
                { kind: { in: [...kinds] } }, ...annotations.map(kind => ({ kind: { startsWith: `${kind}#managed-delete:` } })),
            ] }, new Set(kinds), annotations));
        }
        return mergeArtifactHeaderPages(selected, input.limit);
    }
    const selection: Prisma.ArtifactWhereInput = input.unclassified
        ? artifactUnclassifiedWhere(input.unclassified === 'coarse')
        : input.kind === null ? { kind: null }
            : input.kind === undefined ? {} : { OR: [{ kind: input.kind }, { kind: { startsWith: `v1:${input.kind}:` } }] };
    return listArtifactHeaderSelectionInTx(tx, input, selection);
}

/** Only page-sized identities cross the MySQL bytewise-query/Prisma-content boundary. */
async function listBrowserArtifactHeadersMysqlInTx(tx: Tx, input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): Promise<ArtifactListItemForCaller[]> {
    const sql = prismaRuntime.sql;
    const access = resourceGrantAccessSqlPredicate({ actorAccountId: input.actorAccountId,
        resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' });
    const listed = browserNonListedStoredKinds.length === 0 ? sql`TRUE`
        : sql`(a.\`kind\` IS NULL OR CAST(a.\`kind\` AS BINARY) NOT IN
            (${prismaRuntime.join(browserNonListedStoredKinds.map(kind => sql`CAST(${kind} AS BINARY)`))}))`;
    const result: ArtifactListItemForCaller[] = [];
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
            { id: { in: positions.map(row => row.id) } }));
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
    selection: Prisma.ArtifactWhereInput, storedKinds?: ReadonlySet<string>, annotations: readonly string[] = []): Promise<ArtifactListItemForCaller[]> {
    const result: ArtifactListItemForCaller[] = [];
    let cursor = input.cursor;
    while (result.length < input.limit) {
        const rows = await tx.artifact.findMany({
            // Populated PostgreSQL inventories spend most page time JIT-compiling
            // the joined access projection before LIMIT.
            // Prisma batches these relations inside the same read snapshot.
            ...(getDbProviderFromEnv(process.env, "postgres") === "postgres" ? { relationLoadStrategy: "query" as const } : {}),
            where: {
                ...artifactVisibleWhere,
                ...selection,
                ...(input.ownerAccountId === undefined ? {} : { accountId: input.ownerAccountId }),
                AND: [artifactCandidateWhere(input.actorAccountId),
                    ...(input.audience === 'received' ? [{ accountId: { not: input.actorAccountId } }] : []),
                    ...(input.unclassified ? [] : artifactApprovalSelectionWhere(input)), ...(cursor ? [{ OR: [
                    { updatedAt: { lt: cursor.updatedAt } },
                    { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                ] }] : [])],
            }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: input.limit, select: {
                ...artifactReadAdmissionSelect(input.actorAccountId),
                body: !input.unclassified && input.includeBody === true, bodyVersion: true, provenance: true,
                publicShare: { select: { expiresAt: true } },
            } });
        for (const row of rows) {
            // MySQL's retained column collation is case-insensitive. Indexed SQL
            // narrows candidates; exact literal membership precedes private opening.
            if (storedKinds && (row.kind === null || (!storedKinds.has(row.kind)
                && !annotations.some(kind => row.kind?.startsWith(`${kind}#managed-delete:`))))) continue;
            if (input.kind !== undefined && input.kind !== null && row.kind !== input.kind
                && !row.kind?.startsWith(`v1:${input.kind}:`)) continue;
            const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
            if (!access) continue;
            const read = projectArtifactAdmittedHeader(row, input.actorAccountId);
            if (!read.ok) {
                if (access.level === "owner") throw new Error("Artifact content is unavailable");
                continue;
            }
            const content = input.includeBody && !input.unclassified ? projectArtifactBody(read.artifact, row) : projectArtifactRevisionMetadata(read.artifact, row);
            if (!content.ok) {
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

/** Completeness is an access fact, never a reason to open unrelated private content. */
async function countUnclassifiedArtifactsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; ownerAccountId?: string; audience?: 'received'; coarseOnly: boolean; includeApprovalState?: boolean;
}>): Promise<number> {
    return tx.artifact.count({ where: { ...artifactVisibleWhere, ...artifactUnclassifiedWhere(input.coarseOnly, input.includeApprovalState),
        ...(input.ownerAccountId === undefined ? {} : { accountId: input.ownerAccountId }),
        AND: [artifactCandidateWhere(input.actorAccountId),
            ...(input.audience === 'received' ? [{ accountId: { not: input.actorAccountId } }] : [])],
    } });
}

/** The filtered page and its completeness witness share the canonical stable read snapshot. */
export async function listArtifactHeaderPageForCaller(input: Parameters<typeof listArtifactHeadersForCallerInTx>[1]): Promise<{
    items: ArtifactListItemForCaller[]; hasUnclassified: boolean; coverage: ArtifactKindCoverageV1;
}> {
    if (input.approvalSessionIds?.length === 0) return { items: [], hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } };
    const readCount = async (tx: Tx) => input.kind !== undefined || input.kinds !== undefined || input.browserListed || input.unclassified
        || input.approvalStates !== undefined || input.approvalSessionIds !== undefined || input.audience !== undefined
        ? await countUnclassifiedArtifactsInTx(tx, { ...input, coarseOnly: input.kind !== undefined || input.unclassified === 'coarse',
            includeApprovalState: !input.browserListed }) : 0;
    const capture = async (tx: Tx, currentCount?: number) => {
        const items = await listArtifactHeadersForCallerInTx(tx, input);
        const unclassifiedCount = currentCount ?? await readCount(tx);
        const coverage: ArtifactKindCoverageV1 = unclassifiedCount === 0
            ? { status: 'complete', unclassifiedCount: 0 }
            : { status: 'partial', unclassifiedCount, reason: 'unclassified_legacy_rows' };
        return { items, coverage, hasUnclassified: unclassifiedCount > 0 };
    };
    return await readSnapshotWithCurrentAdmission(capture, async (tx, captured) => {
        const currentCount = await readCount(tx);
        // A count is a current authorization fact, unlike the old conservative
        // boolean witness. Recapture once in this existing final snapshot so a
        // newly classified match cannot become a complete-but-empty old page.
        if (currentCount !== captured.coverage.unclassifiedCount) return capture(tx, currentCount);
        if (captured.items.length === 0) return captured;
        const rows = await tx.artifact.findMany({ where: { id: { in: captured.items.map(row => row.id) }, ...artifactVisibleWhere },
            select: artifactReadAdmissionSelect(input.actorAccountId) });
        const currentById = new Map(rows.map(row => [row.id, projectArtifactAdmittedHeader(row, input.actorAccountId)]));
        return {
            hasUnclassified: captured.hasUnclassified,
            coverage: captured.coverage,
            items: captured.items.flatMap(artifact => {
                const current = currentById.get(artifact.id);
                return current?.ok && artifactContentAdmissionMatches(current.artifact, artifact)
                    ? [{ ...artifact, access: current.artifact.access }] : [];
            }),
        };
    });
}

export async function listArtifactAccessGrants(input: Parameters<typeof listArtifactAccessGrantsInTx>[1]): Promise<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>> {
    return await readSnapshotWithCurrentAdmission<Awaited<ReturnType<typeof listArtifactAccessGrantsInTx>>>(
        tx => listArtifactAccessGrantsInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await resolveArtifactAccessInTx(tx, input);
            if (!current) return { ok: false, error: "artifact_not_found" };
            return { ...captured, value: { ...captured.value, access: current.level } };
        });
}

export async function readArtifactRecipientCensus(input: Parameters<typeof readArtifactRecipientCensusInTx>[1]): Promise<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>> {
    return await readSnapshotWithCurrentAdmission<Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>>>(
        tx => readArtifactRecipientCensusInTx(tx, input), async (tx, captured) => {
            if (!captured.ok) return captured;
            const current = await readArtifactRecipientCensusInTx(tx, input);
            if (!current.ok) return current;
            return isDeepStrictEqual(current.value, captured.value) ? captured : { ok: false, error: "artifact_content_unavailable" };
        });
}

type ArtifactBatchReadItem = Readonly<{
    artifactId: string;
    read: Readonly<{ ok: true; artifact: ArtifactListItemForCaller }> | ArtifactReadFailure;
    census: Awaited<ReturnType<typeof readArtifactRecipientCensusInTx>> | null;
}>;

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
    const accessByArtifact = new Map<string, ArtifactAccess>();
    const audienceByArtifact = new Map<string, string[]>();
    const fullAudienceIds: string[] = [];
    for (const row of rows) {
        const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
        if (!access) continue;
        accessByArtifact.set(row.id, access);
        if (input.projection === 'headers' || access.encryptionMode !== 'e2ee') continue;
        if (mayInspectArtifactAudience(row.kind, access)) fullAudienceIds.push(row.id);
        else audienceByArtifact.set(row.id, [input.actorAccountId]);
    }
    const byId = new Map(rows.map(row => [row.id, row]));
    // Only admitted full-inspection resources collect their complete audience.
    // Batch this phase so reads do not multiply with the selected Artifact count.
    for (const ids of portableQueryChunks({ values: fullAudienceIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const audienceRows = await tx.artifact.findMany({ where: { id: { in: [...ids] }, ...artifactVisibleWhere },
            select: { id: true, ...artifactAccessFactsSelect(), keyEnvelopes: artifactRecipientReadSelect().keyEnvelopes } });
        for (const row of audienceRows) {
            audienceByArtifact.set(row.id, resolveArtifactAudienceFromFacts(row));
            byId.get(row.id)!.keyEnvelopes = row.keyEnvelopes;
        }
    }
    const recipientIds = [...new Set([...audienceByArtifact.values()].flat())].sort();
    const readAccounts = (ids: readonly string[]) => tx.account.findMany({ where: { id: { in: [...ids] } },
        select: RECIPIENT_READINESS_SELECT, orderBy: { id: 'asc' } });
    const accounts: Awaited<ReturnType<typeof readAccounts>> = [];
    for (const ids of portableQueryChunks({ values: recipientIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        accounts.push(...await readAccounts(ids));
    }
    const readPublications = (ids: readonly string[]) => tx.publicSessionShare.findMany({ where: { artifactId: { in: [...ids] } },
        select: { artifactId: true, expiresAt: true } });
    const publications: Awaited<ReturnType<typeof readPublications>> = [];
    if (includeContent) {
        for (const ids of portableQueryChunks({ values: rows.map(row => row.id), bindingsPerValue: 1, fixedBindings: 1 })) {
            publications.push(...await readPublications(ids));
        }
    }
    return { rows, accessByArtifact, audienceByArtifact, accounts, publications };
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

export async function readArtifactBatchForCaller(input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[]; projection?: 'headers';
}>): Promise<ArtifactBatchReadItem[]> {
    return await captureReadSnapshot<ArtifactBatchReadItem[], ArtifactBatchCapture>({
        capture: tx => captureArtifactBatchInTx(tx, input, true),
        materialize: async captured => materializeArtifactBatch(captured, input),
    }, { transactionClass: "artifact-details-read" });
}

type AccessResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ArtifactAccessErrorCodeV1 }>;

/** Kind-owned inspection scope is selected before loading any grant display profile. */
export async function listArtifactAccessGrantsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactId: string;
}>): Promise<AccessResult<ArtifactAccessGrantsListResponseV1>> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: { ...artifactAccessFactsSelect(input.actorAccountId), kind: true } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
    if (!access) return { ok: false, error: "artifact_not_found" };
    const selfAccountId = mayInspectArtifactAudience(row.kind, access) ? undefined : input.actorAccountId;
    const grants = await readArtifactAccessGrantsForAdmittedCustodyInTx(tx, input.artifactId, selfAccountId);
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId, access: access.level,
        grants: selfAccountId === undefined && decodeArtifactKindV1(row.kind).kindHint === 'bot_template.v1'
            ? await projectAdmittedTemplateAcceptedVersionsInTx(tx, input.artifactId, grants) : grants } };
}

/** Owner/admin idempotent grant writes; only the owner may assign admin. */
export async function setArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantSetStorageInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId], {
        intent: "content", additionalGrantPrincipal: input.principal,
    });
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!mayManageResourceGrants(access, input.accessLevel)) return { ok: false, error: "artifact_access_forbidden" };
    const mutation = await readArtifactGrantMutationInTx(tx, input);
    const principal = input.principal;
    const principalError = await validateResourceGrantPrincipalInTx(tx, access.ownerAccountId, principal);
    if (principalError) return { ok: false, error: `artifact_${principalError}` };
    const changed = mutation.previous?.accessLevel !== input.accessLevel;
    if (changed) await mutation.upsert();
    if (changed) {
        await markAccountsChanged(tx, { accountIds: await resolveArtifactAudienceInTx(tx, input.artifactId), kind: "artifact", entityId: input.artifactId });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return listed.ok ? { ok: true, value: { ...listed.value, changed } } : listed;
}

/** Revocation removes unreachable envelopes and reports success without a roster when the caller loses access. */
export async function removeArtifactAccessGrantInTx(tx: Tx, input: ArtifactAccessGrantRemoveInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactAccessGrantMutationResponseV1>> {
    await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId], { intent: "content" });
    const access = await resolveArtifactAccessInTx(tx, input);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!mayManageResourceGrants(access)) return { ok: false, error: "artifact_access_forbidden" };
    const previousAudience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    const principal = input.principal;
    if (principal.kind === "group") {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true } });
        if (!group || group.teamId !== principal.teamId) return { ok: false, error: "artifact_subject_not_found" };
    }
    const deleted = principal.kind === "account"
        ? await tx.artifactAccountGrant.deleteMany({ where: { artifactId: input.artifactId, accountId: principal.accountId } })
        : principal.kind === "team"
            ? await tx.artifactTeamGrant.deleteMany({ where: { artifactId: input.artifactId, teamId: principal.teamId } })
            : await tx.artifactGroupGrant.deleteMany({ where: { artifactId: input.artifactId, teamGroupId: principal.groupId } });
    const audience = await resolveArtifactAudienceInTx(tx, input.artifactId);
    await tx.artifactKeyEnvelope.deleteMany({ where: { artifactId: input.artifactId, recipientAccountId: { notIn: audience } } });
    if (deleted.count > 0) {
        await markAccountsChanged(tx, { accountIds: previousAudience, kind: "artifact", entityId: input.artifactId });
    }
    const listed = await listArtifactAccessGrantsInTx(tx, input);
    return { ok: true, value: listed.ok
        ? { ...listed.value, changed: deleted.count > 0 }
        : { artifactId: input.artifactId, ownerAccountId: access.ownerAccountId,
            access: null, grants: [], changed: deleted.count > 0 } };
}

/** Current audience plus verified binding and envelope state for a key-holding host. */
export async function readArtifactRecipientCensusInTx(tx: Tx, input: Readonly<{ actorAccountId: string; artifactId: string }>): Promise<AccessResult<ArtifactAccessRecipientCensusResponseV1>> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId), select: {
        ...artifactAccessFactsSelect(input.actorAccountId), kind: true, dataEncryptionKey: true, provenanceDataEncryptionKey: true,
    } });
    if (!row) return { ok: false, error: "artifact_not_found" };
    const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
    if (!access) return { ok: false, error: "artifact_not_found" };
    if (!access.encryptionMode) return { ok: false, error: "artifact_content_unavailable" };
    const inspectAudience = mayInspectArtifactAudience(row.kind, access);
    const audience = inspectAudience ? await resolveArtifactAudienceInTx(tx, input.artifactId) : [input.actorAccountId];
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
export async function commitArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: ArtifactRecipientKeyEnvelopeCommitInputV1 & { actorAccountId: string }): Promise<AccessResult<ArtifactRecipientKeyEnvelopeCommitResponseV1>> {
    await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId], { intent: "content" });
    const access = await resolveArtifactAccessInTx(tx, input);
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
    return { ok: true, value: await applyArtifactRecipientKeyEnvelopesInTx(tx, input) };
}

/** Both fenced commits and Account transitions revalidate recipients through this owner. */
export async function applyArtifactRecipientKeyEnvelopesInTx(tx: Tx, input: Readonly<{
    artifactId: string;
    recipientKeyEnvelopes: readonly ArtifactRecipientKeyEnvelopeInputV1[];
}>): Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1> {
    return applyResourceRecipientKeyEnvelopesInTx(tx, artifactRecipientEnvelopeStorageAdapter,
        { resourceId: input.artifactId, recipientKeyEnvelopes: input.recipientKeyEnvelopes });
}

/** Only Artifact persistence/provenance semantics remain in this adapter. */
const artifactRecipientEnvelopeStorageAdapter: ResourceRecipientEnvelopeStorageAdapter<ArtifactRecipientKeyEnvelopeInputV1> = {
    ...artifactGrantStorageAdapter,
    async writeRecipientEnvelopeInTx(tx, artifactId, envelope) {
        const bytes = privacyKit.decodeBase64(envelope.encryptedDataKey);
        const previous = await tx.artifactKeyEnvelope.findUnique({ where: { artifactId_recipientAccountId: {
            artifactId, recipientAccountId: envelope.recipientAccountId } },
            select: { recipientContentPublicKeyFingerprint: true } });
        const data = { encryptedDataKey: bytes, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
            ...(envelope.encryptedProvenanceDataKey === undefined
                ? previous && previous.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint
                    ? { encryptedProvenanceDataKey: null } : {}
                : { encryptedProvenanceDataKey: privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey) }) };
        await tx.artifactKeyEnvelope.upsert({ where: { artifactId_recipientAccountId: {
            artifactId, recipientAccountId: envelope.recipientAccountId } },
            create: { artifactId, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
    },
    async publishRecipientsChangedInTx(tx, artifactId, accountIds) {
        await markAccountsChanged(tx, { accountIds: [...accountIds], kind: 'artifact', entityId: artifactId });
    },
};

export function projectArtifactPublicAudience(publication: Parameters<typeof isPublicSessionShareActive>[0], signedInLinkPresent: boolean): 'retained' | 'none' {
    return signedInLinkPresent || isPublicSessionShareActive(publication) ? 'retained' : 'none';
}

/** Request-private admission carried into the transaction that changes the Artifact. */

function mayInspectArtifactAudience(kind: string | null, access: ArtifactAccess): boolean {
    return access.level === 'owner' || getArtifactGrantInspectionPolicyV1(decodeArtifactKindV1(kind).kindHint) === 'all';
}

/** The sole document access decision: ownership or the highest live grant. */

function artifactRecipientReadSelect(actorAccountId?: string) {
    return { accountId: true, account: { select: { encryptionMode: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } }, ...headerContentSelect,
        signedInLink: { select: { artifactId: true } },
        keyEnvelopes: { ...(actorAccountId === undefined ? {} : { where: { recipientAccountId: actorAccountId } }), select: {
            recipientAccountId: true,
            encryptedDataKey: true, recipientContentPublicKeyFingerprint: true, recipient: { select: RECIPIENT_READINESS_SELECT },
            encryptedProvenanceDataKey: true,
        } } } as const;
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


export async function readArtifactAccessGrantsForAdmittedCustodyInTx(tx: Tx,
    artifactId: string, selfAccountId?: string): Promise<ArtifactAccessGrantsListResponseV1['grants']> {
    const [accounts, teams, groups] = await Promise.all([
        tx.artifactAccountGrant.findMany({ where: { artifactId, ...(selfAccountId === undefined ? {} : { accountId: selfAccountId }) },
            include: { account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } } }),
        selfAccountId === undefined ? tx.artifactTeamGrant.findMany({ where: { artifactId }, include: { team: { select: { name: true } } } }) : [],
        selfAccountId === undefined ? tx.artifactGroupGrant.findMany({ where: { artifactId }, include: { teamGroup: { select: { name: true, teamId: true } } } }) : [],
    ]);
    return [
            ...accounts.map(row => ({ principal: { kind: "account" as const, accountId: row.accountId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: resolveAccountDisplayLabelV1(row.account), username: row.account.username } })),
            ...teams.map(row => ({ principal: { kind: "team" as const, teamId: row.teamId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.team.name } })),
            ...groups.map(row => ({ principal: { kind: "group" as const, teamId: row.teamGroup.teamId, groupId: row.teamGroupId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.teamGroup.name } })),
        ];
}

/** Owner/admin idempotent grant writes; only the owner may assign admin. */

export async function reportArtifactTemplateAcceptedVersionInTx(tx: Tx,
    input: ArtifactTemplateAcceptedVersionInputV1 & { actorAccountId: string },
): Promise<AccessResult<{ changed: boolean }>> {
    const row = await tx.artifact.findFirst({ where: artifactAddress(input.artifactId),
        select: { ...artifactAccessFactsSelect(input.actorAccountId), kind: true } });
    if (!row) return { ok: false, error: 'artifact_not_found' };
    const access = resolveArtifactAccessFromFacts(row, input.actorAccountId);
    if (!access) return { ok: false, error: 'artifact_not_found' };
    if (decodeArtifactKindV1(row.kind).kindHint !== 'bot_template.v1') return { ok: false, error: 'artifact_kind_not_shareable' };
    return { ok: true, value: await writeAdmittedTemplateAcceptedVersionInTx(tx, { ...input, ownerAccountId: access.ownerAccountId }) };
}

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
    if (input.keyEnvelope) await artifactRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, input.artifactId, input.keyEnvelope);
    await markAccountsChanged(tx, { accountIds: [input.authorAccountId, input.actorAccountId], kind: 'artifact', entityId: input.artifactId });
    return { ok: true, value: { artifactId: input.artifactId, ownerAccountId: input.authorAccountId, access: current?.level ?? 'view' } } as const;
}

async function readArtifactGrantMutationInTx(tx: Tx, input: ArtifactAccessGrantSetStorageInputV1 & { actorAccountId: string }) {
    const principal = input.principal;
    const data = { accessLevel: input.accessLevel, createdByAccountId: input.actorAccountId };
    let previous: Readonly<{ accessLevel: string }> | null;
    let upsert: () => Promise<unknown>;
    if (principal.kind === "account") {
        const where = { artifactId_accountId: { artifactId: input.artifactId, accountId: principal.accountId } };
        previous = await tx.artifactAccountGrant.findUnique({ where });
        upsert = () => tx.artifactAccountGrant.upsert({ where, create: { artifactId: input.artifactId, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === "team") {
        const where = { artifactId_teamId: { artifactId: input.artifactId, teamId: principal.teamId } };
        previous = await tx.artifactTeamGrant.findUnique({ where });
        upsert = () => tx.artifactTeamGrant.upsert({ where, create: { artifactId: input.artifactId, teamId: principal.teamId, ...data }, update: data });
    } else {
        const where = { artifactId_teamGroupId: { artifactId: input.artifactId, teamGroupId: principal.groupId } };
        previous = await tx.artifactGroupGrant.findUnique({ where });
        upsert = () => tx.artifactGroupGrant.upsert({ where, create: { artifactId: input.artifactId, teamGroupId: principal.groupId, ...data }, update: data });
    }
    return { previous, upsert };
}
