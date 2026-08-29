import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

/**
 * Normalizes independently owned runtime/profile/auth/task readers into one snapshot input. The
 * adapter does not cache or persist any setup progress; callers can invoke it again after every
 * operation and after relaunch.
 */
export function createPersonalHomeBootstrapFacts(input: PersonalHomeFacts): PersonalHomeFacts {
    return {
        ...input,
        localHomeIdentity: input.localHomeIdentity?.trim() || null,
    };
}
