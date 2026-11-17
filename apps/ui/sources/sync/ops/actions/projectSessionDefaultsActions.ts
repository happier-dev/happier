import { ProjectSessionDefaultsGetOutputV1Schema, type ProjectSessionDefaultsGetInputV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from './scopedHomeActionExecutor';
import { requireActionSuccess } from './actionResult';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';

/** Missing and empty layers both inherit; explicit null fields remain deliberate picks. */
export function isProjectSessionDefaultsEditUnchanged(current: ProjectSessionDefaultsV1 | null | undefined,
    next: ProjectSessionDefaultsV1 | null): boolean {
    return areAccountSettingsJsonValuesEqual(current ?? {}, next ?? {});
}

/** Read and editor intents use the same admitted, exact-Account Action front door. */
export async function executeProjectDefaultsAction(scope: ServerAccountScope, actionId: ActionId,
    input: unknown, signal?: AbortSignal) {
    const result = await scopedHomeActionExecutor(scope)(actionId, input, {
        surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
        ...(signal ? { signal } : {}),
    });
    requireActionSuccess(result, actionId);
    return result.result;
}

export async function getProjectSessionDefaults(scope: ServerAccountScope, input: ProjectSessionDefaultsGetInputV1,
    signal?: AbortSignal) {
    return ProjectSessionDefaultsGetOutputV1Schema.parse(await executeProjectDefaultsAction(
        scope, PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, input, signal));
}
