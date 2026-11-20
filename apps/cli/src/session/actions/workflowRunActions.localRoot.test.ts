import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { createInMemoryReviewRecordPortV1 } from '../../../../../packages/protocol/src/reviews/reviewArtifactV1.testkit';
import { ActionSessionAddressV1Schema } from '@happier-dev/protocol';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createWorkflowRunActionOwner } from './workflowRunActions';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { ActionExecutorContext } from '@happier-dev/protocol';

describe('local root Review requester', () => {
  it.each(['person', 'missing-custody', 'stale', 'foreign-account', 'foreign-home', 'foreign-machine', 'foreign-installation', 'nonlocal-session', 'autonomous', 'agent'] as const)(
    'retains only an authenticated current person through private root ingress (%s)', async scenario => {
      let storage: WorkflowRunStorageTestkit | undefined;
      let childRunId = '';
      let observedContext: ActionExecutorContext | undefined;
      const host = {
        nativeAccount: { accountId: scenario === 'foreign-account' ? 'other-account' : 'account-1', serverId: 'profile',
          isCurrent: async () => scenario !== 'stale' },
        serverIdentityId: scenario === 'foreign-home' ? 'other-home' : 'home',
        hostExecutionTarget: { machineId: scenario === 'foreign-machine' ? 'other-machine' : 'machine-local',
          installationId: scenario === 'foreign-installation' ? 'other-installation' : 'installation' },
      };
      const owner = createWorkflowRunActionOwner({ ...host,
        resolveAccountId: async () => 'account-1',
        storage: { execute: async operation => {
          if (!storage && operation.operation === 'admit') {
            childRunId = operation.runId;
            storage = createWorkflowRunStorageTestkit({ runId: childRunId, machineId: 'machine-local', origin: { kind: 'direct' } });
          }
          if (!storage) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found', response: { status: 404 } });
          return storage.execute(operation);
        } },
        definitions: { get: async () => { throw new Error('no_saved_workflow'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
          machineId: 'machine-local', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: {
          resolveTargetAvailability: async () => true,
          resolveSessionTarget: async value => ({ address: ActionSessionAddressV1Schema.parse(value), machineId: 'machine-local' }),
          readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
        } }),
      });
      const records = createInMemoryReviewRecordPortV1();
      const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'review.start': ['cli', 'mcp'], 'workflow.run.start': ['cli', 'mcp'],
      } });
      const executor = createActionExecutor({ reviewRecords: () => records,
        actionAutomations: createActionAutomationPortV1({ accountId: 'account-1', seed: async () => ({ v: 1, rows: [] }), settle: async () => [] }),
        sessionStatusGet: async ({ sessionId }) => ({ session: { id: sessionId, createdAt: 1, updatedAt: 1,
          active: true, activeAt: 1, encryption: null, path: '/repo', machineId: 'machine-local' } }),
        workflowAction: async args => {
          observedContext = args.context;
          return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs: owner })(args);
        },
      });
      // The private HTTP listener and immutable storage are real boundaries.
      // Root authentication, custody stamping, Review composition and origin admission stay real.
      const app = createDaemonControlApp({ machineId: 'machine-local', controlToken: 'private-token', getChildren: () => [],
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        externalActionApi: { currentServerId: 'profile', currentAccountId: 'account-1',
          verifyPat: async () => null,
          resolveTarget: async ({ target }) => scenario === 'nonlocal-session' ? null : target ?? { kind: 'machine', machineId: 'machine-local' },
          ...(scenario === 'missing-custody' ? {} : {
            resolvePluginExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine-local' }),
            resolveInstallationId: () => 'installation',
          }),
          executor: { execute: async (actionId, input, context) => executor.execute(actionId, input, { ...context, actionsSettings: settings }) },
        },
      });
      try {
        const payload = { actionId: 'review.start', actionRequestId: 'person-review',
          target: { kind: 'machine', machineId: 'machine-local', project: { machineId: 'machine-local', directory: '/repo' } },
          input: { sessionId: 'origin-session', cwd: '/repo', scope: 'repository', instructions: 'Review without changes.', reviewers: [
            { kind: 'session', session: { sessionId: 'origin-session', serverId: 'profile' } },
          ], steps: [{ kind: 'review', instructions: 'Review without changes.', reviewers: [{ kind: 'session', session: { sessionId: 'origin-session', serverId: 'profile' } }] }] },
          ...(scenario === 'agent' ? { surface: 'mcp' } : {}),
        };
        const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
          headers: { 'x-happier-daemon-token': 'private-token',
            ...(scenario === 'autonomous' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) }, payload });
        expect(response.statusCode).toBe(200);
        if (scenario === 'nonlocal-session') {
          expect(response.json()).toMatchObject({ ok: false, errorCode: 'target_not_local' });
          expect(storage).toBeUndefined();
          return;
        }
        expect(response.json(), response.body).toMatchObject({ ok: true });
        const envelope = storage?.acceptedEnvelope();
        if (!envelope) throw new Error('accepted_envelope_missing');
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: childRunId },
          envelope: parseWorkflowStoredContentEnvelopeV1(envelope) });
        if (opened.kind !== 'available') throw new Error('accepted_envelope_unavailable');
        const starter = opened.content.origin?.authenticatedStarterV1;
        const confirmation = resolveApprovalRequesterConfirmationV1({ actionId: 'reviews.comments.setDisposition', input: {}, required: false,
          context: { surface: 'agent', serverId: 'profile', serverIdentityId: 'home', runtimeAccountId: 'account-1', defaultSessionId: 'origin-session',
            actionCaller: { kind: 'workflowRun', runId: childRunId, authorization: opened.content.authorization,
              ...(starter ? { authenticatedStarterV1: starter } : {}) } } });
        if (scenario === 'person') {
          const diagnostic = observedContext && { surface: observedContext.surface, authority: observedContext.authority,
            caller: observedContext.actionCaller?.kind, serverId: observedContext.serverId, runtimeAccountId: observedContext.runtimeAccountId,
            identity: selectHostRequesterExecutionIdentity({ actionContext: observedContext, hostHomeServerIdentityId: host.serverIdentityId,
              hostCustodianAccountId: host.nativeAccount.accountId, hostExecutionTarget: host.hostExecutionTarget }) };
          expect({ starter, confirmation }, JSON.stringify(diagnostic)).toMatchObject({ starter: { requestRef: expect.any(String), requester: { serverId: 'home', accountId: 'account-1' } },
            confirmation: { ok: true } });
        } else {
          expect(starter).toBeUndefined();
          expect(confirmation).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
        }
        const forged = await app.inject({ method: 'POST', url: '/actions/root/execute',
          headers: { 'x-happier-daemon-token': 'private-token' }, payload: { ...payload,
            authenticatedLocalRootCustody: { serverIdentityId: 'home', accountId: 'account-1', machineId: 'machine-local', installationId: 'installation' } } });
        expect(forged.statusCode).toBe(400);
      } finally { await app.close(); }
    });
});
