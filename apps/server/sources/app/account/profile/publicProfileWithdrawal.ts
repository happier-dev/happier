import { afterTx, type Tx } from '@/storage/inTx';
import { readStoredPublicProfileAppearance, readPublicProfileForMutationInTx, deletePublicProfileInTx, updatePublicProfileInTx, createPublicProfileInTx } from './publicProfileStorage';
import { retirePublicProfilePictureInTx, cleanupPublicProfilePicturesAfterCommit } from './publicProfilePicture';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';

export const EMPTY_PUBLIC_PROFILE_PAYLOAD = { state: 'draft', policyJson: null, metadataJson: null, queryJson: null, snapshotJson: null,
    layoutJson: null, appearanceJson: null, publishedAt: null } as const;

/** Identity changes, unpublish and erasure share payload withdrawal, preserving operator restriction. */
export async function withdrawPublicProfileInTx(tx: Tx, accountId: string): Promise<void> {
    const row = await readPublicProfileForMutationInTx(tx, accountId);
    if (!row) return;
    const appearance = readStoredPublicProfileAppearance(row.appearanceJson);
    if (appearance?.atmosphere.source === 'picture') {
        await retirePublicProfilePictureInTx(tx, accountId, appearance.atmosphere.picture.ref.id);
        afterTx(tx, () => { void cleanupPublicProfilePicturesAfterCommit(accountId); });
    }
    if (row.removedAt) await updatePublicProfileInTx(tx, row, EMPTY_PUBLIC_PROFILE_PAYLOAD);
    else await deletePublicProfileInTx(tx, row);
}

/** Provider recovery transfers restriction only, never the retired Account's disclosure. */
export async function replacePublicProfileForProviderResetInTx(tx: Tx, oldAccountId: string, replacementAccountId: string): Promise<void> {
    await acquireAccountChangePublicationLocksInTx(tx, [oldAccountId, replacementAccountId], { includeSingleAccount: true, intent: 'exclusive' });
    const row = await tx.accountPublicProfile.findUnique({ where: { accountId: oldAccountId } });
    if (row?.removedAt) {
        const replacement = await readPublicProfileForMutationInTx(tx, replacementAccountId);
        const data = { ...EMPTY_PUBLIC_PROFILE_PAYLOAD, removedAt: row.removedAt,
            removedByAccountId: row.removedByAccountId, removalReason: row.removalReason };
        if (replacement) await updatePublicProfileInTx(tx, replacement, data);
        else await createPublicProfileInTx(tx, { accountId: replacementAccountId, ...data });
    }
    await withdrawPublicProfileInTx(tx, oldAccountId);
}
