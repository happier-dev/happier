import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import { resolvePreferredBackendTargetFromProjection } from './resolvePreferredBackendTargetFromProjection';

/** Preference intent and catalog availability use the same canonical target owner. */
export function resolvePreferredBackendTargetFromSettings(
    params: Parameters<typeof resolvePreferredBackendTargetFromProjection>[0],
): PersistedBackendTargetRefV2 {
    return resolvePreferredBackendTargetFromProjection(params);
}
