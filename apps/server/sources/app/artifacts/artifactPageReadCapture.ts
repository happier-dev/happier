import type { Prisma } from '@prisma/client';
import * as privacyKit from 'privacy-kit';
import { prismaRuntime } from '@/storage/prisma';
import { artifactOrdinarySqlPredicate } from './artifactClassification';
import { projectArtifactPageReadRow, type ArtifactPageReadRow } from './artifactAccessService';
import type { ArtifactSourceReader } from './artifactSourceReaders';

type Envelope = ArtifactPageReadRow['keyEnvelopes'][number];
type CapturedEnvelope = Omit<Envelope, 'encryptedDataKey' | 'encryptedProvenanceDataKey' | 'recipient'> & {
    encryptedDataKey: string;
    encryptedProvenanceDataKey: string | null;
    recipient: Omit<Envelope['recipient'], 'contentPublicKey' | 'contentPublicKeySig'> & {
        contentPublicKey: string | null; contentPublicKeySig: string | null;
    };
};
/** Request-private SQL facts; never a transport DTO or an independent access decision. */
export type ArtifactPageReadCapture = Omit<ArtifactPageReadRow, 'sourceReaderAccounts' | 'header' | 'body'
    | 'dataEncryptionKey' | 'provenance' | 'provenanceDataEncryptionKey' | 'createdAt' | 'updatedAt' | 'keyEnvelopes'
    | 'grants'> & {
    header: string; body: string; dataEncryptionKey: string; provenance: string | null;
    provenanceDataEncryptionKey: string | null; createdAt: string; updatedAt: string;
    keyEnvelopes: CapturedEnvelope[];
    grants: Array<Omit<ArtifactPageReadRow['grants'][number], 'team' | 'teamGroup'> & {
        team: (Omit<NonNullable<ArtifactPageReadRow['grants'][number]['team']>, 'archivedAt'> & { archivedAt: string | null }) | null;
        teamGroup: (Omit<NonNullable<ArtifactPageReadRow['grants'][number]['teamGroup']>, 'archivedAt' | 'team'> & {
            archivedAt: string | null; team: { archivedAt: string | null };
        }) | null;
    }>;
    publication: { expiresAt: number | null } | null;
};

/** Correlate only selected page identities; the existing Artifact evaluator admits captured facts. PostgreSQL only. */
export function artifactPageReadCaptureSql(input: Readonly<{ actorAccountId: string; artifactId: Prisma.Sql }>): Prisma.Sql {
    const sql = prismaRuntime.sql;
    const actor = input.actorAccountId;
    return sql`SELECT jsonb_build_object(
        'id', a."id", 'kind', a."kind", 'accountId', a."accountId",
        'header', encode(a."header", 'base64'), 'body', encode(a."body", 'base64'),
        'dataEncryptionKey', encode(a."dataEncryptionKey", 'base64'),
        'provenance', encode(a."provenance", 'base64'),
        'provenanceDataEncryptionKey', encode(a."provenanceDataEncryptionKey", 'base64'),
        'headerVersion', a."headerVersion", 'bodyVersion', a."bodyVersion", 'seq', a."seq",
        'createdAt', EXTRACT(EPOCH FROM a."createdAt") * 1000, 'updatedAt', EXTRACT(EPOCH FROM a."updatedAt") * 1000,
        'account', jsonb_build_object('id', owner."id", 'encryptionMode', owner."encryptionMode",
            'name', owner."name", 'firstName', owner."firstName", 'lastName', owner."lastName",
            'username', owner."username", 'avatar', owner."avatar"),
        'signedInLink', (SELECT jsonb_build_object('artifactId', link."artifactId") FROM "ArtifactSignedInLink" link WHERE link."artifactId" = a."id"),
        'publication', (SELECT jsonb_build_object('expiresAt', EXTRACT(EPOCH FROM publication."expiresAt") * 1000)
            FROM "PublicSessionShare" publication WHERE publication."artifactId" = a."id"),
        'grants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', g."id", 'principalKind', g."principalKind", 'accountId', g."accountId", 'teamId', g."teamId",
            'teamGroupId', g."teamGroupId", 'accessLevel', g."accessLevel",
            'account', CASE WHEN g."accountId" IS NULL THEN NULL ELSE jsonb_build_object('status', recipient."status") END,
            'team', CASE WHEN g."teamId" IS NULL THEN NULL ELSE jsonb_build_object('archivedAt', t."archivedAt",
                'memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'accountId', m."accountId", 'status', m."status", 'role', m."role",
                    'account', jsonb_build_object('status', member."status")))
                    FROM "TeamMembership" m JOIN "Account" member ON member."id" = m."accountId"
                    WHERE m."teamId" = t."id" AND m."accountId" = ${actor}), '[]'::jsonb)) END,
            'teamGroup', CASE WHEN g."teamGroupId" IS NULL THEN NULL ELSE jsonb_build_object(
                'archivedAt', grp."archivedAt", 'team', jsonb_build_object('archivedAt', gt."archivedAt"),
                'memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object('teamMembership', jsonb_build_object(
                    'accountId', m."accountId", 'status', m."status", 'account', jsonb_build_object('status', member."status"))))
                    FROM "TeamGroupMembership" gm JOIN "TeamMembership" m ON m."id" = gm."teamMembershipId"
                    JOIN "Account" member ON member."id" = m."accountId"
                    WHERE gm."teamGroupId" = grp."id" AND m."accountId" = ${actor}), '[]'::jsonb)) END))
            FROM "ArtifactGrant" g LEFT JOIN "Account" recipient ON recipient."id" = g."accountId"
            LEFT JOIN "Team" t ON t."id" = g."teamId" LEFT JOIN "TeamGroup" grp ON grp."id" = g."teamGroupId"
            LEFT JOIN "Team" gt ON gt."id" = grp."teamId"
            WHERE g."artifactId" = a."id" AND (g."accountId" = ${actor} OR g."teamId" IS NOT NULL OR g."teamGroupId" IS NOT NULL)), '[]'::jsonb),
        'keyEnvelopes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'recipientAccountId', e."recipientAccountId", 'encryptedDataKey', encode(e."encryptedDataKey", 'base64'),
            'encryptedProvenanceDataKey', encode(e."encryptedProvenanceDataKey", 'base64'),
            'recipientContentPublicKeyFingerprint', e."recipientContentPublicKeyFingerprint",
            'recipient', jsonb_build_object('id', recipient."id", 'publicKey', recipient."publicKey", 'encryptionMode', recipient."encryptionMode",
                'contentPublicKey', encode(recipient."contentPublicKey", 'base64'), 'contentPublicKeySig', encode(recipient."contentPublicKeySig", 'base64'))))
            FROM "ArtifactKeyEnvelope" e JOIN "Account" recipient ON recipient."id" = e."recipientAccountId"
            WHERE e."artifactId" = a."id" AND e."recipientAccountId" = ${actor}), '[]'::jsonb)
        ) AS capture
        FROM "Artifact" a JOIN "Account" owner ON owner."id" = a."accountId"
        WHERE a."id" = ${input.artifactId} AND a."deletedAt" IS NULL
            AND ${prismaRuntime.raw(artifactOrdinarySqlPredicate(false))}`;
}

