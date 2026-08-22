import type {
    AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';

import { deepEqual } from '@/utils/deterministicJson';

/**
 * Agent source resolution may add canonical identity fields, but it must not
 * remove or rewrite identity that an earlier admission already established.
 */
export function preservesExternalSessionSourceIdentity(
    admittedSource: AgentExternalSessionSource,
    resolvedSource: AgentExternalSessionSource,
): boolean {
    return Object.entries(admittedSource).every(([key, value]) => (
        Object.prototype.hasOwnProperty.call(resolvedSource, key)
        && deepEqual(value, resolvedSource[key])
    ));
}
