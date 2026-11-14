import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useFleetActivityPage } = await import('./useFleetActivityPage');

beforeEach(() => homes.reset());
afterEach(() => standardCleanup());

it('reads Activity only while presented, and keeps the rows it read once hidden', async () => {
  const serverId = await homes.addHome({
    name: 'Activity',
    serverUrl: 'https://fleet-activity.test',
    accountId: 'account-owner',
    accountEncryptionMode: 'plain',
  });
  const detail = createDeploymentEnvironmentDetailV1({
    environment: createDeploymentEnvironmentHeaderV1({ serverId }),
  });
  const receipt = createDeploymentReceiptDetailV1();
  const { captureLazyActionAccountContext } =
    await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  try {
    await account.createArtifactDocument({
      artifactId: detail.environment.contentArtifactId,
      header: {
        kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
        title: detail.content.name,
      },
      body: JSON.stringify(detail.content),
    });
    await account.createArtifactDocument({
      artifactId: receipt.deployment.contentArtifactId,
      header: {
        kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
        title: 'Deploy',
        steps: receipt.content.steps,
      },
      body: JSON.stringify(receipt.content),
    });
  } finally {
    account.dispose();
  }
  const root = '/v1/deployments/environments';
  let environmentReads = 0;
  homes.answer(serverId, root, {
    select: async () => {
      environmentReads++;
      return {
        body: { ok: true, items: [detail.environment], nextCursor: null },
      };
    },
  });
  homes.answer(serverId, `${root}/${detail.environment.id}`, { body: { ok: true, environment: detail.environment,
    targetLinks: detail.targetLinks.map((item) => item.targetLink) } });
  homes.answer(serverId, `${root}/${detail.environment.id}/deployments`, {
    body: { ok: true, items: [receipt.deployment], nextCursor: null },
  });
  const lifetime: ServerAccountScopeLifetime = {
    scope: { serverId, accountId: 'account-owner' },
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
  };

  const hook = await renderHook(
    (presented: boolean) => useFleetActivityPage(lifetime, [], presented),
    { initialProps: false },
  );
  await flushHookEffects();
  expect(environmentReads).toBe(0);
  expect(hook.getCurrent().state.status).toBe('loading');

  await hook.rerender(true);
  for (
    let attempt = 0;
    attempt < 50 && hook.getCurrent().state.status === 'loading';
    attempt++
  )
    await flushHookEffects();
  expect(hook.getCurrent().state).toMatchObject({
    status: 'ready',
    coverage: 'complete',
    nextCursor: null,
    items: [{ kind: 'receipt', receipt: { id: receipt.deployment.id } }],
  });

  const reads = environmentReads;
  await hook.rerender(false);
  await flushHookEffects();
  expect(environmentReads).toBe(reads);
  expect(hook.getCurrent().state.items).toHaveLength(1);
});
