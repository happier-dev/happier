import type { Tx } from '@/storage/inTx';

type RefusalStorage = Pick<Tx, 'qualifiedConnectedAccountUsageRefusal'>;

type RefusalKey = Readonly<{
    accountId: string;
    qualifiedIdentityDigest: string;
    credentialId: string;
}>;

export type QualifiedConnectedAccountUsageOwnershipRefusal = Readonly<{
    status: 'ownership_unproven';
}>;

/** Remembers only the source admission outcome, never the refused usage identity. */
export async function rememberQualifiedUsageOwnershipRefusal(
    tx: RefusalStorage,
    key: RefusalKey,
): Promise<boolean> {
    const where = { accountId_qualifiedIdentityDigest_credentialId: key };
    const previous = await tx.qualifiedConnectedAccountUsageRefusal.findUnique({
        where,
        select: { reason: true },
    });
    const decision = { reason: 'ownership_unproven', observedAt: new Date() };
    await tx.qualifiedConnectedAccountUsageRefusal.upsert({
        where,
        create: { ...key, ...decision },
        update: decision,
    });
    return previous?.reason !== decision.reason;
}

export async function clearQualifiedUsageOwnershipRefusal(
    tx: RefusalStorage,
    key: RefusalKey,
): Promise<boolean> {
    const cleared = await tx.qualifiedConnectedAccountUsageRefusal.deleteMany({ where: key });
    return cleared.count > 0;
}

/** An admitted source takes precedence; callers consult this only after finding none. */
export async function readQualifiedUsageOwnershipRefusal(
    tx: RefusalStorage,
    key: RefusalKey,
): Promise<QualifiedConnectedAccountUsageOwnershipRefusal | null> {
    const refusal = await tx.qualifiedConnectedAccountUsageRefusal.findUnique({
        where: { accountId_qualifiedIdentityDigest_credentialId: key },
        select: { reason: true },
    });
    return refusal ? { status: 'ownership_unproven' } : null;
}
