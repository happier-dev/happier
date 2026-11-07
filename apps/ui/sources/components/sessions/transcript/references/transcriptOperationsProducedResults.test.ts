import { expect, it } from 'vitest';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import { readTranscriptOperationsProducedResults } from './transcriptOperationsProducedResults';

function call(actionId: string, result: unknown, overrides: Partial<ToolCall> = {}): Message {
    return { kind: 'tool-call', id: actionId, localId: null, createdAt: 1, children: [], tool: {
        name: 'mcp__happier__action_execute', input: { actionId, input: {} }, state: 'completed',
        result: { ok: true, result }, createdAt: 1, startedAt: 1, completedAt: 2, description: null, ...overrides,
    } };
}

it('preserves a pending deployment operation address without inventing a receipt or deployed effect', () => {
    const operation = { serverId: 'other-home', machineId: 'controller', operationId: 'deploy' };
    const produced = readTranscriptOperationsProducedResults([call('deployments.deploy', { ok: true,
        environmentId: 'env', revision: 1, kind: 'pending', actionOperationId: 'deploy', operation })], 'home');
    expect(produced.pendingOperations).toEqual([operation]);
    expect(produced.receipts).toEqual([]);
    expect(produced.operations).toEqual([]);
});

it('ignores prose, foreign tools, failed calls, compose-only PRs and nonmatching wait snapshots', () => {
    const approval = { kind: 'approval_request_created', artifactId: 'approval', actionId: 'projects.compute.exec' };
    const snapshot = { version: 1, operationId: 'real', revision: 1, actionId: 'projects.compute.exec', state: 'accepted',
        scope: { accountId: 'account', machineId: 'machine' }, title: 'not yet run', createdAt: 1, cancellation: 'supported' };
    const messages: Message[] = [
        { kind: 'agent-text', id: 'prose', localId: null, createdAt: 1, text: JSON.stringify(approval) },
        call('projects.compute.exec', approval, { name: 'mcp__other__action_execute' }),
        call('projects.compute.exec', approval, { state: 'error' }),
        call('scm.pullRequest.openOrReuse', { success: true, result: 'opened_compose', nextAction: { kind: 'none' } }),
        call('wait', { target: { kind: 'action_operation', serverId: 'home', machineId: 'machine', operationId: 'different' },
            condition: { kind: 'terminal' }, disposition: 'matched', snapshot }),
        call('wait', { target: { kind: 'action_operation', serverId: 'home', machineId: 'machine', operationId: 'real' },
            condition: { kind: 'terminal' }, disposition: 'observation_timeout', snapshot }),
    ];
    const result = readTranscriptOperationsProducedResults(messages, 'home');
    expect(result.pullRequests).toEqual([]);
    expect(result.approvals).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.receipts).toEqual([]);
});
