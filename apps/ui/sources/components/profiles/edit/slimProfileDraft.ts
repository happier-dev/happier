import {
    LaunchProfileV2Schema,
    validateLaunchProfileV2ReservedEnvironment,
    type LaunchProfileV2,
} from '@happier-dev/protocol';

export type SlimProfileEditableDraft = Readonly<{
    name: string;
    description: string;
    extraEnvironmentVariables: LaunchProfileV2['extraEnvironmentVariables'];
    defaultPermissionModeByTargetKey?: LaunchProfileV2['defaultPermissionModeByTargetKey'];
    defaultPersistenceModeByTargetKey?: LaunchProfileV2['defaultPersistenceModeByTargetKey'];
    preferredAgentTargetKey?: LaunchProfileV2['preferredAgentTargetKey'];
    preferredModelSelection?: LaunchProfileV2['preferredModelSelection'];
}>;

export type SlimProfileSaveResult =
    | Readonly<{ status: 'success'; profile: LaunchProfileV2 }>
    | Readonly<{ status: 'error'; field: 'name' | 'description' | 'extraEnvironmentVariables'; message: string }>;

export function isSlimProfileReservedEnvironmentAuthorityReady(input: Readonly<{
    projectionPhase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    hasV2Projection: boolean;
}>): boolean {
    return input.projectionPhase === 'ready' && input.hasV2Projection;
}

export function buildSlimProfileSave(
    profile: LaunchProfileV2,
    draft: SlimProfileEditableDraft,
    now: () => number = Date.now,
    reservedEnvironmentVariableNames: ReadonlySet<string> = new Set(),
    reservedEnvironmentAuthorityReady = true,
): SlimProfileSaveResult {
    if (!reservedEnvironmentAuthorityReady
        && JSON.stringify(draft.extraEnvironmentVariables) !== JSON.stringify(profile.extraEnvironmentVariables)) {
        return {
            status: 'error',
            field: 'extraEnvironmentVariables',
            message: 'Reserved environment validation is unavailable until a machine is connected',
        };
    }
    const parsed = LaunchProfileV2Schema.safeParse({
        ...profile,
        name: draft.name.trim(),
        ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : { description: undefined }),
        extraEnvironmentVariables: draft.extraEnvironmentVariables,
        defaultPermissionModeByTargetKey: draft.defaultPermissionModeByTargetKey ?? profile.defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey: draft.defaultPersistenceModeByTargetKey ?? profile.defaultPersistenceModeByTargetKey,
        ...(draft.preferredAgentTargetKey
            ? { preferredAgentTargetKey: draft.preferredAgentTargetKey }
            : { preferredAgentTargetKey: undefined }),
        ...(draft.preferredModelSelection
            ? { preferredModelSelection: draft.preferredModelSelection }
            : { preferredModelSelection: undefined }),
        updatedAt: now(),
    });
    if (parsed.success) {
        try {
            validateLaunchProfileV2ReservedEnvironment(parsed.data, reservedEnvironmentVariableNames);
            return { status: 'success', profile: parsed.data };
        } catch (error) {
            return {
                status: 'error',
                field: 'extraEnvironmentVariables',
                message: error instanceof Error ? error.message : 'Reserved environment variable',
            };
        }
    }
    const issue = parsed.error.issues[0];
    const root = issue?.path[0];
    const field = root === 'description' || root === 'extraEnvironmentVariables' ? root : 'name';
    return { status: 'error', field, message: issue?.message ?? 'Invalid profile' };
}
