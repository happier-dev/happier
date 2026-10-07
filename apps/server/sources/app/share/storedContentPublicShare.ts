import { db } from "@/storage/db";
import { assertSessionCapabilityInTx, resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { eventRouter, buildPublicShareCreatedUpdate, buildPublicShareUpdatedUpdate, buildPublicShareDeletedUpdate, } from "@/app/events/eventRouter";
import { createHash, timingSafeEqual, randomUUID } from "crypto";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { resolveStoredContentPublicShareSubjectOrigin } from "./storedContentPublicShareOrigin";
import { createLocalServicePublicRateLimitChecker } from "@/app/local/services/public/rateLimits";
import { readLocalServicesFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { artifactVisibleWhere } from "@/app/artifacts/artifactClassification";
import { openArtifactStoredContentPair } from "@/app/artifacts/artifactStoredContent";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { tryParseEncryptedDataKeyV0 } from "@/app/api/routes/share/encryptedDataKeyValidation";
import { resolvePublicShareUseLimit } from "@/app/api/routes/share/publicShareMessageAccessGrant";
import { isSessionTranscriptShareable, SESSION_TRANSCRIPT_PUBLICATION_SELECT, } from "@/app/session/sessionTranscriptPublicationPolicy";
import { isSessionMetadataPrivacyUpgradeRequiredError, projectSessionMetadataForRecipient, readSessionMetadataOwnerAccountMode, } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { decodePlainArtifactStoredContent, getArtifactKindPolicyV1, SESSION_METADATA_LAYOUT_VERSION_V1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import { enforceSessionPublicLinkExternalSharingPolicyInTx } from "@/app/session/access/sessionAccessExternalSharingPolicy";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";
import { removeUnsafeSessionFollowEdgesForAccessChangeInTx } from "@/app/session/follow/sessionFollowEdgeService";
import { removeUnsafeSessionReportsToEdgesForAccessChangeInTx } from "@/app/session/relations/sessionReportsToService";
function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
    if (left === null || right === null)
        return left === right;
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function equalDates(left: Date | null, right: Date | null): boolean {
    if (left === null || right === null)
        return left === right;
    return left.getTime() === right.getTime();
}
function publicShareMaterialRotates(existing: ShareRow | null, hash: Uint8Array | null, keyDerivation: string): boolean {
    return hash !== null && (!existing || !equalBytes(hash, existing.tokenHash) || existing.keyDerivation !== keyDerivation);
}
export async function deleteSessionPublicShare(input: Pick<SessionPublicShareWrite, "userId" | "sessionId" | "authentication">) {
    const { userId, sessionId, authentication } = input;
    // Only owner can delete public share
    const admission = await resolveSessionAccessForOperation(db, {
        accountId: userId,
        sessionId,
        authentication,
        capability: "managePublicLink",
    });
    if (admission.status !== "allowed" || !admission.access.capabilities.managePublicLink) {
        return { type: 'forbidden' as const };
    }
    const result = await inTx(async (tx) => {
        const authority = await assertSessionCapabilityInTx({ tx, accountId: userId, sessionId, capability: "managePublicLink", authentication });
        if (!authority.ok)
            return { type: "forbidden" as const };
        const existing = await tx.publicSessionShare.findUnique({
            where: { sessionId }
        });
        if (!existing) {
            return { type: "not-found" as const };
        }
        await tx.publicSessionShare.delete({
            where: { sessionId }
        });
        const shareCursor = await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
        const sessionCursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: sessionId });
        const cursor = Math.max(shareCursor, sessionCursor);
        afterTx(tx, () => {
            const updatePayload = buildPublicShareDeletedUpdate(sessionId, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        });
        return { type: "ok" as const };
    });
    return result;
}
export type SessionPublicShareWrite = Readonly<{
    userId: string;
    sessionId: string;
    authentication: Parameters<typeof assertSessionCapabilityInTx>[0]["authentication"];
    lookupId?: string;
    keyDerivation?: "fragment_v1";
    encryptedDataKey?: string;
    expiresAt?: number;
    maxUses?: number;
    isConsentRequired?: boolean;
}>;
export async function writeSessionPublicShare(input: SessionPublicShareWrite) {
    const { userId, sessionId, authentication, encryptedDataKey, expiresAt, maxUses, isConsentRequired } = input;
    const token = input.lookupId;
    // Only owner can create public shares
    const admission = await resolveSessionAccessForOperation(db, {
        accountId: userId,
        sessionId,
        authentication,
        capability: "managePublicLink",
    });
    if (admission.status !== "allowed" || !admission.access.capabilities.managePublicLink) {
        return { type: 'forbidden' as const };
    }
    const result = await inTx(async (tx) => {
        const authority = await assertSessionCapabilityInTx({ tx, accountId: userId, sessionId, capability: "managePublicLink", authentication });
        if (!authority.ok)
            return { type: "forbidden" as const };
        const session = await tx.session.findUnique({
            where: { id: sessionId },
            select: {
                encryptionMode: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
                primaryTeamId: true,
                ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            },
        });
        if (!session) {
            return { type: 'error' as const, error: 'session not found' as const };
        }
        if (!isSessionTranscriptShareable(session)) {
            return {
                type: 'publication-error' as const,
                error: "Session transcript is not shareable" as const,
                code: "session_transcript_not_shareable" as const,
            };
        }
        try {
            const ownerAccountMode = session.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
                ? await readSessionMetadataOwnerAccountMode(tx, session.accountId)
                : undefined;
            projectSessionMetadataForRecipient({
                session,
                recipient: {
                    type: "shared",
                    accountId: null,
                    ownerAccountMode,
                },
            });
        }
        catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return { type: "privacy-error" as const };
            }
            throw error;
        }
        if (session.encryptionMode !== "plain" && session.encryptionMode !== "e2ee") return { type: "error" as const, error: "session_content_encryption_mismatch" as const };
        const sessionEncryptionMode = session.encryptionMode;
        const existing = await tx.publicSessionShare.findUnique({
            where: { sessionId }
        });
        const nextExpiresAt = expiresAt === undefined ? null : new Date(expiresAt);
        const suppliedTokenHash = typeof token === 'string' && token.length > 0
            ? createHash('sha256').update(token, 'utf8').digest()
            : null;
        const nextKeyDerivation = input.lookupId ? "fragment_v1" : existing?.keyDerivation ?? "fragment_v1";
        const shouldRotateToken = publicShareMaterialRotates(existing, suppliedTokenHash, nextKeyDerivation);
        const externalPolicyError = await enforceSessionPublicLinkExternalSharingPolicyInTx(tx, {
            actorAccountId: userId,
            primaryTeamId: session.primaryTeamId,
            previous: existing,
            next: {
                expiresAt: nextExpiresAt,
                maxUses: maxUses ?? null,
                rotatesToken: shouldRotateToken,
            },
            authentication,
        });
        if (externalPolicyError) {
            return { type: "external-sharing-error" as const, error: externalPolicyError };
        }
        const written = await persistStoredContentPublicShare(tx, {
            subject: { kind: "session", id: sessionId }, userId, existing,
            mode: sessionEncryptionMode, material: token,
            keyDerivation: nextKeyDerivation,
            encryptedDataKey, expiresAt, maxUses, isConsentRequired,
        });
        if (written.type !== "ok")
            return written;
        const { publicShare, changed } = written;
        const isUpdate = !!existing;
        if (!changed) {
            return { type: 'ok' as const, publicShare };
        }
        if (isPublicSessionShareActive(publicShare)) {
            await removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx, { sessionId });
            await removeUnsafeSessionReportsToEdgesForAccessChangeInTx(tx, { sessionId });
        }
        const shareCursor = await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
        const sessionCursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: sessionId });
        const cursor = Math.max(shareCursor, sessionCursor);
        afterTx(tx, () => {
            const updatePayload = isUpdate
                ? buildPublicShareUpdatedUpdate({ ...publicShare, sessionId }, cursor, randomKeyNaked(12))
                : buildPublicShareCreatedUpdate({ ...publicShare, sessionId, token: token! }, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        });
        return { type: 'ok' as const, publicShare };
    });
    return result;
}
type ShareRow = NonNullable<Awaited<ReturnType<typeof db.publicSessionShare.findUnique>>>;
export type StoredContentPublicShareSubject = Readonly<{
    kind: "session" | "artifact";
    id: string;
}>;
export function projectStoredContentPublicShare(row: ShareRow) {
    return { id: row.id, subject: row.sessionId ? { kind: "session" as const, id: row.sessionId } : { kind: "artifact" as const, id: row.artifactId! },
        expiresAt: row.expiresAt?.getTime() ?? null, maxUses: row.maxUses, useCount: row.useCount,
        isConsentRequired: row.isConsentRequired, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
        keyDerivation: row.keyDerivation };
}
async function persistStoredContentPublicShare(tx: Tx, input: Readonly<{
    subject: StoredContentPublicShareSubject;
    userId: string;
    existing: ShareRow | null;
    mode: "plain" | "e2ee";
    material?: string;
    keyDerivation: string;
    encryptedDataKey?: string;
    expiresAt?: number;
    maxUses?: number;
    isConsentRequired?: boolean;
}>) {
    const { existing } = input;
    const id = existing?.id ?? randomUUID();
    const hash = input.material ? createHash("sha256").update(input.material, "utf8").digest() : null;
    const rotates = publicShareMaterialRotates(existing, hash, input.keyDerivation);
    if (!existing && !hash)
        return { type: "error" as const, error: "lookupId required" as const };
    if ((!existing || rotates) && input.keyDerivation !== "fragment_v1")
        return { type: "error" as const, error: "lookupId required" as const };
    if (input.keyDerivation === "fragment_v1" && (!resolveStoredContentPublicShareSubjectOrigin({ id, artifactId: input.subject.kind === 'artifact' ? input.subject.id : null })
        || !createLocalServicePublicRateLimitChecker(readLocalServicesFeatureEnv(process.env).publicRateLimitDependency)))
        return { type: "error" as const, error: "public_share_isolation_unavailable" as const };
    if (input.mode === "e2ee" && ((!existing || rotates) && !input.encryptedDataKey)) {
        return { type: "error" as const, error: "encryptedDataKey required" as const };
    }
    let encryptedDataKey = input.mode === "plain" ? null : existing?.encryptedDataKey ?? null;
    if (input.mode === "e2ee" && input.encryptedDataKey !== undefined) {
        const parsed = tryParseEncryptedDataKeyV0(input.encryptedDataKey);
        if (parsed.type === "error")
            return parsed;
        encryptedDataKey = parsed.encryptedDataKey;
    }
    if (input.mode === "e2ee" && encryptedDataKey === null)
        return { type: "error" as const, error: "encryptedDataKey required" as const };
    if (input.mode === "e2ee" && existing && input.keyDerivation !== "fragment_v1" && !equalBytes(encryptedDataKey, existing.encryptedDataKey))
        return { type: "error" as const, error: "lookupId required" as const };
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
    const maxUses = input.maxUses ?? null;
    const isConsentRequired = input.isConsentRequired ?? false;
    const changed = !existing || rotates || !equalBytes(encryptedDataKey, existing.encryptedDataKey)
        || !equalDates(expiresAt, existing.expiresAt) || maxUses !== existing.maxUses || isConsentRequired !== existing.isConsentRequired;
    if (!changed && existing)
        return { type: "ok" as const, publicShare: existing, changed: false };
    const data = { encryptedDataKey, expiresAt, maxUses, isConsentRequired, keyDerivation: input.keyDerivation,
        ...(rotates ? { tokenHash: hash!, useCount: 0 } : {}) };
    const publicShare = existing ? await tx.publicSessionShare.update({ where: { id }, data })
        : await tx.publicSessionShare.create({ data: { ...data, id, createdByUserId: input.userId, tokenHash: hash!,
                ...(input.subject.kind === "session" ? { sessionId: input.subject.id } : { artifactId: input.subject.id }) } });
    return { type: "ok" as const, publicShare, changed: true };
}
const publicRateLimiters = new WeakMap<NodeJS.ProcessEnv, {
    configuration: string;
    checker: ReturnType<typeof createLocalServicePublicRateLimitChecker>;
}>();
function storedContentPublicRateLimiter(env: NodeJS.ProcessEnv) {
    const dependency = readLocalServicesFeatureEnv(env).publicRateLimitDependency;
    const configuration = JSON.stringify(dependency);
    const previous = publicRateLimiters.get(env);
    if (previous?.configuration === configuration)
        return previous.checker;
    const checker = createLocalServicePublicRateLimitChecker(dependency);
    publicRateLimiters.set(env, { configuration, checker });
    return checker;
}
export function checkStoredContentPublicShareRateLimit(shareId: string, clientKey: string, env: NodeJS.ProcessEnv = process.env): "allowed" | "limited" | "unavailable" {
    const checker = storedContentPublicRateLimiter(env);
    if (!checker)
        return "unavailable";
    return checker({ exposure: { exposureId: shareId, rateLimitProfileId: "stored-content" }, clientKey, nowMs: Date.now() }) ? "allowed" : "limited";
}
export async function resolveStoredContentPublicShareShell(lookupId: string, hostname: string, env: NodeJS.ProcessEnv, clientKey: string) {
    const row = await db.publicSessionShare.findUnique({ where: { tokenHash: createHash("sha256").update(lookupId, "utf8").digest() } });
    if (!row || row.keyDerivation !== "fragment_v1" || !isPublicSessionShareActive(row))
        return null;
    if (row.artifactId && !await db.artifact.findFirst({ where: { id: row.artifactId, ...artifactVisibleWhere }, select: { id: true } }))
        return null;
    const useLimit = resolvePublicShareUseLimit(row.maxUses);
    if (useLimit.type === "invalid" || (useLimit.type === "capped" && row.useCount >= useLimit.maxUses)) return null;
    const origin = resolveStoredContentPublicShareSubjectOrigin(row, env);
    if (!origin || new URL(origin).hostname !== hostname)
        return null;
    const admission = checkStoredContentPublicShareRateLimit(row.id, clientKey, env);
    if (admission === "unavailable")
        return null;
    if (admission === "limited")
        return { error: "rate_limited" as const };
    return { origin, shareId: row.id };
}
export async function writeArtifactPublicShare(input: Omit<SessionPublicShareWrite, "sessionId"> & {
    artifactId: string;
}) {
    return inTx(async (tx) => {
        const artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, accountId: input.userId, ...artifactVisibleWhere }, include: { account: { select: { encryptionMode: true } } } });
        if (!artifact)
            return { type: "forbidden" as const };
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(artifact.account);
        if (mode.status !== "ready") {
            return { type: "error" as const, error: "account_content_encryption_mismatch" as const };
        }
        const opened = openArtifactStoredContentPair({ ...artifact, artifactId: artifact.id, mode: mode.mode });
        if (!opened) {
            return { type: "error" as const, error: "account_content_encryption_mismatch" as const };
        }
        // Only Plain Account headers are server-readable, including sealed-at-rest storage.
        // E2EE admission belongs to the clients that can open the header.
        if (mode.mode === "plain") {
            const header = decodePlainArtifactStoredContent(privacyKit.encodeBase64(opened.header));
            const kind = header && typeof header === "object" && !Array.isArray(header) && "kind" in header
                ? header.kind : undefined;
            if (!getArtifactKindPolicyV1(kind).publicLinkAllowed) {
                return { type: "error" as const, error: "artifact_kind_not_shareable" as const };
            }
        }
        const existing = await tx.publicSessionShare.findUnique({ where: { artifactId: artifact.id } });
        const result = await persistStoredContentPublicShare(tx, { ...input, subject: { kind: "artifact", id: artifact.id }, mode: mode.mode,
            existing, material: input.lookupId, keyDerivation: "fragment_v1" });
        if (result.type === "ok" && result.changed)
            await markAccountChanged(tx, { accountId: input.userId, kind: "artifact", entityId: artifact.id });
        return result;
    });
}
