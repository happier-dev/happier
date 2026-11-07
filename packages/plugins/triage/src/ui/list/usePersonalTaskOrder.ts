import type { InternalTaskListProjection } from '../../internalTasks/listProjection.js';

export type PersonalTaskOrder = NonNullable<InternalTaskListProjection['order']>;

/** A read-only projection of the existing Account index, scoped to this mounted authority. */
export function usePersonalTaskOrder(enabled: boolean, projection: InternalTaskListProjection | undefined, refresh: () => void) {
  return { value: enabled ? projection?.order ?? null : null,
    available: enabled && projection?.order !== undefined && projection.failure === undefined,
    onDropOutcome: refresh };
}
