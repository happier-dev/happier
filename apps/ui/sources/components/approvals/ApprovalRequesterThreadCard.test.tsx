import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storage';

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);

afterEach(async () => {
  await standardCleanup();
});

const THREAD = 'detailPages.approval.requester.thread';
const { ApprovalRequesterThreadCard } =
  await import('./ApprovalRequesterThreadCard');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');

const personalUse: ActionOperationCredentialUseV1 = {
  v: 1,
  kind: 'connected_account',
  label: 'Acme GitHub',
  owner: { kind: 'account', accountId: 'alice' },
  service: { pluginId: 'happier.integration.github', localId: 'github' },
  why: {
    kind: 'purpose_binding',
    purpose: {
      consumer: { pluginId: 'happier.integration.github', localId: 'issues' },
      purpose: 'write',
    },
    target: 'account',
  },
  currentness: { kind: 'current_at_materialization' },
};
const teamUse: ActionOperationCredentialUseV1 = {
  ...personalUse,
  kind: 'team_resource',
  label: null,
  owner: { kind: 'team', teamId: 'team-release' },
  currentness: { kind: 'current_at_materialization', resourceRevision: 3 },
};

const decided = (request: ApprovalRequestV2): ApprovalRequestV2 => ({
  ...request,
  status: 'approved',
  updatedAtMs: 20,
  decision: {
    kind: 'approve',
    decidedAtMs: 20,
    authority: 'present_user',
    decidingAccountId: 'bob',
  },
});

function approvalOf(
  settle?: (request: ApprovalRequestV2) => ApprovalRequestV2,
) {
  const [entry] = listDiscussionRequesterApprovals(
    [buildDiscussionRequesterApprovalArtifact({ settle })],
    { serverId: 'server-1', discussionId: 'discussion-1' },
  );
  if (!entry) throw new Error('Expected the requester approval');
  return entry;
}

const executed =
  (uses?: readonly ActionOperationCredentialUseV1[]) =>
  (request: ApprovalRequestV2): ApprovalRequestV2 => ({
    ...decided(request),
    status: 'executed',
    updatedAtMs: 30,
    execution: {
      executedAtMs: 30,
      ok: true,
      effectAttempted: true,
      result: { ok: true },
      ...(uses ? { operationCredentialUses: [...uses] } : {}),
    },
  });

async function renderCard(
  settle?: (request: ApprovalRequestV2) => ApprovalRequestV2,
  requesterAccountActor?: React.ComponentProps<typeof ApprovalRequesterThreadCard>['requesterAccountActor'],
) {
  return renderScreen(
    <ApprovalRequesterThreadCard
      approval={approvalOf(settle)}
      serverId="server-1"
      requesterAccountActor={requesterAccountActor}
    />,
  );
}

describe('ApprovalRequesterThreadCard operation actor', () => {
  it('names only the approval execution Machine as offline and keeps its request controls', async () => {
    const [approval] = listDiscussionRequesterApprovals([
      buildDiscussionRequesterApprovalArtifact({ actionId: 'session.stop' }),
    ], { serverId: 'server-1', discussionId: 'discussion-1' });
    if (!approval) throw new Error('Missing requester approval');
    const screen = await renderScreen(<ApprovalRequesterThreadCard approval={approval} serverId="server-1" />);
    expect(screen.findByTestId('approval-requester-thread-machine-offline')).toBeNull();
    await React.act(async () => getStorage().setState({
      machineListByServerId: { 'server-1': [createMachineFixture({ id: 'machine-1', active: false, activeAt: 1 })] },
      machineListStatusByServerId: { 'server-1': 'idle' },
    }));
    expect(screen.findByTestId('approval-requester-thread-machine-offline')).toBeTruthy();
    expect(screen.findByTestId('approval-requester-thread-open')).toBeTruthy();
    expect(screen.findByTestId('approval-requester-thread-waiting')).toBeTruthy();
  });

  it('keeps a stale refusal in the thread and opens its exact review in place', async () => {
    vi.spyOn(Modal, 'show').mockReturnValue('requester-review');
    const screen = await renderCard(request => ({ ...decided(request), status: 'failed', updatedAtMs: 30,
      execution: { executedAtMs: 30, ok: false, effectAttempted: false,
        errorCode: 'approval_stale', error: 'approval_stale' } }));
    expect(screen.findByTestId('approval-requester-thread-receipt-stale')).toBeTruthy();
    await screen.pressByTestIdAsync('approval-requester-thread-review-again');
    expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
      props: expect.objectContaining({ artifactId: approvalOf().artifact.id, serverId: 'server-1' }),
      chrome: expect.objectContaining({ phonePresentation: 'sheet' }),
    }));
    expect(screen.findByTestId('approval-requester-thread-approve')).toBeNull();
  });

  it('says the admitted credential the operation used, apart from who asked and who confirmed', async () => {
    const screen = await renderCard(executed([personalUse]));
    const line = screen.findByTestId(
      'approval-operation-actor',
    );
    expect(line).toBeTruthy();
    expect(screen.getTextContent()).toContain(t('detailPages.approval.requester.thread.using', { label: 'Acme GitHub' }));
    // The original outcome stays exact.
    expect(
      screen.findByTestId('approval-requester-thread-receipt-done'),
    ).toBeTruthy();
  });

  it.each([
    ['team', teamUse, t('detailPages.approval.requester.thread.ownerTeamUnnamed')],
    ['unreadable Account', personalUse, null],
  ] as const)('keeps %s owner and why behind the line until asked, without guessing an identity', async (_kind, use, ownerLabel) => {
    const screen = await renderCard(executed([use]));
    expect(screen.getTextContent()).not.toContain(`${THREAD}.ownerAccount`);
    expect(screen.getTextContent()).not.toContain(t('detailPages.approval.requester.thread.ownerTeamUnnamed'));
    expect(screen.getTextContent()).not.toContain(t('detailPages.approval.requester.thread.why'));
    await screen.pressByTestIdAsync(
      'approval-operation-actor',
    );
    if (ownerLabel) expect(screen.getTextContent()).toContain(ownerLabel);
    else expect(screen.getTextContent()).not.toContain(`${THREAD}.ownerAccount`);
    expect(screen.getTextContent()).toContain(t('detailPages.approval.requester.thread.why'));
  });

  it('names an unlabeled Team resource by its kind, never by a guessed identity', async () => {
    const screen = await renderCard(executed([teamUse]));
    expect(screen.getTextContent()).toContain(t('detailPages.approval.requester.thread.usingTeam'));
    expect(screen.getTextContent()).not.toContain('Acme GitHub');
  });

  it('draws nothing without admitted evidence, and never from the execution Account', async () => {
    for (const settle of [undefined, decided, executed(undefined)]) {
      const screen = await renderCard(settle);
      expect(
        screen.findByTestId('approval-operation-actor'),
      ).toBeNull();
      expect(
        screen.findByTestId('approval-requester-thread-writes-with'),
      ).toBeNull();
      expect(screen.getTextContent()).not.toContain(`${THREAD}.using`);
      expect(screen.getTextContent()).not.toContain('writesWith');
    }
  });

  it('uses the enclosing Discussion actor relationship for a settled former requester', async () => {
    const screen = await renderCard(executed(undefined), {
      v: 1,
      accountId: 'bob',
      accessibility: 'former',
      profile: { name: 'Still visible Bob', firstName: null, lastName: null, username: null, avatarUrl: null },
    });
    expect(screen.getTextContent()).toContain(t('message.accountActorFormerMember'));
    expect(screen.getTextContent()).not.toContain(`${THREAD}.anotherPerson`);
  });
});
