import {
    validateLaunchProfileV2ReservedEnvironment,
    type LaunchProfileV2,
} from '@happier-dev/protocol/profiles/v2/schema';
import { AiLaunchProfileV1Schema, isLaunchProfileV2, type AiLaunchProfileSourceV1 } from '@happier-dev/protocol/profiles/read';

export type SlimProfileEditableDraft = Readonly<{
    name: string;
    description: string;
    extraEnvironmentVariables: LaunchProfileV2['extraEnvironmentVariables'];
    envVarRequirements?: LaunchProfileV2['envVarRequirements'];
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
    /**
     * The library skills added to every session started with this Profile (D21). An empty list is an
     * answer: it is written explicitly so removing the last seed removes it.
     */
    skillSeeds?: readonly string[];
}>;

export type SlimProfileSaveResult =
    | Readonly<{ status: 'success'; profile: LaunchProfileV2 & AiLaunchProfileSourceV1 }>
    | Readonly<{ status: 'error'; field: 'name' | 'description' | 'extraEnvironmentVariables'; message: string }>;

export function buildSlimProfileSave(
    profile: LaunchProfileV2 & AiLaunchProfileSourceV1,
    draft: SlimProfileEditableDraft,
    now: () => number = Date.now,
    reservedEnvironmentVariableNames: ReadonlySet<string> = new Set(),
): SlimProfileSaveResult {
    // The canonical opened-profile schema retains admitted StoredV2 body and
    // source evidence without allowing unknown carriers into the edit result.
    // Creating a new logical row still uses its strict persistence owner.
    const parsed = AiLaunchProfileV1Schema.safeParse({
        ...profile,
        name: draft.name.trim(),
        ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : { description: undefined }),
        extraEnvironmentVariables: draft.extraEnvironmentVariables,
        ...(draft.envVarRequirements === undefined ? {} : { envVarRequirements: draft.envVarRequirements }),
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
        ...(draft.skillSeeds === undefined ? {} : { skillSeeds: draft.skillSeeds }),
        updatedAt: now(),
    });
    if (parsed.success) {
        if (!isLaunchProfileV2(parsed.data)) return { status: 'error', field: 'name', message: 'Invalid V2 profile' };
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
    // The opened-profile schema is a union of the historical and V2 shapes. A V2 draft
    // fails the historical branch at the object root, so the actionable issue is the
    // nested one that points at a field.
    const [first] = parsed.error.issues;
    const issue = first?.code === 'invalid_union'
        ? first.errors.flat().find((nested) => nested.path.length > 0) ?? first
        : first;
    const root = issue?.path[0];
    const field = root === 'envVarRequirements' ? 'extraEnvironmentVariables'
        : root === 'description' || root === 'extraEnvironmentVariables' ? root : 'name';
    return { status: 'error', field, message: issue?.message ?? 'Invalid profile' };
}
