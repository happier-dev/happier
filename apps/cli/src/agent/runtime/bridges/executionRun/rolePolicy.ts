import { supportsAgentWorkspaceWriteDenial } from '@happier-dev/protocol/plugins/contributions/agentSessionCapabilities';
import { selectExecutionRunSessionAdapter, type ExecutionRunSessionAdapterInput,
    type ExecutionRunSessionAdapterSelection } from './retainedInteractionEligibility';

export type ExecutionRunRolePolicyDecision = Readonly<
    | { status: 'enforceable'; surface: ExecutionRunSessionAdapterSelection }
    | { status: 'refused'; code: 'role_policy_unenforceable'; surface: ExecutionRunSessionAdapterSelection }
>;

/** Reports the policy of the adapter Run start actually selects. Does not admit a Run. */
export function decideExecutionRunRolePolicy(input: ExecutionRunSessionAdapterInput & Readonly<{
    executionRunCapabilities: Parameters<typeof supportsAgentWorkspaceWriteDenial>[0];
    workspaceWrites: 'allow' | 'deny' | undefined;
}>): ExecutionRunRolePolicyDecision {
    const surface = selectExecutionRunSessionAdapter(input);
    const capabilities = surface === 'native_execution_run' ? input.executionRunCapabilities : input.sessionCapabilities;
    return input.workspaceWrites === 'deny' && !supportsAgentWorkspaceWriteDenial(capabilities)
        ? { status: 'refused', code: 'role_policy_unenforceable', surface }
        : { status: 'enforceable', surface };
}
