import { PublicProfileRefreshBodyV1Schema, type PublicProfileMutationResultV1, type PublicProfileRefreshBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfileSnapshot, projectPublicProfileMetadata } from '@happier-dev/protocol/account/projectPublicProfile';
import { getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import { inTx, type Tx } from '@/storage/inTx';
import { parsePublicProfileRecord, publicProfileUnavailable, publicProfileUpdated, readPublicProfileForMutationInTx, updatePublicProfileInTx, type PublicProfileServerDependencies } from './publicProfileStorage';

/** Replaces facts under current consent; only explicit resume changes a paused lifecycle. */
export async function refreshPublicProfile(accountId: string, input: PublicProfileRefreshBodyV1, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfileRefreshBodyV1Schema.parse(input);
    return inTx(tx => replacePublicProfileSnapshotInTx(tx, accountId, body, env, deps, 'refresh'), { isolationLevel: 'ReadCommitted' });
}

/** Shared replacement admission; only the explicit publication owner can request resume. */
export async function replacePublicProfileSnapshotInTx(tx: Tx, accountId: string, body: PublicProfileRefreshBodyV1,
    env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies, intent: 'refresh' | 'resume'): Promise<PublicProfileMutationResultV1> {
    const row = await readPublicProfileForMutationInTx(tx, accountId);
    if (!row || row.state !== (intent === 'resume' ? 'paused' : 'published')) return publicProfileUnavailable('not_published');
    if (row.removedAt) return publicProfileUnavailable('restricted');
    const current = parsePublicProfileRecord(row);
    if (!current?.policy || !current.query || !current.metadata) return publicProfileUnavailable('invalid_stored_content');
    if (getUsageQueryKey(body.query) !== getUsageQueryKey(current.query)) return publicProfileUnavailable('query_mismatch');
    const context = await deps.readPublicationContext(tx, accountId, env);
    if (!context.handle) return publicProfileUnavailable('username_required');
    if (intent === 'resume') {
        const prerequisite = deps.resolvePrerequisite(env);
        if (prerequisite) return publicProfileUnavailable(prerequisite);
        if (!current.layout || !current.appearance) return publicProfileUnavailable('invalid_stored_content');
    }
    const metadata = projectPublicProfileMetadata(current.metadata, current.policy);
    if (body.projectLinks && metadata.projects) {
        const selected = new Set(body.projectLinks.map(link => JSON.stringify(link)));
        metadata.projects = metadata.projects.filter(link => selected.has(JSON.stringify(link)));
    }
    return publicProfileUpdated(await updatePublicProfileInTx(tx, row, {
        state: 'published', snapshotJson: JSON.stringify(projectPublicProfileSnapshot(body.snapshot, current.policy)),
        metadataJson: JSON.stringify({ disclosure: metadata, projectSelections: current.policy.fields.projects ? current.projectSelections : [] }),
    }));
}
