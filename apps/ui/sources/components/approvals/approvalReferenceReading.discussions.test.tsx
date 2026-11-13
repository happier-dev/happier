import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import {
  answerDiscussionThreadForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

installApprovalCommonModuleMocks({
  text: () => vi.importActual<typeof import('@/text')>('@/text'),
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useApprovalReferenceReading } =
  await import('./approvalReferenceReading');
const { createDiscussionClient } =
  await import('@/sync/api/discussions/discussionActions');
const { clearDiscussionRepositoryRegistryForTests } =
  await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { primeServerFeaturesSnapshot } =
  await import('@/sync/api/capabilities/serverFeaturesClient');

async function prepareDiscussionHome() {
  const serverId = await homes.addHome({
    name: 'Discussion Home',
    serverUrl: 'https://approval-discussion-title.test',
    accountId: 'alice',
    currentAccount: true,
  });
  const features = createRootLayoutFeaturesResponse();
  tryWriteServerEnabledBitInPlace(features, 'sharing.session', true);
  tryWriteServerEnabledBitInPlace(features, 'sessions.conversations', true);
  homes.answer(serverId, '/v1/features', { body: features });
  homes.answer(serverId, '/v1/features/authenticated', { body: features });
  primeServerFeaturesSnapshot({
    serverId,
    snapshot: { status: 'ready', features },
  });
  const network = answerDiscussionThreadForTests(homes, serverId, {
    loseCreate: false,
    loseFirstRejoin: false,
  });
  const client = createDiscussionClient({
    scope: { serverId, accountId: 'alice' },
    availability: 'available',
  });
  expect(
    await client.create({
      creationLocalId: 'release-topic',
      messageLocalId: 'release-first',
      title: 'Release plan',
      content: { v: 1, parts: [{ t: 'text', text: 'Ship on Friday' }] },
    }),
  ).toMatchObject({ kind: 'succeeded' });
  // The reader starts cold: nothing about this Discussion is held on the device yet.
  clearDiscussionRepositoryRegistryForTests();
  return { serverId, network };
}

describe('Discussion destinations in approvals', () => {
  beforeEach(async () => {
    standardCleanup();
    await homes.reset();
  });
  afterEach(async () => {
    standardCleanup();
    clearDiscussionRepositoryRegistryForTests();
    await homes.reset();
  });

  it('reads as loading while its title is in flight, never as unavailable, then by its title', async () => {
    const { serverId, network } = await prepareDiscussionHome();
    const gate = createDeferred<void>();
    homes.answer(serverId, '/v1/discussions/committed-thread', {
      select: async () => {
        await gate.promise;
        return { body: { discussion: network.stored()?.discussion } };
      },
    });
    const reading = await renderHook(() =>
      useApprovalReferenceReading(
        { kind: 'discussion', id: 'committed-thread' },
        'committed-thread',
        serverId,
      ),
    );
    const readings = [reading.getCurrent()];
    await vi.waitFor(() =>
      expect(
        homes.requestsFor('/v1/discussions/committed-thread'),
      ).toHaveLength(1),
    );
    readings.push(reading.getCurrent());
    for (const current of readings)
      expect(current).toMatchObject({ named: false, resolving: true });
    gate.resolve();
    await vi.waitFor(() =>
      expect(reading.getCurrent()).toMatchObject({
        text: 'Release plan',
        named: true,
      }),
    );
    expect(reading.getCurrent().resolving).toBeUndefined();
    await reading.unmount();
  });

  it('reads as unavailable once this Account cannot read the title', async () => {
    const { serverId, network } = await prepareDiscussionHome();
    network.deny();
    const reading = await renderHook(() =>
      useApprovalReferenceReading(
        { kind: 'discussion', id: 'committed-thread' },
        'committed-thread',
        serverId,
      ),
    );
    await vi.waitFor(() =>
      expect(reading.getCurrent()).toMatchObject({
        text: 'Unavailable',
        named: false,
      }),
    );
    expect(reading.getCurrent().resolving).toBeUndefined();
    await reading.unmount();
  });
});
