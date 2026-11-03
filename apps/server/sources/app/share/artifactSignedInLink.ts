import { createHash } from 'node:crypto';
import type { ArtifactSignedInLink } from '@prisma/client';
import { ArtifactHeaderMetadataV1Schema, type ArtifactSignedInLinkJoinReadV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { getArtifactUseTargetV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { artifactVisibleWhere } from '@/app/artifacts/artifactClassification';
import { acquireArtifactPublicationLocksInTx, joinArtifactSignedInLinkAccessInTx } from '@/app/artifacts/artifactAccessService';
import { openArtifactStoredContentPair } from '@/app/artifacts/artifactStoredContent';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { tryParseEncryptedDataKeyV0, tryParseEncryptedDataKeyV0Bytes } from '@/app/api/routes/share/encryptedDataKeyValidation';

const lookupHash = (lookupId: string) => createHash('sha256').update(lookupId, 'utf8').digest();

/** The management family retains its established response vocabulary without expiry or usage state. */
export function projectArtifactSignedInLink(row: ArtifactSignedInLink) {
    return { id: row.artifactId, subject: { kind: 'artifact' as const, id: row.artifactId }, audience: 'signed_in' as const,
        expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, networkOff: false,
        keyDerivation: 'fragment_v1' as const, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() };
}

/** Owner publication stores only a lookup hash and, for E2EE, the fragment-wrapped content key. */
export async function writeArtifactSignedInLink(input: Readonly<{
    actorAccountId: string; artifactId: string; lookupId: string; encryptedDataKey?: string; preserveExisting?: true;
}>) {
    return inTx(async tx => {
        await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId]);
        const artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, accountId: input.actorAccountId, ...artifactVisibleWhere },
            include: { account: { select: { encryptionMode: true } } } });
        if (!artifact) return { ok: false, error: 'artifact_access_forbidden' } as const;
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(artifact.account);
        if (mode.status !== 'ready') return { ok: false, error: 'account_content_encryption_mismatch' } as const;
        const opened = openArtifactStoredContentPair({ ...artifact, artifactId: artifact.id, mode: mode.mode });
        if (!opened) return { ok: false, error: 'account_content_encryption_mismatch' } as const;
        if (mode.mode === 'plain') {
            const header = ArtifactHeaderMetadataV1Schema.safeParse(decodePlainArtifactStoredContent(Buffer.from(opened.header).toString('base64')));
            const body = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(Buffer.from(opened.body).toString('base64')));
            if (!header.success || !body.success || !getArtifactUseTargetV1({ artifactId: artifact.id,
                header: header.data, body: body.data.body, revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }, 'signed_in').publicLinkAllowed) {
                return { ok: false, error: 'artifact_kind_not_shareable' } as const;
            }
            if (input.encryptedDataKey !== undefined) return { ok: false, error: 'data_key_not_required' } as const;
        }
        const key = input.encryptedDataKey === undefined ? null : tryParseEncryptedDataKeyV0(input.encryptedDataKey);
        if (mode.mode === 'e2ee' && (!key || key.type !== 'ok')) return { ok: false, error: 'invalid_recipient_envelope' } as const;
        if (input.preserveExisting) {
            const current = await tx.artifactSignedInLink.findUnique({ where: { artifactId: artifact.id } });
            if (current) return { ok: true, value: projectArtifactSignedInLink(current), created: false } as const;
        }
        const data = { createdByUserId: input.actorAccountId, tokenHash: lookupHash(input.lookupId),
            encryptedDataKey: key?.type === 'ok' ? key.encryptedDataKey : null };
        const link = await tx.artifactSignedInLink.upsert({ where: { artifactId: artifact.id }, create: { artifactId: artifact.id, ...data }, update: data });
        await markAccountChanged(tx, { accountId: input.actorAccountId, kind: 'artifact', entityId: artifact.id });
        return { ok: true, value: projectArtifactSignedInLink(link), created: true } as const;
    }, { isolationLevel: 'ReadCommitted' });
}

export async function listArtifactSignedInLinks(input: Readonly<{ actorAccountId: string; artifactId: string }>) {
    return inReadSnapshot(async tx => {
        const owner = await tx.artifact.findFirst({ where: { id: input.artifactId, accountId: input.actorAccountId, ...artifactVisibleWhere }, select: { id: true } });
        if (!owner) return null;
        const link = await tx.artifactSignedInLink.findUnique({ where: { artifactId: input.artifactId } });
        return { publicShares: link ? [projectArtifactSignedInLink(link)] : [] };
    });
}

