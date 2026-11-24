import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

/**
 * Which existing Execution Run adapter owns this run.
 *
 * `retained_agent_session` keeps one Agent Session runtime across turns;
 * `finite_agent_session` projects a Session runtime into a terminalizing finite
 * run; `native_execution_run` belongs to Agents whose genuine owner is native
 * Execution Runs.
 */
export type ExecutionRunSessionAdapterSelection = import('@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc').ExecutionRunRolePolicySurfaceV1;

export type ExecutionRunRetainedInteractionScope =
    | 'session_owned'
    | 'detached';

export type ExecutionRunSessionAdapterInput = Readonly<{
    /** Exact host-owned Run scope; detached Runs never inherit parent Session custody. */
    scope: ExecutionRunRetainedInteractionScope;
    /** Describes whether parent Session custody is available for Session-only facets. */
    hasParentSessionCustody: boolean;
    /** True when the selected Agent runtime exposes a Session runtime at all. */
    agentExposesSessionRuntime: boolean;
    /** The selected generation exposes the optional detached multi-turn facet. */
    agentExposesDetachedConversation: boolean;
    /** The selected Agent generation's declared Session capabilities, if any. */
    sessionCapabilities: AgentSessionCapabilities | null;
    intent: string | null | undefined;
    runClass: string | null | undefined;
    retentionPolicy: string | null | undefined;
}>;

function normalize(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The one owner of provider-native Session retention eligibility.
 *
 * Selection follows actual run lifecycle plus the Agent's declared Session
 * capability. It deliberately does not read an intent allowlist: the former
 * Voice-only branch would otherwise return as a longer list of intent names,
 * and `ioMode: 'streaming'` alone cannot discriminate because bounded streaming
 * jobs exist. Generic host code must never branch on Agent ids here.
 */
export function selectExecutionRunSessionAdapter(
    input: ExecutionRunSessionAdapterInput,
): ExecutionRunSessionAdapterSelection {
    if (!input.agentExposesSessionRuntime) return 'native_execution_run';
    const capabilities = input.sessionCapabilities;
    // Bounded jobs can need a profile's structured-output repair turn or a
    // live intervention after their first native turn. The host's bounded
    // loop owns completion/disposal; native turn completion must not retire
    // the Session before that loop settles. This retains no cross-run state.
    const needsSessionTurns = normalize(input.runClass) === 'long_lived'
        || (normalize(input.runClass) === 'bounded' && input.scope === 'session_owned');
    const retainable = capabilities !== null
        && needsSessionTurns
        && capabilities.open.includes('create')
        && capabilities.delivery.includes('newTurn');
    if (!retainable) return 'finite_agent_session';
    if (input.scope === 'detached' && !input.agentExposesDetachedConversation) {
        return 'finite_agent_session';
    }
    if (input.scope === 'session_owned' && !input.hasParentSessionCustody) {
        return 'finite_agent_session';
    }
    return input.scope === 'detached' ? 'retained_agent_conversation' : 'retained_agent_session';
}
