import { PublicProfileUpdateBodyV1Schema, PublicProfileAppearanceV1Schema, type PublicProfileMutationResultV1, type PublicProfileUpdateBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfileSnapshot, projectPublicProfileMetadata, validatePublicProfileLayout } from '@happier-dev/protocol/account/projectPublicProfile';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { inTx } from '@/storage/inTx';
import { parsePublicProfileRecord, publicProfileUnavailable, publicProfileUpdated, readPublicProfileForMutationInTx, updatePublicProfileInTx } from './publicProfileStorage';
import { preparePublicProfilePicture, completePublicProfilePictureInTx, retirePublicProfilePictureInTx,
    discardPublicProfilePicture, cleanupPublicProfilePicturesAfterCommit } from './publicProfilePicture';
import { log } from '@/utils/logging/log';

/** Commits disclosure edits and any freshly prepared facts together, preserving omitted consent. */
export async function updatePublicProfile(accountId: string, input: PublicProfileUpdateBodyV1): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfileUpdateBodyV1Schema.parse(input);
    const layout = body.layout && validatePublicProfileLayout(body.layout);
    const candidate = body.appearance && await preparePublicProfilePicture({ accountId, atmosphere: body.appearance.atmosphere });
    if (candidate && !candidate.ok) return publicProfileUnavailable('asset_unavailable');
    const prepared = candidate?.ok ? candidate.prepared : undefined;
    try {
        const appearance = prepared && PublicProfileAppearanceV1Schema.parse({ ...body.appearance, atmosphere: prepared.atmosphere });
        return await inTx(async tx => {
            const row = await readPublicProfileForMutationInTx(tx, accountId);
            if (!row || row.state === 'draft') return publicProfileUnavailable('not_published');
            if (row.removedAt) return publicProfileUnavailable('restricted');
            const current = parsePublicProfileRecord(row);
            if (!current?.policy || !current.metadata || !current.query) return publicProfileUnavailable('invalid_stored_content');
            if (prepared) {
                const settled = await completePublicProfilePictureInTx(tx, prepared);
                if (!settled.ok) return publicProfileUnavailable('asset_unavailable');
                if (current.appearance?.atmosphere.source === 'picture') {
                    await retirePublicProfilePictureInTx(tx, accountId, current.appearance.atmosphere.picture.ref.id);
                }
            }
            const policy = body.policy ?? current.policy;
            const metadata = projectPublicProfileMetadata(body.metadata ?? current.metadata, policy);
            const query = body.query ? normalizeUsageQuery(body.query) : current.query;
            const queryChanged = getUsageQueryKey(query) !== getUsageQueryKey(current.query);
            return publicProfileUpdated(await updatePublicProfileInTx(tx, row, {
                policyJson: JSON.stringify(policy), metadataJson: JSON.stringify({ disclosure: metadata,
                    projectSelections: policy.fields.projects ? body.projectSelections ?? current.projectSelections : [] }),
                queryJson: JSON.stringify(query), snapshotJson: body.snapshot ? JSON.stringify(projectPublicProfileSnapshot(body.snapshot, policy))
                    : queryChanged || !current.snapshot ? null : JSON.stringify(projectPublicProfileSnapshot(current.snapshot, policy)),
                ...(layout ? { layoutJson: JSON.stringify(layout) } : {}), ...(appearance ? { appearanceJson: JSON.stringify(appearance) } : {}),
            }));
        }, { isolationLevel: 'ReadCommitted' });
    } finally {
        if (prepared) await discardPublicProfilePicture(prepared).catch(() => {
            log({ module: 'api', level: 'warn', accountId }, 'Public-profile picture candidate cleanup failed');
        });
        await cleanupPublicProfilePicturesAfterCommit(accountId);
    }
}
