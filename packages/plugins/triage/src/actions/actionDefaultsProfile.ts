import { PluginError } from '@happier-dev/plugin-sdk';
import {
    isPluginActionApprovalRequestCreated,
    type ActionApprovalRequestCreatedResult,
    type ActionsService,
    type PluginActionInputById,
    type PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';

type Profile = PluginActionInputById['launch_profiles.create']['profile'];
type ProfileMutation = PluginActionResultById['launch_profiles.save'];

function refuseProfileAction(actionId: string, result: Readonly<{ status: string; reason?: string }>): never {
    throw new PluginError({ code: result.reason ?? result.status, details: { actionId, status: result.status } });
}

function requireProfileUpdate(actionId: string, result: ProfileMutation | ActionApprovalRequestCreatedResult) {
    if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({ code: 'approval_required', details: { actionId } });
    if (result.status !== 'updated') refuseProfileAction(actionId, result);
    return result;
}

/** Snapshot launch defaults through the Profile owner, preserving reusable sources. */
export async function saveTriageActionDefaultProfileV1(input: Readonly<{
    profileId: string | null;
    placement: NonNullable<Profile['placement']>;
    checkout: NonNullable<Profile['checkout']>;
    ownedProfileId?: string;
}>, deps: Readonly<{
    actions: Pick<ActionsService, 'execute'>;
    mintId: () => string;
    signal?: AbortSignal;
}>): Promise<Readonly<{ profileId: string }>> {
    const reuse = input.ownedProfileId !== undefined && input.profileId === input.ownedProfileId;
    const profileId = reuse ? input.ownedProfileId! : deps.mintId();
    const selectedId = reuse ? profileId : input.profileId;
    const now = Date.now();
    const name = `Action default (${profileId})`;

    if (selectedId === null) {
        requireProfileUpdate('launch_profiles.create', await deps.actions.execute('launch_profiles.create', {
            expectedRevision: 'absent', profile: {
                v: 2, id: profileId, name, extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {},
                defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
                placement: input.placement, checkout: input.checkout, createdAt: now, updatedAt: now,
            },
        }, { signal: deps.signal }));
        return { profileId };
    }

    const opened = await deps.actions.execute('launch_profiles.read', { id: selectedId }, { signal: deps.signal });
    if (isPluginActionApprovalRequestCreated(opened)) throw new PluginError({ code: 'approval_required', details: { actionId: 'launch_profiles.read' } });
    if (opened.status !== 'present') refuseProfileAction('launch_profiles.read', opened);

    const expectedRevision = 'revision' in opened ? opened.revision : 'absent';
    if (!reuse) {
        requireProfileUpdate('launch_profiles.duplicate', await deps.actions.execute('launch_profiles.duplicate', {
            id: selectedId, expectedRevision, newProfileId: profileId, name, now,
            placement: input.placement, checkout: input.checkout,
        }, { signal: deps.signal }));
        return { profileId };
    }

    requireProfileUpdate('launch_profiles.save', await deps.actions.execute('launch_profiles.save', {
        id: profileId, expectedRevision,
        profile: { ...opened.profile, placement: input.placement, checkout: input.checkout, updatedAt: now },
    }, { signal: deps.signal }));
    return { profileId };
}
