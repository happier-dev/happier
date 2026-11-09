import { PublicProfilePublishBodyV1Schema, PublicProfileRefreshBodyV1Schema, PublicProfileAppearanceV1Schema,
    type PublicProfileMutationResultV1, type PublicProfilePublishBodyV1, type PublicProfileRefreshBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfileSnapshot, projectPublicProfileMetadata, validatePublicProfileLayout } from '@happier-dev/protocol/account/projectPublicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { inTx } from '@/storage/inTx';
import { publicProfileUnavailable, publicProfileUpdated, readStoredPublicProfileAppearance, readPublicProfileForMutationInTx, updatePublicProfileInTx, createPublicProfileInTx, type PublicProfileServerDependencies } from './publicProfileStorage';
import { replacePublicProfileSnapshotInTx } from './publicProfileRefresh';
import { preparePublicProfilePicture, completePublicProfilePictureInTx, retirePublicProfilePictureInTx,
    discardPublicProfilePicture, cleanupPublicProfilePicturesAfterCommit } from './publicProfilePicture';
import { log } from '@/utils/logging/log';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';

/** Stores only the exact reviewed public disclosure, without changing Account mode or keys. */
export async function publishPublicProfile(accountId: string, input: PublicProfilePublishBodyV1, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfilePublishBodyV1Schema.parse(input);
    const layout = validatePublicProfileLayout(body.layout);
    const candidate = await preparePublicProfilePicture({ accountId, atmosphere: body.appearance.atmosphere });
    if (!candidate.ok) return publicProfileUnavailable('asset_unavailable');
    const prepared = candidate.prepared;
    try {
        const appearance = PublicProfileAppearanceV1Schema.parse({ ...body.appearance, atmosphere: prepared.atmosphere });
        return await inTx(async tx => {
            // Publishing admits the current identity and may create the row;
            // release must not clear the handle between that admission and creation.
            await acquireAccountChangePublicationLocksInTx(tx, [accountId], { includeSingleAccount: true, intent: 'exclusive' });
            const row = await readPublicProfileForMutationInTx(tx, accountId);
            const context = await deps.readPublicationContext(tx, accountId, env);
            if (!context.handle) return publicProfileUnavailable('username_required');
            const prerequisite = deps.resolvePrerequisite(env);
            if (prerequisite) return publicProfileUnavailable(prerequisite);
            if (row?.removedAt) return publicProfileUnavailable('restricted');
            const settled = await completePublicProfilePictureInTx(tx, prepared);
            if (!settled.ok) return publicProfileUnavailable('asset_unavailable');
            const previous = row && readStoredPublicProfileAppearance(row.appearanceJson);
            if (previous?.atmosphere.source === 'picture') {
                await retirePublicProfilePictureInTx(tx, accountId, previous.atmosphere.picture.ref.id);
            }
            const metadata = projectPublicProfileMetadata(body.metadata, body.policy);
            const data = { state: 'published', policyJson: JSON.stringify(body.policy), metadataJson: JSON.stringify({ disclosure: metadata,
                projectSelections: body.policy.fields.projects ? body.projectSelections : [] }), queryJson: JSON.stringify(normalizeUsageQuery(body.query)),
                snapshotJson: JSON.stringify(projectPublicProfileSnapshot(body.snapshot, body.policy)), layoutJson: JSON.stringify(layout),
                appearanceJson: JSON.stringify(appearance), publishedAt: row?.publishedAt ?? new Date() };
            return publicProfileUpdated(row ? await updatePublicProfileInTx(tx, row, data)
                : await createPublicProfileInTx(tx, { accountId, ...data }));
        }, { isolationLevel: 'ReadCommitted' });
    } finally {
        await discardPublicProfilePicture(prepared).catch(() => {
            log({ module: 'api', level: 'warn', accountId }, 'Public-profile picture candidate cleanup failed');
        });
        await cleanupPublicProfilePicturesAfterCommit(accountId);
    }
}

/** Resume preserves the stored edition and consent, admitting fresh facts before publication. */
export async function resumePublicProfile(accountId: string, input: PublicProfileRefreshBodyV1,
    env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfileRefreshBodyV1Schema.parse(input);
    return inTx(tx => replacePublicProfileSnapshotInTx(tx, accountId, body, env, deps, 'resume'), { isolationLevel: 'ReadCommitted' });
}
