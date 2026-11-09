import { z } from 'zod/mini';
import { PublicProfileOwnerRecordV1Schema, PublicProfilePublishBodyV1Schema, PublicProfileAppearanceV1Schema, type PublicProfileAppearanceV1, type PublicProfileContextV1, type PublicProfileMutationResultV1, type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePolicyV1Schema, PublicProfileSnapshotV1Schema, PublicProfileMetadataV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { PublicProfileLayoutV1Schema } from '@happier-dev/protocol/widgets/widgetPublicSnapshotV1';
import { UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/db';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

export interface PublicProfileServerDependencies {
    readPublicationContext(tx: Tx, accountId: string, env: NodeJS.ProcessEnv): Promise<PublicProfileContextV1>;
    resolvePrerequisite(env: NodeJS.ProcessEnv): 'report_contact_unconfigured' | 'public_ingress_unconfigured' | null;
}

type ProfileRow = NonNullable<Awaited<ReturnType<Tx['accountPublicProfile']['findUnique']>>>;

/** Ordinary publication mutations admit the row without locking unrelated Account facts. */
export async function readPublicProfileForMutationInTx(tx: Tx, accountId: string): Promise<ProfileRow | null> {
    return tx.accountPublicProfile.findUnique({ where: { accountId } });
}

/** The observed payload is the write predicate, so replay re-admits concurrent consent and lifecycle edits. */
function publicProfileMutationWhere(row: ProfileRow) {
    return { accountId: row.accountId, state: row.state, removedAt: row.removedAt,
        policyJson: row.policyJson, metadataJson: row.metadataJson, queryJson: row.queryJson,
        snapshotJson: row.snapshotJson, layoutJson: row.layoutJson, appearanceJson: row.appearanceJson,
        publishedAt: row.publishedAt };
}

async function admitExactPublicProfileWriteInTx(tx: Tx, row: ProfileRow): Promise<void> {
    if (getDbProviderFromEnv(process.env, 'postgres') !== 'mysql') return;
    // MySQL's retained utf8mb4_unicode_ci columns equate case/accent changes.
    // Lock only an exact payload match until the ORM update/delete completes.
    const matches = await tx.$queryRaw<Array<{ accountId: string }>>`
        SELECT accountId FROM AccountPublicProfile WHERE accountId = ${row.accountId}
        AND CAST(policyJson AS BINARY) <=> CAST(${row.policyJson} AS BINARY)
        AND CAST(metadataJson AS BINARY) <=> CAST(${row.metadataJson} AS BINARY)
        AND CAST(queryJson AS BINARY) <=> CAST(${row.queryJson} AS BINARY)
        AND CAST(snapshotJson AS BINARY) <=> CAST(${row.snapshotJson} AS BINARY)
        AND CAST(layoutJson AS BINARY) <=> CAST(${row.layoutJson} AS BINARY)
        AND CAST(appearanceJson AS BINARY) <=> CAST(${row.appearanceJson} AS BINARY)
        FOR UPDATE
    `;
    if (matches.length !== 1) throw new TransactionReplayRequiredError('public-profile-changed');
}

/** Every committed disclosure change shares the Account's durable feed and post-commit wake. */
async function publishPublicProfileChangeInTx(tx: Tx, accountId: string): Promise<void> {
    await markAccountChanged(tx, { accountId, kind: 'account', entityId: 'public-profile' });
}

export async function createPublicProfileInTx(tx: Tx,
    data: NonNullable<Parameters<Tx['accountPublicProfile']['create']>[0]>['data']): Promise<ProfileRow> {
    const row = await tx.accountPublicProfile.create({ data });
    await publishPublicProfileChangeInTx(tx, row.accountId);
    return row;
}

export async function updatePublicProfileInTx(tx: Tx, row: ProfileRow,
    data: NonNullable<Parameters<Tx['accountPublicProfile']['updateMany']>[0]>['data']): Promise<ProfileRow> {
    if (Object.entries(data).every(([key, value]) => {
        const current = row[key as keyof ProfileRow];
        return current instanceof Date && value instanceof Date ? current.getTime() === value.getTime() : current === value;
    })) return row;
    await admitExactPublicProfileWriteInTx(tx, row);
    const result = await tx.accountPublicProfile.updateMany({ where: publicProfileMutationWhere(row), data });
    if (result.count !== 1) throw new TransactionReplayRequiredError('public-profile-changed');
    await publishPublicProfileChangeInTx(tx, row.accountId);
    return tx.accountPublicProfile.findUniqueOrThrow({ where: { accountId: row.accountId } });
}

export async function deletePublicProfileInTx(tx: Tx, row: ProfileRow): Promise<void> {
    await admitExactPublicProfileWriteInTx(tx, row);
    const result = await tx.accountPublicProfile.deleteMany({ where: publicProfileMutationWhere(row) });
    if (result.count !== 1) throw new TransactionReplayRequiredError('public-profile-changed');
    await publishPublicProfileChangeInTx(tx, row.accountId);
}

const storedMetadataSchema = z.strictObject({ disclosure: PublicProfileMetadataV1Schema,
    projectSelections: PublicProfilePublishBodyV1Schema.shape.projectSelections });

function parseStored<T>(schema: z.core.$ZodType<T>, raw: string | null): T | null {
    if (raw === null) return null;
    try { return z.parse(createStoredReadSchema(schema), JSON.parse(raw)); } catch { return null; }
}

export function readStoredPublicProfileAppearance(raw: string | null): PublicProfileAppearanceV1 | null {
    return parseStored(PublicProfileAppearanceV1Schema, raw);
}

/** A malformed known authority or payload never becomes a published record. */
export function parsePublicProfileRecord(row: ProfileRow): PublicProfileOwnerRecordV1 | null {
    const metadata = parseStored(storedMetadataSchema, row.metadataJson);
    const record = { state: row.state, policy: parseStored(PublicProfilePolicyV1Schema, row.policyJson),
        metadata: metadata?.disclosure ?? null, projectSelections: metadata?.projectSelections ?? [],
        query: parseStored(UsageQuerySchema, row.queryJson), snapshot: parseStored(PublicProfileSnapshotV1Schema, row.snapshotJson),
        layout: parseStored(PublicProfileLayoutV1Schema, row.layoutJson), appearance: readStoredPublicProfileAppearance(row.appearanceJson),
        updatedAtMs: row.updatedAt.getTime(), publishedAtMs: row.publishedAt?.getTime() ?? null,
        restriction: row.removedAt ? { removedAtMs: row.removedAt.getTime(), reason: row.removalReason ?? '' } : null };
    const payloads: readonly (readonly [string | null, unknown])[] = [[row.policyJson, record.policy], [row.metadataJson, metadata],
        [row.queryJson, record.query], [row.snapshotJson, record.snapshot], [row.layoutJson, record.layout], [row.appearanceJson, record.appearance]];
    if (payloads.some(([raw, value]) => raw !== null && value === null)) return null;
    const result = PublicProfileOwnerRecordV1Schema.safeParse(record);
    return result.success ? result.data : null;
}

export function publicProfileUnavailable(reason: Extract<PublicProfileMutationResultV1, { kind: 'unavailable' }>['reason']): PublicProfileMutationResultV1 {
    return { kind: 'unavailable', reason };
}
export function publicProfileUpdated(row: ProfileRow): PublicProfileMutationResultV1 {
    const record = parsePublicProfileRecord(row);
    return record ? { kind: 'updated', record } : publicProfileUnavailable('invalid_stored_content');
}