/** Decode the storage projection, then reuse the ordinary access, Account-mode and envelope owners. */
export function materializeArtifactPageRead(capture: ArtifactPageReadCapture | null,
    input: Readonly<{ actorAccountId: string; sourceReaderAccounts: readonly ArtifactSourceReader[] }>) {
    if (!capture) return { ok: false as const, error: 'artifact_not_found' as const };
    const bytes = (value: string) => privacyKit.decodeBase64(value.replaceAll('\n', ''));
    const nullableBytes = (value: string | null) => value === null ? null : bytes(value);
    const nullableDate = (value: string | null) => value === null ? null : new Date(value);
    const row: ArtifactPageReadRow = { ...capture,
        header: bytes(capture.header), body: bytes(capture.body), dataEncryptionKey: bytes(capture.dataEncryptionKey),
        provenance: nullableBytes(capture.provenance), provenanceDataEncryptionKey: nullableBytes(capture.provenanceDataEncryptionKey),
        createdAt: new Date(capture.createdAt), updatedAt: new Date(capture.updatedAt),
        sourceReaderAccounts: input.sourceReaderAccounts,
        grants: capture.grants.map(grant => ({ ...grant,
            team: grant.team ? { ...grant.team, archivedAt: nullableDate(grant.team.archivedAt) } : null,
            teamGroup: grant.teamGroup ? { ...grant.teamGroup, archivedAt: nullableDate(grant.teamGroup.archivedAt),
                team: { archivedAt: nullableDate(grant.teamGroup.team.archivedAt) } } : null,
        })),
        keyEnvelopes: capture.keyEnvelopes.map(envelope => ({ ...envelope,
            encryptedDataKey: bytes(envelope.encryptedDataKey), encryptedProvenanceDataKey: nullableBytes(envelope.encryptedProvenanceDataKey),
            recipient: { ...envelope.recipient, contentPublicKey: nullableBytes(envelope.recipient.contentPublicKey),
                contentPublicKeySig: nullableBytes(envelope.recipient.contentPublicKeySig) },
        })),
    };
    return projectArtifactPageReadRow(row, input.actorAccountId,
        capture.publication ? { expiresAt: capture.publication.expiresAt === null ? null : new Date(capture.publication.expiresAt) } : null);
}
