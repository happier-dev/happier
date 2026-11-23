import { describe, expect, it } from 'vitest';
import { decideExecutionRunRolePolicy } from './rolePolicy';
import type { ExecutionRunSessionAdapterInput } from './retainedInteractionEligibility';

const base: ExecutionRunSessionAdapterInput = {
    scope: 'detached', hasParentSessionCustody: false,
    agentExposesSessionRuntime: true, agentExposesDetachedConversation: true,
    sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny' },
    intent: 'agent', runClass: 'long_lived', retentionPolicy: 'resumable',
};

describe('selected execution surface Role policy', () => {
    it.each([
        { input: base, surface: 'retained_agent_conversation', allowed: true },
        { input: { ...base, sessionCapabilities: { ...base.sessionCapabilities!, workspaceWrites: undefined } }, surface: 'retained_agent_conversation', allowed: false },
        { input: { ...base, agentExposesDetachedConversation: false }, surface: 'finite_agent_session', allowed: true },
        { input: { ...base, scope: 'session_owned' as const }, surface: 'finite_agent_session', allowed: true },
        { input: { ...base, agentExposesSessionRuntime: false }, surface: 'native_execution_run', allowed: false },
    ])('uses $surface with denial=$allowed', ({ input, surface, allowed }) => {
        // Deliberately opposite declarations distinguish selected Session from Run capability.
        const decision = decideExecutionRunRolePolicy({ ...input, workspaceWrites: 'deny',
            executionRunCapabilities: { workspaceWrites: undefined } });
        expect(decision).toEqual(allowed ? { status: 'enforceable', surface }
            : { status: 'refused', code: 'role_policy_unenforceable', surface });
    });
    it('admits an execution-run-only Agent on its own denial declaration', () => {
        expect(decideExecutionRunRolePolicy({ ...base, agentExposesSessionRuntime: false,
            workspaceWrites: 'deny', executionRunCapabilities: { workspaceWrites: 'deny' } }))
            .toEqual({ status: 'enforceable', surface: 'native_execution_run' });
    });
    it('does not require denial support for an unrestricted Role', () => {
        expect(decideExecutionRunRolePolicy({ ...base, workspaceWrites: undefined,
            sessionCapabilities: null, executionRunCapabilities: null })).toMatchObject({ status: 'enforceable' });
    });
});
