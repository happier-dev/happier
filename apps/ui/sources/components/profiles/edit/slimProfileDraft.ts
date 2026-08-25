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
    codingPromptBehaviorOverrides?: LaunchProfileV2['codingPromptBehaviorOverrides'];
    /**
     * Where a Session authored from this profile should run, and how it should
     * obtain its checkout. Both are PREFERENCES the profile owner already
     * defines and every launch already reads; until now nothing could write
     * one, so they were schema a person could not reach.
     *
     * `undefined` is a real answer and means "no preference" — which is why the
     * save below states them explicitly rather than omitting them: the stored
     * profile is spread first, so an omitted member would keep the old value
     * and removing a preference would silently do nothing.
     */
    placement?: LaunchProfileV2['placement'];
    checkout?: LaunchProfileV2['checkout'];
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
        codingPromptBehaviorOverrides: draft.codingPromptBehaviorOverrides,
        placement: draft.placement,
        checkout: draft.checkout,
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
