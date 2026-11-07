import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { qualifyTranscriptAccountActor } from '@happier-dev/session-core/messages';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import { t } from '@/text';

import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);

afterEach(async () => {
  await standardCleanup();
});

const { ApprovalRequesterConfirmationSection } = await import(
  './ApprovalRequesterConfirmationSection'
);

const use: ActionOperationCredentialUseV1 = {
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

function subject() {
  const [entry] = listDiscussionRequesterApprovals(
    [buildDiscussionRequesterApprovalArtifact({})],
    { serverId: 'server-1', discussionId: 'discussion-1' },
  );
  if (!entry) throw new Error('Expected the requester approval');
  return entry.subject;
}

const decision = { kind: 'approve', decidingAccountId: 'bob' } as const;

describe('ApprovalRequesterConfirmationSection operation actor', () => {
  it('uses the resource-scoped Account actor when the global profile cache has no requester', async () => {
    const approvalSubject = subject();
    const requesterAccountActor = qualifyTranscriptAccountActor({
      v: 1,
      accountId: approvalSubject.requesterAccountId,
      accessibility: 'current',
      profile: {
        name: 'QA N3 Bob',
        firstName: null,
        lastName: null,
        username: 'qa-n3b',
        avatarUrl: null,
      },
    }, 'server-1');
    if (!requesterAccountActor) throw new Error('Expected a qualified Account actor');

    const screen = await renderScreen(
      <ApprovalRequesterConfirmationSection
        subject={approvalSubject}
        serverId="server-1"
        requesterAccountActor={requesterAccountActor}
        decidingAccountActor={requesterAccountActor}
        open={false}
        decision={{ kind: 'approve', decidingAccountId: approvalSubject.requesterAccountId }}
      />,
    );

    expect(screen.getTextContent()).toContain('QA N3 Bob');
    expect(screen.getTextContent()).not.toContain(
      'detailPages.approval.requester.anotherPerson',
    );
  });

  it('lets the canonical presenter replace a retained profile with Former member', async () => {
    const approvalSubject = subject();
    const requesterAccountActor = qualifyTranscriptAccountActor({
      v: 1,
      accountId: approvalSubject.requesterAccountId,
      accessibility: 'former',
      profile: {
        name: 'Retained Bob',
        firstName: null,
        lastName: null,
        username: 'qa-n3b',
        avatarUrl: null,
      },
    }, 'server-1');
    if (!requesterAccountActor) throw new Error('Expected a qualified Account actor');

    const screen = await renderScreen(
      <ApprovalRequesterConfirmationSection
        subject={approvalSubject}
        serverId="server-1"
        requesterAccountActor={requesterAccountActor}
        open={false}
        decision={null}
      />,
    );

    expect(screen.getTextContent()).toContain(t('message.accountActorFormerMember'));
    expect(screen.getTextContent()).not.toContain('Retained Bob');
  });

  it('names the admitted credential through the one operation-actor line, not the execution Account', async () => {
    const screen = await renderScreen(
      <ApprovalRequesterConfirmationSection
        subject={subject()}
        serverId="server-1"
        open={false}
        decision={decision}
        operationCredentialUses={[use]}
      />,
    );
    expect(screen.findByTestId('approval-operation-actor')).toBeTruthy();
    expect(screen.getTextContent()).toContain(
      t('detailPages.approval.requester.thread.using', { label: 'Acme GitHub' }),
    );
    expect(
      screen.findByTestId('approvals.requester-confirmation.writes-with'),
    ).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('setupOf');
  });

  it('shows the execution Account independently of the asker and the exact reviewed Action', async () => {
    const screen = await renderScreen(
      <ApprovalRequesterConfirmationSection
        subject={subject()}
        serverId="server-1"
        open
        decision={null}
        actionId="session.title.set"
      />,
    );
    expect(screen.findByTestId('approvals.requester-confirmation.runs-as')).toBeTruthy();
    expect(screen.findByTestId('approvals.requester-confirmation.action')).toBeTruthy();
    expect(screen.getTextContent()).toContain('session.title.set');
    expect(screen.findByTestId('approvals.requester-confirmation.writes-with')).toBeNull();
  });

  it('draws no actor row without admitted evidence', async () => {
    for (const operationCredentialUses of [undefined, []]) {
      const screen = await renderScreen(
        <ApprovalRequesterConfirmationSection
          subject={subject()}
          serverId="server-1"
          open
          decision={null}
          operationCredentialUses={operationCredentialUses}
        />,
      );
      expect(screen.findByTestId('approval-operation-actor')).toBeNull();
      expect(
        screen.findByTestId('approvals.requester-confirmation.asked-by'),
      ).toBeTruthy();
      expect(screen.findByTestId('approvals.requester-confirmation.writes-with')).toBeNull();
      expect(screen.findByTestId('approvals.requester-confirmation.action')).toBeNull();
    }
  });
});
