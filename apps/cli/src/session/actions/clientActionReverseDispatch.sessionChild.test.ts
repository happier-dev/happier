import { describe, expect, it } from 'vitest';
import {
  createActionExecutor,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { UiActionDispatchResultV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createClientActionReverseDispatcher } from './clientActionReverseDispatch';
import { executeAdmittedClientActionChild } from './admittedClientActionChildren';

const address = {
  scope: { serverId: 'home', accountId: 'account-a' },
  draftId: 'draft-1',
};
const leaf = {
  kind: 'session' as const,
  sessionId: 'leaf-session',
  starterDepth: 2,
  turnDepth: 3,
};
const attribution = {
  requester: { serverId: 'home', accountId: 'account-a' },
  persona: { serverId: 'home', sessionId: 'origin-session' },
  origin: null,
};
// The Home-verified Session-leaf caller this daemon admitted for the parent save.
const parent = {
  surface: 'agent',
  authority: 'account_automation',
  serverId: 'home',
  runtimeAccountId: 'account-a',
  actionCaller: leaf,
  defaultSessionId: leaf.sessionId,
  actionRequestId: 'parent-save',
  executionRunWorkflowRunId: 'run-1',
  actionRequestAttributionV1: attribution,
  bypassApprovals: true,
} as unknown as ActionExecutorContext;
// The server stamps the calling App's Account on every Machine RPC.
const admittedBy = (accountId: string) => ({
  machineAdmission: {
    actorAccountId: accountId,
    custodianAccountId: 'account-a',
    machineId: 'machine-a',
    installationId: 'installation-a',
    role: 'manage',
    encryptionMode: 'e2ee',
  },
});
const child = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  parentRequestId: 'parent-save',
  sessionId: leaf.sessionId,
  actionId: 'workflow.definition.delete',
  input: { definitionId: 'review-daily' },
  ...overrides,
});

describe('admitted client Action Session children', () => {
  it('admits a Session-leaf Workflow child with Session and requester attribution only while its parent is pending', async () => {
    const children: ActionExecutorContext[] = [];
    const refusals: UiActionDispatchResultV1[] = [];
    const socketFailures: string[] = [];
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      // The child's own policy is evaluated (cli-green-4.log: approvals_not_supported
      // without this, so the parent's bypass is not inherited); here it admits.
      isActionApprovalRequired: () => false,
      workflowAction: async ({ actionId, input, context }) => {
        if (actionId !== 'workflow.definition.delete')
          throw new Error(`unexpected ${actionId}`);
        children.push(context);
        return {
          deleted: true,
          definitionId: (input as { definitionId: string }).definitionId,
        };
      },
      clientActionExecute: createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: (method) =>
          method === workflowDraftClientRpcMethod(address),
        callConnectedClientRpc: async (method, payload, options) => {
          try {
          expect(method).toBe(workflowDraftClientRpcMethod(address));
          expect(
            UiActionDispatchRequestV1Schema.parse(payload).context,
          ).toMatchObject({
            actionRequestId: 'parent-save',
            actionCaller: leaf,
          });
          options.onIssued();
          // The App's Save returns its Workflow child to this pending parent.
          refusals.push(
            await executeAdmittedClientActionChild(
              child({ sessionId: 'other-session' }),
              admittedBy('account-a'),
            ),
          );
          refusals.push(
            await executeAdmittedClientActionChild(
              child(),
              admittedBy('account-b'),
            ),
          );
          refusals.push(
            await executeAdmittedClientActionChild(
              child({ parentRequestId: 'unadmitted-save' }),
              admittedBy('account-a'),
            ),
          );
          refusals.push(
            await executeAdmittedClientActionChild(child(), undefined),
          );
          const admitted = await executeAdmittedClientActionChild(
            child(),
            admittedBy('account-a'),
          );
          if (!admitted.execution.ok) socketFailures.push(JSON.stringify(admitted.execution));
          expect(admitted).toEqual({
            v: 1,
            execution: {
              ok: true,
              result: { deleted: true, definitionId: 'review-daily' },
            },
          });
          return {
            ok: true,
            result: {
              v: 1,
              execution: { ok: true, result: { status: 'applied' } },
            },
          };
          } catch (error) {
            // Surface the in-delivery assertion rather than the dispatcher's transport mapping.
            socketFailures.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      })),
    });

    const saved = await executor.execute('workflow.authoring.draft.save', address, parent);
    expect(socketFailures).toEqual([]);
    expect(saved).toEqual({ ok: true, result: { status: 'applied' } });
    const refused = {
      v: 1,
      execution: {
        ok: false,
        errorCode: 'admission_unavailable',
        error: 'admission_unavailable',
      },
    };
    expect(refusals).toEqual([refused, refused, refused, refused]);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: leaf,
      defaultSessionId: leaf.sessionId,
      executionRunWorkflowRunId: 'run-1',
      actionRequestAttributionV1: attribution,
    });
    expect(children[0]!.actionRequestId).toEqual(expect.any(String));
    expect(children[0]!.actionRequestId).not.toBe('parent-save');
    expect(children[0]!.bypassApprovals).not.toBe(true);
    // Settlement withdraws the parent at the next natural boundary.
    expect(
      await executeAdmittedClientActionChild(child(), admittedBy('account-a')),
    ).toEqual(refused);
    expect(children).toHaveLength(1);
  });

  it('refuses a child outside the Machine-admitted Workflow family before any parent lookup', async () => {
    expect(
      await executeAdmittedClientActionChild(
        child({ actionId: 'workflow.run.start', input: {} }),
        admittedBy('account-a'),
      ),
    ).toEqual({
      v: 1,
      execution: {
        ok: false,
        errorCode: 'invalid_action_input',
        error: 'invalid_action_input',
      },
    });
  });
});
