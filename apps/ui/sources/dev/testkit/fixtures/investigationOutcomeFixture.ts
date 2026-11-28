import type { OperationsRunOutcomeInput, OperationsRunProducedResults } from '@/sync/domains/workflows/operationsRunOutcome';

export function createInvestigationOutcomeFixture(
    serverId: string,
    state: 'working' | 'inconclusive' | 'proposal' | 'settled' | 'handle',
): OperationsRunOutcomeInput {
    const session = { serverId, sessionId: 'repair-session' };
    const findings = state === 'inconclusive'
        ? 'The build log ends before the migration step. The cause is still unclear without the database log.'
        : 'The build log shows that the migration was skipped. A database lock is still possible. Run the repair test to confirm before changing production.';
    const approvals: OperationsRunProducedResults['approvals'] = state === 'working' || state === 'inconclusive' ? [] : [{
        serverId,
        request: { kind: 'approval_request_created', artifactId: 'repair-approval', actionId: 'projects.compute.exec' },
        ...(state === 'proposal' ? { status: 'open', review: {
            actionId: 'projects.compute.exec',
            actionArgs: {
                workspace: { serverId, machineId: 'runner', workspaceId: 'workspace', rootPath: '/repo' },
                executable: 'pnpm', argv: ['test:repair'], cwd: '/repo', choice: { kind: 'primary' },
            },
            preview: null,
        } } : state === 'settled' ? { status: 'executed' } : {}),
    }];
    return {
        subject: { kind: 'deploymentEnvironment', serverId, environmentId: 'production' },
        finding: { kind: 'investigate', session, result: state === 'working' ? {
            preview: { state: 'unavailable' }, workflowInvocation: null, completedAt: null,
        } : {
            preview: { state: 'available', text: findings }, workflowInvocation: null, completedAt: 1,
        } },
        produced: { approvals, pullRequests: [], operations: [], pendingOperations: [], receipts: [] },
    };
}
