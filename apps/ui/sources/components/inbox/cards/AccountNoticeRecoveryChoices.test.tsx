import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

afterEach(() => {
  standardCleanup();
});

const { AccountNoticeRecoveryChoices } =
  await import('./AccountNoticeRecoveryChoices');
const { createAccountNoticeInvestigation } =
  await import('@/hooks/inbox/accountNoticeInvestigation');
const { readAccountNoticeArtifactHeader } =
  await import('@/sync/domains/artifacts/usageNoticeArtifacts');
const { Modal } = await import('@/modal');

const scope = { serverId: 'home-a', accountId: 'account-a' } as const;
const artifactId = '11111111-1111-4111-8111-111111111111';
const rollback = {
  serverId: scope.serverId,
  environmentId: 'environment',
  expectedRevision: 1,
  requestKey: 'recover',
  targetLinkId: 'runtime',
  expectedTargetLinkRevision: 1,
  deploymentId: 'previous',
  contentArtifactId: 'content',
  contentHeaderVersion: 1,
  contentBodyVersion: 1,
};

function failedDeploymentNotice() {
  const artifact = createAccountNoticeArtifactFixture({
    id: artifactId,
    header: {
      title: 'checkout-api failed to deploy',
      source: {
        kind: 'host',
        topic: 'service_health',
        subject: {
          kind: 'environment',
          environmentId: 'environment',
          targetLinkId: 'runtime',
          condition: 'deployment_failed',
        },
      },
      page: {
        kind: 'host',
        page: 'environment',
        targetLinkId: 'runtime',
        environment: {
          serverId: scope.serverId,
          projectSourceId: 'project',
          environmentId: 'environment',
        },
      },
      type: 'blocked',
      healthPhase: 'open',
      recoveryChoices: [
        {
          actionId: 'deployments.rollback',
          input: { ...rollback, restoreBackupId: 'backup' },
          label: 'Restore backup and roll back code',
        },
        {
          actionId: 'deployments.rollback',
          input: rollback,
          label: 'Roll back code only',
        },
        {
          actionId: 'inbox.notice.dismiss',
          input: { artifactId },
          label: 'Keep and fix forward',
        },
      ],
    },
  });
  const header = readAccountNoticeArtifactHeader(artifact, scope.accountId);
  if (!header) throw new Error('Unreadable notice fixture');
  return { artifact, header };
}

// COR5B-OPS-STORE-1115: a notice's offered recovery choices had no renderer in the Inbox.
describe('Inbox notice recovery choices', () => {
  it('offers each recovery choice the notice carries and presses through the notice owner', async () => {
    // The Action transport is the boundary; the notice owner re-reads the notice before it runs a choice.
    const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    }));
    const recovery = createAccountNoticeInvestigation({
      scope,
      execute,
      isCurrent: () => true,
    });
    const screen = await renderScreen(
      <AccountNoticeRecoveryChoices
        entry={failedDeploymentNotice()}
        recovery={recovery}
        testID="notice.recovery"
      />,
    );
    expect(screen.getTextContent()).toContain(
      'Restore backup and roll back code',
    );
    expect(screen.getTextContent()).toContain('Roll back code only');
    expect(screen.getTextContent()).toContain('Keep and fix forward');
    await screen.pressByTestIdAsync('notice.recovery.choice.2');
    expect(execute).toHaveBeenCalledWith(
      'artifact.get',
      { artifactId },
      expect.anything(),
    );
    const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]
      ?.find(button => button.text === 'approvals.technicalDetails');
    expect(details).toBeDefined();
    details!.onPress?.();
    expect(Modal.alert).toHaveBeenLastCalledWith(
      'approvals.technicalDetails', 'action_disabled',
    );
  });

  it('draws nothing for a notice without recovery choices', async () => {
    const recovery = createAccountNoticeInvestigation({
      scope,
      execute: vi.fn(),
      isCurrent: () => true,
    });
    const artifact = createAccountNoticeArtifactFixture({ id: artifactId });
    const header = readAccountNoticeArtifactHeader(artifact, scope.accountId)!;
    const screen = await renderScreen(
      <AccountNoticeRecoveryChoices
        entry={{ artifact, header }}
        recovery={recovery}
        testID="notice.recovery"
      />,
    );
    expect(screen.getTextContent()).toBe('');
  });
});
