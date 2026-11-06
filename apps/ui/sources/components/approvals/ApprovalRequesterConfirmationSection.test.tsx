import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';

import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({
  text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
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
      'detailPages.approval.requester.thread.using(label=Acme GitHub)',
    );
    expect(
      screen.findByTestId('approvals.requester-confirmation.writes-with'),
    ).toBeNull();
    expect(screen.getTextContent()).not.toContain('setupOf');
    expect(screen.getTextContent()).not.toContain('writesWith');
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
      expect(screen.getTextContent()).not.toContain('writesWith');
    }
  });
});
