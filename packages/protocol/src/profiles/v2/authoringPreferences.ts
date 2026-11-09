import type { SessionAuthoringExecutionTargetV2 } from '../../sessions/authoring/fieldCatalog.js';
import type { SessionAuthoringCheckoutCreationDraftV1 } from '../../sessions/authoring/creationFieldsV1.js';
import type { SessionDirectoryIntentV1 } from '../../sessions/creation/sessionDirectoryIntentV1.js';
import type { ManagedCreationSelectionV1 } from '../../machines/managed/managedConfigurationV1.js';
import type { LaunchProfileCheckoutPreferenceV1, LaunchProfilePlacementPreferenceV1 } from '../launchPreferencesV1.js';

export type LaunchProfileAuthoringPreferencesV1 =
    | Readonly<{ status: 'supported'; placement: LaunchProfilePlacementPreferenceV1; checkout: LaunchProfileCheckoutPreferenceV1 }>
    | Readonly<{ status: 'unsupported'; reason: 'ephemeralPlacement' }>;

/** Reusable preferences describe authored choices, never an acquired machine or pool result. */
export function projectLaunchProfileAuthoringPreferencesV1(input: Readonly<{
    executionTarget?: SessionAuthoringExecutionTargetV2 | null;
    directoryIntent?: SessionDirectoryIntentV1;
    checkoutCreationDraft?: SessionAuthoringCheckoutCreationDraftV1 | null;
    managedCreationSelection?: ManagedCreationSelectionV1 | null;
}>): LaunchProfileAuthoringPreferencesV1 {
    const target = input.executionTarget;
    if (input.managedCreationSelection || target?.kind === 'temporary_computer'
        || (target?.kind === 'machine' && target.selectionOrigin)) {
        return { status: 'unsupported', reason: 'ephemeralPlacement' };
    }
    const placement: LaunchProfilePlacementPreferenceV1 = target === undefined ? 'automatic'
        : target === null ? 'ask'
        : { fixed: target.target, ...(input.directoryIntent?.kind === 'managed'
            ? { directoryIntent: input.directoryIntent }
            : input.directoryIntent?.kind === 'path' ? { directory: input.directoryIntent.path } : {}) };
    return { status: 'supported', placement, checkout: input.checkoutCreationDraft ? 'create_worktree' : 'reuse_workspace' };
}
