import { expect, it } from 'vitest';
import { GITHUB_TRIAGE_ACTION_IDS_V1, PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-github/manifest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';
import { settleTargetActionExecution } from './targetActionSettlement';

it('replays a GitHub issue write approved from the Inbox after the Agent turn ends', async () => {
  const localId = GITHUB_TRIAGE_ACTION_IDS_V1.create;
  const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === localId)!;
  const input = {
    v: 1,
    instance: {
      ...createTriageSourceV1Fixture().configuredInstance,
      configuration: { v: 1, token: 'fixture-source-selection' },
    },
    kindId: 'issue',
    fields: { scopeId: 'octo/example', title: 'Fix launch' },
  };
  const artifactId = 'github-issue-inbox-approval';
  const turn = new AbortController();
  const turnEnded = 'Agent turn ended';
  let stored: TargetActionApprovalRequestV1 | null = null;
  const read = async () => stored && structuredClone(stored);
  const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
    if (!stored) throw new Error('Missing approval Artifact');
    const transition = admitTargetActionApprovalTransition(stored, request);
    if (transition.ok) stored = TargetActionApprovalRequestV1Schema.parse(request);
    return transition;
  };

  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    create: async request => {
      stored = request;
      turn.abort(turnEnded);
      return { artifactId };
    },
    read, update,
  });
  await requestCurrentIntent({
    action: {
      qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${localId}`,
      pluginId: PLUGIN_MANIFEST.id, localId, occurrenceId: 'github-fixture',
      sourceCustody: { kind: 'development', registeredRootId: 'github-fixture-root' },
      dangerLevel: declaration.dangerLevel, scopes: declaration.scopes, surfaces: declaration.surfaces,
      hostAccess: [], input, policyFingerprint: 'a'.repeat(64),
      confirmation: declaration.confirmation, secretInputPaths: declaration.secretInputPaths,
    },
    fingerprint: 'b'.repeat(64), surface: 'agent', signal: turn.signal,
    replayPlacement: { serverId: 'home', machineId: 'machine' },
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== turnEnded) throw error;
  });
  expect(stored).toMatchObject({ status: 'open' });

  const effects: unknown[] = [];
  const inbox = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    targetActionApprovalReplay: createTargetActionApprovalDecision({
      read, update,
      // Stand in for the daemon write effect. Approval, claim and receipt
      // transitions use their production owners.
      executeApproved: async ({ request, persist, nextTimestamp }) => {
        const claim = { ...request, status: 'executing' as const, updatedAtMs: nextTimestamp(request) };
        const failure = await persist(claim);
        if (failure) return failure;
        effects.push(request.input);
        return settleTargetActionExecution({
          request: claim, result: { ok: true, result: { written: true } },
          operationCredentialUses: [], persist, executedAtMs: nextTimestamp(claim),
        });
      },
    }),
  });
  const decision = await inbox.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
    surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
  });
  expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
  expect(stored).toMatchObject({ status: 'executed' });
  expect(effects).toEqual([input]);
});
