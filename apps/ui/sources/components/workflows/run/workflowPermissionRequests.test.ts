import { describe, expect, it } from 'vitest';

import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

import {
    hasWorkflowPermissionRequest,
    projectWorkflowInvocationRequests,
    projectWorkflowPermissionRequests,
} from './workflowPermissionRequests';

/**
 * The one projection of an invocation's recorded requests.
 *
 * A structured agent question and a tool permission are two different
 * contracts (Protocol `resolveAgentRequestKind`). Treating every request that
 * names a tool as a permission offered Allow/Deny for AskUserQuestion — an
 * answer the agent cannot use — so the kind is decided by the Protocol owner.
 */
function progressWith(requests: Record<string, unknown>): WorkflowProgressEnvelopeV1 {
    return {
        kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: 'analyze', scope: [] },
        blockKind: 'step',
        attempt: '0',
        logicalInvocationRecordId: 'inv-1',
        interaction: { requests },
    } as WorkflowProgressEnvelopeV1;
}

describe('projectWorkflowInvocationRequests', () => {
    it('keeps a Run producer offer and catalog subject on the canonical prompt request', () => {
        const nativeChoices = { requirementId: 'offer', source: 'agent', choices: [{ id: 'remember', label: 'Remember',
            decision: 'approved', scope: 'session', response: { approved: true },
            followUp: { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } } }] };
        const mcpTool = { server: 'docs', serverTitle: 'Docs', tool: 'write', item: { serverId: 'docs' },
            decision: { exposed: true, approval: 'ask', effectClass: 'write', source: 'server_default' } } satisfies ResolvedMcpToolIdentityV1;
        expect(projectWorkflowInvocationRequests(progressWith({ native: { tool: 'McpTool', arguments: {}, createdAt: 1,
            nativeChoices, mcpTool } }))).toMatchObject([{ requestId: 'native', nativeChoices, mcpTool }]);
    });
    it('keeps a structured question out of the permission projection', () => {
        const progress = progressWith({
            'permission-1': { tool: 'Write', arguments: { path: '/repo/file.txt' }, createdAt: 1 },
            'question-1': {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 2,
                arguments: {
                    questions: [{
                        question: 'Which branch should the fix land on?',
                        header: 'Branch',
                        options: [{ label: 'main', description: 'Stable' }, { label: 'dev' }],
                        multiSelect: false,
                    }],
                },
            },
            // Older agents publish no kind; the Protocol still knows this tool.
            'question-legacy': { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'Proceed?' }] }, createdAt: 3 },
        });

        expect(projectWorkflowPermissionRequests(progress).map((request) => request.requestId)).toEqual(['permission-1']);
        expect(hasWorkflowPermissionRequest(progress, 'question-1')).toBe(false);

        const requests = projectWorkflowInvocationRequests(progress);
        expect(requests.map((request) => [request.requestId, request.kind])).toEqual([
            ['permission-1', 'permission'],
            ['question-1', 'user_action'],
            ['question-legacy', 'user_action'],
        ]);
    });
});
