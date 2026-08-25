import {
    resolveHappierListMultiSelectionRange,
    type HappierListMultiSelectionRangeInput,
} from '@happier-dev/plugin-ui/presentation';

import type { SessionListSelectionKey } from './sessionListSelectionTypes';

export type SessionListSelectionRangeInput = HappierListMultiSelectionRangeInput;

/**
 * The contiguous visible run between the anchor and the target — resolved by the
 * shared collection owner, not by a sessions-local copy of the same rule.
 */
export function resolveSessionListSelectionRange(
    input: SessionListSelectionRangeInput,
): SessionListSelectionKey[] {
    return resolveHappierListMultiSelectionRange(input);
}
