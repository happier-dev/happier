import { expect, it } from 'vitest';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { createSignedRootActionApprovalAcknowledgement } from './signedRootActionApproval';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { executeLiveCliApprovalRequest } from '@/session/actions/approvals/deferredResult';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

it.each(['teams.invitations.create', 'teams.invitations.reissue', 'connectedServices.authentication.continueConnect'] as const)(
  'settles %s approval and returns its live result to the original CLI', async actionId => {
  const owner = createSignedRootActionApprovalAcknowledgement();
  const coordinator = createBlockingApprovalCoordinator();
  const controller = new AbortController();
  const invitation = { id: 'invitation-1', teamId: 'team-1', state: 'active' as const,
    role: 'member' as const, historyAccess: 'from_membership' as const, recipientEmailMask: null,
    expiresAt: 2, createdAt: 1, createdByAccountId: 'account-1', acceptedByAccountId: null, lastEmailDelivery: null };
  const joinUrl = 'https://home.example/join/private-original-caller';
  const output = actionId === 'teams.invitations.create' ? { invitation, joinUrl }
    : actionId === 'teams.invitations.reissue'
      ? { previous: { ...invitation, state: 'revoked' as const }, replacement: invitation, joinUrl }
      : { status: 'awaitingManual' as const, attemptId: 'ff75bf64-23c1-4344-a6fc-dcc2ea2ddcdf' };
  const input = actionId === 'teams.invitations.create'
    ? { v: 1, teamId: 'team-1', role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: 'request-1' }
    : actionId === 'teams.invitations.reissue'
      ? { v: 1, teamId: 'team-1', invitationId: 'invitation-1', recipientEmail: null, requestKey: 'request-1' }
      : { attemptId: 'ff75bf64-23c1-4344-a6fc-dcc2ea2ddcdf',
        expectedConfigurationRevision: 'connected-account-configuration-dd890a21-07e4-47cd-b6ac-3d33ed894f74' };
  let stored: ApprovalRequest | null = null;
  const persisted: ApprovalRequest[] = [];
  const executor = createActionExecutor({
    // Home HTTP and Artifact persistence are the boundaries; the approval
    // router, transitions, live waiter and deciding Action remain real.
    homeDomainAction: async () => output,
    connectedServiceAction: async () => output,
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(request);
      persisted.push(stored);
      return { artifactId: 'invitation-approval' };
    },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      if (!stored) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const transition = decideApprovalRequestTransition(stored, request);
      if (!transition.ok) return transition;
      stored = ApprovalRequestV2Schema.parse(request);
      persisted.push(stored);
      return { ok: true };
    },
    approvalsWaitForDecision: args => coordinator.waitForDecision(args),
    approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
    isApprovalExecutionOriginCurrent: async () => true,
  });
  const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'request-1', signal: controller.signal,
  } satisfies ActionExecutorContext;
  const notices: string[] = [];
  const execution = executeLiveCliApprovalRequest({ context, execute: executor.execute,
    onApprovalRequested: async (artifactId, _signal, decide) => {
      notices.push(artifactId);
      return await decide('approve');
    },
    run: (signal, onApprovalRequested) => owner.execute({ actionId, surface: 'cli', signal, onApprovalRequested,
      run: (signal, operationOwnerUpdate) => executor.execute(actionId, input, { ...context, signal, operationOwnerUpdate }),
    }),
  });
  try {
    await expect.poll(() => notices).toEqual(['invitation-approval']);
    await expect(execution).resolves.toEqual({ ok: true, result: output });
    expect(stored).toMatchObject({ status: 'executed' });
    expect(JSON.stringify(persisted)).not.toContain(joinUrl);
  } finally {
    controller.abort();
    await execution;
    coordinator.dispose();
    await owner.close();
  }
});

it.each(['connectedServices.authentication.beginConnect', 'connectedServices.authentication.submitManual', 'connectedServices.authentication.completeOAuth'] as const)(
  'reports %s approval while retaining its live result on the original request', async actionId => {
  const owner = createSignedRootActionApprovalAcknowledgement();
  const approval = { kind: 'approval_request_created' as const, artifactId: 'manual-approval',
    actionId };
  let release!: () => void;
  const completion = new Promise<void>(resolve => { release = resolve; });
  const notices: unknown[] = [];
  let settled = false;
  const result: ActionExecuteResult = { ok: true, result: { status: 'connected', attemptId: 'manual-attempt' } };
  const execution = owner.execute({ actionId: approval.actionId, surface: 'cli', signal: new AbortController().signal,
    onApprovalRequested: notice => { notices.push(notice); },
    // The injected execution port represents admitted native work. Keep its
    // approval publication and effect completion in their real order.
    run: async (_signal, progress) => {
      progress?.update({ progress: { phase: 'waiting_for_approval', approval } });
      await completion;
      return result;
    },
  });
  void execution.then(() => { settled = true; });
  try {
    await expect.poll(() => notices.length > 0 || settled).toBe(true);
    expect(settled).toBe(false);
    expect(notices).toEqual([approval]);
    release();
    await expect(execution).resolves.toEqual(result);
  } finally { release(); await execution; await owner.close(); }
});

it('cancels the original transport and preserves a prompt failure', async () => {
  const failure = new Error('Terminal prompt failed');
  const executor = createActionExecutor({});
  let cancelled = false;
  await expect(executeLiveCliApprovalRequest({ context: { surface: 'cli' }, execute: executor.execute,
    onApprovalRequested: async () => { throw failure; },
    run: (signal, notify) => new Promise<ActionExecuteResult | null>(resolve => {
      signal.addEventListener('abort', () => {
        cancelled = true;
        resolve({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
      }, { once: true });
      notify({ kind: 'approval_request_created', artifactId: 'manual-approval',
        actionId: 'connectedServices.authentication.submitManual' });
    }),
  })).rejects.toBe(failure);
  expect(cancelled).toBe(true);
});

it('cancels the original transport when the prompt returns an approval failure', async () => {
  const failure = { ok: false as const, errorCode: 'approval_not_found', error: 'approval_not_found' };
  const executor = createActionExecutor({});
  await expect(executeLiveCliApprovalRequest({ context: { surface: 'cli' }, execute: executor.execute,
    onApprovalRequested: async () => failure,
    run: (signal, notify) => new Promise<ActionExecuteResult | null>(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'cancelled', error: 'cancelled' }), { once: true });
      notify({ kind: 'approval_request_created', artifactId: 'manual-approval',
        actionId: 'connectedServices.authentication.submitManual' });
    }),
  })).resolves.toEqual(failure);
});
