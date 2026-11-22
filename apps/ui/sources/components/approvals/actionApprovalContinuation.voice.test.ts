import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';

import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createActionApprovalContinuationObserver, resumeActionExecutionResult } from './actionApprovalContinuation';

await initializeRealAppRuntimeForTests();

const held = { ok: false, errorCode: 'approval_result_held', error: 'approval_result_held' } as const;
const service = { pluginId: 'example.accounts', localId: 'service' };
const connectInput = { service, modeId: 'oauth', machineId: 'machine-1' };
const oauth = { status: 'awaitingOAuth', attemptId: 'attempt-1',
    callbackUrl: 'https://callback.example.test/', authorizationUrl: 'https://authorize.example.test/private' };
const manual = { status: 'awaitingManual', attemptId: 'attempt-1' };
const list = { sessions: [], nextCursor: null };

describe('Voice approval continuation', () => {
    it.each([
        { actionId: 'daemon.filesystem.copy', input: { rootPath: '/workspace', from: 'old.txt', to: 'copy.txt',
            overwrite: false, recursive: false }, output: { success: true }, outcome: held, projected: { redacted: true } },
        { actionId: 'connectedServices.authentication.beginConnect', input: connectInput, output: oauth, outcome: held,
            projected: { status: oauth.status, attemptId: oauth.attemptId } },
        { actionId: 'connectedServices.authentication.beginConnect', input: { ...connectInput, modeId: 'manual' },
            output: manual, outcome: { ok: true, result: manual } },
        { actionId: 'session.list', input: { limit: 10 }, output: list, outcome: { ok: true, result: list } },
    ] satisfies readonly { actionId: ActionId; input: object; output: object; outcome: ActionExecuteResult; projected?: object }[])
    ('settles $actionId with $outcome after the approved operation runs once', async ({ actionId, input, output, outcome, projected }) => {
        let stored: ApprovalRequest | null = null;
        const calls: unknown[] = [];
        const run = async ({ input: operands }: { input: unknown }) => { calls.push(operands); return output; };
        const persist = (request: ApprovalRequest) => {
            stored = StoredApprovalRequestSchema.parse(JSON.parse(JSON.stringify(request)));
        };
        const boundary = createActionExecutorBoundaryFixture({
            approvalsCreate: async ({ request }) => { persist(request); return { artifactId: 'approval-1' }; },
            approvalsGet: async () => stored,
            approvalsUpdate: async ({ request }) => {
                if (!stored) throw new Error('Missing approval');
                const transition = decideApprovalRequestTransition(stored, request);
                if (!transition.ok) return transition;
                persist(request);
                return { ok: true };
            },
            isApprovalExecutionOriginCurrent: async () => true,
            filesystemActionExecute: run,
            connectedServiceAction: run,
            sessionList: async () => run({ input }),
        });
        const daemon = createActionExecutor(boundary);
        const decider = createActionExecutor({ ...boundary,
            approvalRequestApprovedReplay: ({ artifactId, context }) =>
                daemon.replayApprovedApprovalRequest({ artifactId, callerAuthority: context.authority }),
        });
        const scope = { serverId: 'home-1', accountId: 'account-1' };
        const context = { serverId: scope.serverId, runtimeAccountId: scope.accountId, actionCaller: { kind: 'host' },
            defaultSessionId: 'session-1', defaultSessionMachineId: 'machine-1', sessionListAccess: 'current_session' } as const;
        const requestId = 'voice-tool-call-1';
        const pending = await daemon.execute(actionId, input, { ...context, surface: 'voice', authority: 'account_automation',
            actionRequestId: requestId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [actionId]: { approvalRequiredSurfaces: ['voice'] } },
            }),
        });
        expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1' } });
        expect(calls).toHaveLength(0);

        const observer = createActionApprovalContinuationObserver({ onExecuted: () => {} });
        try {
            const resumed = resumeActionExecutionResult({ result: pending, actionId, scope, requestId,
                onApprovalPending: registration => observer.requestApproval(registration) });
            const decision = await decider.execute('approval.request.decide', { artifactId: 'approval-1', decision: 'approve' },
                { ...context, surface: 'ui', authority: 'present_user' });
            expect(decision).toMatchObject({ ok: true, result: { status: 'executed',
                ...(projected ? { liveExecution: { ok: true, result: output } } : {}),
            } });
            expect(calls).toHaveLength(1);
            const request = StoredApprovalRequestSchema.parse(stored);
            expect(request.execution?.result).toEqual(projected ?? output);
            observer.observeArtifact({ id: 'approval-1', title: null, header: buildApprovalRequestArtifactHeaderV1(request),
                body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
                isDecrypted: true });
            observer.deliverSettlement();
            await expect(resumed).resolves.toEqual(outcome);
            expect(calls).toHaveLength(1);
        } finally {
            observer.dispose();
        }
    });
});