export async function revokeArtifactSignedInLink(input: Readonly<{ actorAccountId: string; artifactId: string }>) {
    return inTx(async tx => {
        await acquireArtifactPublicationLocksInTx(tx, input.artifactId, [input.actorAccountId]);
        const owner = await tx.artifact.findFirst({ where: { id: input.artifactId, accountId: input.actorAccountId, ...artifactVisibleWhere }, select: { id: true } });
        if (!owner) return false;
        const removed = await tx.artifactSignedInLink.deleteMany({ where: { artifactId: input.artifactId } });
        if (removed.count) await markAccountChanged(tx, { accountId: input.actorAccountId, kind: 'artifact', entityId: input.artifactId });
        return true;
    }, { isolationLevel: 'ReadCommitted' });
}

async function readLinkContentInTx(tx: Tx, lookupId: string) {
    const link = await tx.artifactSignedInLink.findUnique({ where: { tokenHash: lookupHash(lookupId), artifact: artifactVisibleWhere }, include: {
        artifact: { include: { account: { select: { encryptionMode: true } } } },
    } });
    if (!link) return null;
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(link.artifact.account);
    if (mode.status !== 'ready') return null;
    const opened = openArtifactStoredContentPair({ ...link.artifact, artifactId: link.artifactId, mode: mode.mode });
    if (!opened || (mode.mode === 'e2ee' ? tryParseEncryptedDataKeyV0Bytes(link.encryptedDataKey).type !== 'ok' : link.encryptedDataKey !== null)) return null;
    return { link, opened, mode: mode.mode };
}

/** Only authenticated callers receive release content and their own key-binding projection. */
export async function prepareArtifactSignedInLinkJoin(input: Readonly<{ actorAccountId: string; lookupId: string }>) {
    return inReadSnapshot(async tx => {
        const current = await readLinkContentInTx(tx, input.lookupId);
        if (!current) return null;
        const recipient = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT });
        if (!recipient) return null;
        const { link, opened, mode } = current;
        const value: ArtifactSignedInLinkJoinReadV1 = { artifactId: link.artifactId, authorAccountId: link.artifact.accountId,
            recipientAccountId: input.actorAccountId, recipientContentKey: projectRecipientContentKey(recipient, deriveAccountRecipientEnvelopeReadinessFromRow(recipient)),
            subject: { kind: 'artifact', id: link.artifactId }, encryptionMode: mode,
            encryptedDataKey: link.encryptedDataKey ? Buffer.from(link.encryptedDataKey).toString('base64') : null,
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
            content: { kind: 'artifact', header: Buffer.from(opened.header).toString('base64'), body: Buffer.from(opened.body).toString('base64'),
                headerVersion: link.artifact.headerVersion, bodyVersion: link.artifact.bodyVersion } };
        return value;
    });
}

/** Commit re-admits the live link at this request boundary; existing grants survive link removal. */
export async function commitArtifactSignedInLinkJoin(input: Readonly<{
    actorAccountId: string; lookupId: string; keyEnvelope?: Parameters<typeof joinArtifactSignedInLinkAccessInTx>[1]['keyEnvelope'];
}>) {
    return inTx(async tx => {
        const addressed = await tx.artifactSignedInLink.findUnique({ where: { tokenHash: lookupHash(input.lookupId) }, select: { artifactId: true } });
        if (!addressed) return { ok: false, error: 'artifact_not_found' } as const;
        await acquireArtifactPublicationLocksInTx(tx, addressed.artifactId, [input.actorAccountId]);
        const current = await tx.artifactSignedInLink.findUnique({ where: { tokenHash: lookupHash(input.lookupId), artifact: artifactVisibleWhere },
            select: { artifactId: true, artifact: { select: { accountId: true, account: { select: { encryptionMode: true } } } } } });
        if (!current) return { ok: false, error: 'artifact_not_found' } as const;
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(current.artifact.account);
        if (mode.status !== 'ready') return { ok: false, error: 'artifact_not_found' } as const;
        return joinArtifactSignedInLinkAccessInTx(tx, { artifactId: current.artifactId, authorAccountId: current.artifact.accountId,
            actorAccountId: input.actorAccountId, encryptionMode: mode.mode, keyEnvelope: input.keyEnvelope });
    }, { isolationLevel: 'ReadCommitted' });
}
