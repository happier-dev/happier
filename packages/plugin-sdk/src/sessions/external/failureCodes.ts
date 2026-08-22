/** @moduleRealm any */

/**
 * The one External Sessions contribution failure vocabulary. The tuple is the
 * canonical owner: the author type, the SDK boundary validators for the
 * sibling hook and takeover facets, and the host invocation wrapper all read
 * their admitted codes from here, so a code can never be admitted by one owner
 * and rejected by another.
 */
const AGENT_EXTERNAL_SESSIONS_FAILURE_CODES = [
    'source_invalid',
    'source_unreachable',
    'candidate_not_found',
    'agent_unavailable',
    'unsupported',
    'unavailable',
    'not_authorized',
    'invalid_request',
    'cancelled',
    'agent_error',
    'timeout',
] as const;

export type AgentExternalSessionsFailureCode = typeof AGENT_EXTERNAL_SESSIONS_FAILURE_CODES[number];

const AGENT_EXTERNAL_SESSIONS_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
    AGENT_EXTERNAL_SESSIONS_FAILURE_CODES,
);

/**
 * Admits exactly the failure codes an External Sessions contribution may
 * return. Boundary validators use it instead of restating the vocabulary.
 */
export function isAgentExternalSessionsFailureCode(
    value: unknown,
): value is AgentExternalSessionsFailureCode {
    return typeof value === 'string' && AGENT_EXTERNAL_SESSIONS_FAILURE_CODE_SET.has(value);
}
