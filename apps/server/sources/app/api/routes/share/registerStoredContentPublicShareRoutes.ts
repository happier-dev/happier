import { type Fastify } from "../../types";
import { z } from "zod";
import { StoredContentPublicShareCreateRequestV1Schema } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createHash } from "node:crypto";
import { writeSessionPublicShare, writeArtifactPublicShare, deleteSessionPublicShare, projectStoredContentPublicShare, checkStoredContentPublicShareRateLimit } from "@/app/share/storedContentPublicShare";
import { resolveStoredContentPublicShareSubjectOrigin } from "@/app/share/storedContentPublicShareOrigin";
import { assertSessionCapabilityInTx } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { readAccountStoredContentCompatibilityForHttpRequest, enforceCurrentAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { createSessionMetadataPrivacyUpgradeRequiredResponse, projectSessionMetadataForRecipient, readSessionMetadataOwnerAccountMode, isSessionMetadataPrivacyUpgradeRequiredError } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { artifactVisibleWhere } from "@/app/artifacts/artifactClassification";
import { openArtifactStoredContentPair } from "@/app/artifacts/artifactStoredContent";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { isPublicSessionShareActive } from "@/app/share/publicSessionSharePublication";
import { logPublicShareAccess, getUserAgent } from "@/app/share/accessLogger";
import { consumePublicShareUse, publicShareMessagesMatchSessionMode } from "./registerPublicShareReadRoutes";
import { tryParseEncryptedDataKeyV0Bytes } from "./encryptedDataKeyValidation";
import { buildShareableSessionMessagePublicationWhere, isSessionTranscriptShareable, SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { createPublicShareMessagesAccessToken, validatePublicShareMessagesAccessToken, requirePublicShareAccessGrantSecret, PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER } from "./publicShareMessageAccessGrant";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readArtifactBlob } from '@/app/artifacts/artifactBlobService';

const subjectQuery = z.object({ subjectKind: z.enum(["session", "artifact"]), subjectId: z.string().min(1) });
const shareParams = z.object({ shareId: z.string().min(1) });
type Authentication = ReturnType<typeof readSessionAccessAuthenticationFromRequest>;

async function canManageSubject(tx: Tx, subject: { kind: "session" | "artifact"; id: string }, userId: string, authentication: Authentication) {
    if (subject.kind === "session") {
        const access = await assertSessionCapabilityInTx({ tx, accountId: userId, sessionId: subject.id, capability: "managePublicLink", authentication });
        return access.ok;
    }
    return !!await tx.artifact.findFirst({ where: { id: subject.id, accountId: userId, ...artifactVisibleWhere }, select: { id: true } });
}

export function registerStoredContentPublicShareRoutes(app: Fastify): void {
    app.post("/v1/public-shares", { preHandler: app.authenticate, schema: { body: StoredContentPublicShareCreateRequestV1Schema } }, async (request, reply) => {
        const { subject, ...material } = request.body;
        const input = { ...material, encryptedDataKey: material.encryptedDataKey ?? undefined, userId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request) };
        const result = subject.kind === "session"
            ? await writeSessionPublicShare({ ...input, sessionId: subject.id, supportsCurrentProtocol: readAccountStoredContentCompatibilityForHttpRequest(request).supportsCurrentProtocol })
            : await writeArtifactPublicShare({ ...input, artifactId: subject.id });
        if (result.type === "forbidden") return reply.code(403).send({ error: "public_share_forbidden" });
        if (result.type === "client-upgrade-required") { await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(request, reply); return; }
        if (result.type === "privacy-error") return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
        if (result.type === "publication-error") return reply.code(409).send({ error: result.error, code: result.code });
        if (result.type === "external-sharing-error") return reply.code(result.error === "session_access_authentication_unavailable" ? 503 : 403).send({ error: result.error });
        if (result.type === "error") return reply.code(result.error === "public_share_isolation_unavailable" ? 503 : 400).send({ error: result.error });
        return reply.send({ publicShare: projectStoredContentPublicShare(result.publicShare), isolatedOrigin: resolveStoredContentPublicShareSubjectOrigin(result.publicShare)! });
    });
    app.get("/v1/public-shares", { preHandler: app.authenticate, schema: { querystring: subjectQuery } }, async (request, reply) => {
        const subject = { kind: request.query.subjectKind, id: request.query.subjectId };
        const result = await inTx(async tx => {
            if (!await canManageSubject(tx, subject, request.userId, readSessionAccessAuthenticationFromRequest(request))) return null;
            return tx.publicSessionShare.findMany({ where: subject.kind === "session" ? { sessionId: subject.id } : { artifactId: subject.id } });
        });
        return result === null ? reply.code(403).send({ error: "public_share_forbidden" }) : reply.send({ publicShares: result.map(projectStoredContentPublicShare) });
    });
    app.get("/v1/public-shares/:shareId/access-log", { preHandler: app.authenticate, schema: { params: shareParams } }, async (request, reply) => {
        const result = await inTx(async tx => {
            const share = await tx.publicSessionShare.findUnique({ where: { id: request.params.shareId } });
            if (!share) return { type: "missing" as const };
            const subject = projectStoredContentPublicShare(share).subject;
            if (!await canManageSubject(tx, subject, request.userId, readSessionAccessAuthenticationFromRequest(request))) return { type: "forbidden" as const };
            const logs = await tx.publicShareAccessLog.findMany({ where: { publicShareId: share.id }, orderBy: { accessedAt: "desc" }, take: 50 });
            return { type: "ok" as const, accessLog: logs.map(log => ({ id: log.id, accessedAt: log.accessedAt.getTime(), ipAddress: log.ipAddress, userAgent: log.userAgent })) };
        });
        if (result.type !== "ok") return reply.code(result.type === "missing" ? 404 : 403).send({ error: "public_share_unavailable" });
        return reply.send({ accessLog: result.accessLog });
    });
    app.delete("/v1/public-shares/:shareId", { preHandler: app.authenticate, schema: { params: shareParams } }, async (request, reply) => {
        const share = await db.publicSessionShare.findUnique({ where: { id: request.params.shareId } });
        if (!share) return reply.code(404).send({ error: "public_share_unavailable" });
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        if (share.sessionId) {
            const result = await deleteSessionPublicShare({ userId: request.userId, sessionId: share.sessionId, authentication });
            return result.type === "ok" ? reply.send({ success: true }) : reply.code(result.type === "forbidden" ? 403 : 404).send({ error: "public_share_unavailable" });
        }
        const removed = await inTx(async tx => {
            if (!share.artifactId || !await canManageSubject(tx, { kind: "artifact", id: share.artifactId }, request.userId, authentication)) return false;
            const result = await tx.publicSessionShare.deleteMany({ where: { id: share.id, artifactId: share.artifactId } });
            if (result.count) await markAccountChanged(tx, { accountId: request.userId, kind: "artifact", entityId: share.artifactId });
            return result.count === 1;
        });
        return removed ? reply.send({ success: true }) : reply.code(403).send({ error: "public_share_forbidden" });
    });
    app.get("/v1/public-shares/:lookupId/content", { schema: { params: z.object({ lookupId: z.string().min(1) }), querystring: z.object({
        consent: z.enum(["true", "false"]).optional(), beforeSeq: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(500).default(150),
    }) } }, async (request, reply) => {
        // This isolated endpoint never treats application credentials as public capabilities.
        if (request.headers.authorization || request.headers.cookie) return reply.code(403).send({ error: "public_share_credentials_forbidden" });
        const hash = createHash("sha256").update(request.params.lookupId, "utf8").digest();
        const result = await inTx(async tx => {
            const share = await tx.publicSessionShare.findUnique({ where: { tokenHash: hash } });
            const origin = share && resolveStoredContentPublicShareSubjectOrigin(share);
            if (!share || share.keyDerivation !== "fragment_v1" || !isPublicSessionShareActive(share) || !origin || new URL(origin).hostname !== request.hostname) return { type: "missing" as const };
            const rateLimit = checkStoredContentPublicShareRateLimit(share.id, request.ip);
            if (rateLimit !== "allowed") return { type: rateLimit };
            if (share.isConsentRequired && request.query.consent !== "true") return { type: "consent" as const };
            let encryptionMode: "plain" | "e2ee";
            let content;
            let messagesAccessToken: string | null = null;
            let pageGrant = false;
            let artifactBlob: { actorAccountId: string; artifactId: string; blobId: string } | null = null;
            if (share.artifactId && !share.sessionId) {
                const artifact = await tx.artifact.findFirst({ where: { id: share.artifactId, accountId: share.createdByUserId, ...artifactVisibleWhere }, include: { account: { select: { encryptionMode: true } } } });
                if (!artifact) return { type: "missing" as const };
                const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(artifact.account);
                if (mode.status !== "ready") return { type: "missing" as const };
                encryptionMode = mode.mode;
                const opened = openArtifactStoredContentPair({ ...artifact, artifactId: artifact.id, mode: encryptionMode });
                if (!opened) return { type: "missing" as const };
                content = { kind: "artifact" as const, header: Buffer.from(opened.header).toString("base64"), body: Buffer.from(opened.body).toString("base64"), headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion };
                if (artifact.currentBlobId) artifactBlob = { actorAccountId: artifact.accountId, artifactId: artifact.id, blobId: artifact.currentBlobId };
            } else if (share.sessionId && !share.artifactId) {
                const session = await tx.session.findUnique({ where: { id: share.sessionId }, select: {
                    encryptionMode: true, metadata: true, metadataVersion: true, metadataLayoutVersion: true, ownerMetadata: true, agentState: true, agentStateVersion: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                } });
                if (!session || !isSessionTranscriptShareable(session) || (session.encryptionMode !== "plain" && session.encryptionMode !== "e2ee")) return { type: "missing" as const };
                encryptionMode = session.encryptionMode;
                let metadata;
                try { metadata = projectSessionMetadataForRecipient({ session, recipient: { type: "shared", accountId: null, ownerAccountMode: session.metadataLayoutVersion === 1 ? await readSessionMetadataOwnerAccountMode(tx, session.accountId) : undefined } }); }
                catch (error) { if (isSessionMetadataPrivacyUpgradeRequiredError(error)) return { type: "privacy-error" as const }; throw error; }
                const grantHeader = request.headers[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER];
                if (request.query.beforeSeq !== undefined) {
                    pageGrant = validatePublicShareMessagesAccessToken({ secret: requirePublicShareAccessGrantSecret(), token: typeof grantHeader === "string" ? grantHeader : undefined, publicShareId: share.id, sessionId: share.sessionId, tokenHashHex: hash.toString("hex") });
                    if (!pageGrant) return { type: "missing" as const };
                }
                messagesAccessToken = createPublicShareMessagesAccessToken({ secret: requirePublicShareAccessGrantSecret(), publicShareId: share.id, sessionId: share.sessionId, tokenHashHex: hash.toString("hex") });
                const rows = await tx.sessionMessage.findMany({ where: buildShareableSessionMessagePublicationWhere({ where: { sessionId: share.sessionId, sidechainId: null, ...(request.query.beforeSeq ? { seq: { lt: request.query.beforeSeq } } : {}) }, publication: session }), orderBy: { seq: "desc" }, take: request.query.limit + 1 });
                const hasMore = rows.length > request.query.limit;
                if (!publicShareMessagesMatchSessionMode(rows.slice(0, request.query.limit), encryptionMode)) return { type: "missing" as const };
                const messages = rows.slice(0, request.query.limit).map(row => ({ id: row.id, seq: row.seq, localId: row.localId, content: row.content, ...(parseSessionMessageRole(row.messageRole) ? { messageRole: parseSessionMessageRole(row.messageRole)! } : {}), createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() }));
                content = { kind: "session" as const, ...metadata, messages, hasMore, nextBeforeSeq: hasMore ? messages.at(-1)!.seq : null };
            } else return { type: "missing" as const };
            if (encryptionMode === "e2ee" ? tryParseEncryptedDataKeyV0Bytes(share.encryptedDataKey).type === "error" : share.encryptedDataKey !== null) return { type: "missing" as const };
            if (!pageGrant) {
                if (!await consumePublicShareUse(tx, share, hash)) return { type: "missing" as const };
                await logPublicShareAccess(share.id, null, share.isConsentRequired ? request.ip : undefined, share.isConsentRequired ? getUserAgent(request.headers) : undefined, tx);
            }
            return { type: "ok" as const, artifactBlob, value: { subject: projectStoredContentPublicShare(share).subject, encryptionMode, encryptedDataKey: share.encryptedDataKey ? Buffer.from(share.encryptedDataKey).toString("base64") : null, keyDerivation: "fragment_v1" as const, isConsentRequired: share.isConsentRequired, messagesAccessToken, content } };
        });
        reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        if (result.type === "consent") return reply.code(403).send({ error: "consent_required", requiresConsent: true });
        if (result.type === "privacy-error") return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
        if (result.type !== "ok") return reply.code(result.type === "limited" ? 429 : result.type === "unavailable" ? 503 : 404).send({ error: "public_share_unavailable" });
        if (result.artifactBlob && result.value.content.kind === 'artifact') {
            try {
                const blob = await readArtifactBlob(result.artifactBlob);
                if (!blob.ok) return reply.code(503).send({ error: 'public_share_unavailable' });
                return reply.send({ ...result.value, content: { ...result.value.content, blob: blob.value } });
            } catch { return reply.code(503).send({ error: 'public_share_unavailable' }); }
        }
        return reply.send(result.value);
    });
}
