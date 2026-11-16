import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectArtifactDocumentV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { DeploymentReceiptAcceptedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

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
  it.each([
    { index: 0, actionId: 'deployments.rollback', input: { ...rollback, restoreBackupId: 'backup' } },
    { index: 1, actionId: 'deployments.rollback', input: rollback },
    { index: 2, actionId: 'inbox.notice.dismiss', input: {
      artifactId, expectedRevision: { headerVersion: 3, bodyVersion: 2 },
    } },
  ])('runs choice $index with its fresh notice revision and settles the controls', async ({ index, actionId, input }) => {
    const entry = failedDeploymentNotice();
    const artifact = projectArtifactDocumentV1({ ...entry.artifact, artifactId,
      revision: { headerVersion: entry.artifact.headerVersion, bodyVersion: entry.artifact.bodyVersion } });
    const result = createDeferred<ActionExecuteResult>();
    // Only Action transport is substituted; parsing, fresh-read validation and choice routing stay real.
    const execute = vi.fn(async (requestedAction: string): Promise<ActionExecuteResult> => requestedAction === 'artifact.get'
      ? { ok: true, result: { artifact } }
      : result.promise);
    const recovery = createAccountNoticeInvestigation({ scope, execute: createFrontDoorActionExecute({ execute }), isCurrent: () => true });
    const screen = await renderScreen(<AccountNoticeRecoveryChoices entry={entry} recovery={recovery} testID="notice.recovery" />);
    expect(screen.getTextContent()).toContain('Restore backup and roll back code');
    expect(screen.getTextContent()).toContain('Roll back code only');
    expect(screen.getTextContent()).toContain('Keep and fix forward');
    await screen.pressByTestIdAsync(`notice.recovery.choice.${index}`);
    await vi.waitFor(() => expect(execute).toHaveBeenLastCalledWith(actionId, input, expect.anything()));
    expect(execute).toHaveBeenNthCalledWith(1, 'artifact.get', { artifactId }, expect.anything());
    for (const choiceIndex of [0, 1, 2]) {
      expect(screen.findHostByTestId(`notice.recovery.choice.${choiceIndex}`)?.props.accessibilityState?.disabled).toBe(true);
    }
    result.resolve({ ok: true, result: actionId === 'inbox.notice.dismiss'
      ? { artifactId, status: 'dismissed' }
      : DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment', deploymentId: 'recovery-deployment',
        revision: 2, deploymentRevision: 1, state: 'running' }) });
    await vi.waitFor(() => expect(screen.findHostByTestId(`notice.recovery.choice.${index}`)?.props.accessibilityState?.disabled).toBe(false));
    expect(Modal.alert).not.toHaveBeenCalled();
  });

  it('shows a fresh-read refusal without running the offered recovery', async () => {
    // The Action transport is the boundary; the notice owner re-reads the notice before it runs a choice.
    const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    }));
    const recovery = createAccountNoticeInvestigation({
      scope,
      execute: createFrontDoorActionExecute({ execute }),
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
    expect(execute).toHaveBeenCalledOnce();
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
      execute: createFrontDoorActionExecute({ execute: vi.fn() }),
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
