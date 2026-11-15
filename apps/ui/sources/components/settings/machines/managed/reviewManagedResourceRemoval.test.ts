import { describe, expect, it, vi } from 'vitest';
import { ManagedResourceDependencyV1Schema, type ManagedResourceDependencyV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { IModal } from '@/modal';
import { t } from '@/text';

import { describeManagedRemovalResource, reviewManagedResourceRemoval } from './reviewManagedResourceRemoval';

const canceledHetzner = ManagedResourceDependencyV1Schema.parse({
  managedId: 'cmw0pjiad007vmc0nsrva3cr7',
  homeId: 'srv_home',
  custodianAccountId: 'acct_c',
  intentRevision: 1,
  provider: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' },
  allocation: 'may-exist',
  recovery: { reference: 'cmw0pjiad007vmc0nsrva3cr7', reason: 'native_acquisition_unconfirmed' },
  cleanup: { disposition: 'pending', reason: 'creation_canceled' },
});
if (!('provider' in canceledHetzner)) throw new Error('Expected the provider resource dependency fixture');

function recordingModal(answer: boolean) {
  const calls: Array<{
    title: string;
    message?: string;
    paragraphs: readonly string[];
  }> = [];
  const modal: Pick<IModal, 'confirm'> = {
    confirm: async (title, message, options) => {
      calls.push({
        title,
        message,
        paragraphs: (options?.messageParagraphs ?? []).map(
          (paragraph) => paragraph.text,
        ),
      });
      return answer;
    },
  };
  return { modal, calls };
}

describe('reviewManagedResourceRemoval', () => {
  it('describes confirmed absence without a bound resource as nothing created', () => {
    const resource: ManagedResourceDependencyV1 = { managedId: 'rejected-create', homeId: 'home', custodianAccountId: 'owner',
      intentRevision: 1, provider: { pluginId: 'happier.machine.boat', localId: 'boat' }, allocation: 'confirmed-absent' };
    expect(describeManagedRemovalResource(resource)).toContain(t('managedMachines.inspect.notCreated'));
    expect(describeManagedRemovalResource(resource)).not.toContain(t('managedPower.resourceAbsent'));
  });
  it('names each resource by its provider and state, never as its raw record (CLOUD27)', async () => {
    const { modal, calls } = recordingModal(true);
    const dispositions = await reviewManagedResourceRemoval(
      [canceledHetzner],
      modal,
    );

    const shown = [calls[0]!.message ?? '', ...calls[0]!.paragraphs].join('\n');
    expect(shown).not.toContain('{');
    expect(calls[0]!.paragraphs.slice(0, 2)).toEqual([
      t('managedCleanup.removalReview'),
      `${t('managedMachines.detail.kindFact', { provider: 'Hetzner', kind: 'VM' })} · ${t('managedMachines.creation.canceledCleanup')}`,
    ]);
    expect(dispositions).toEqual([
      {
        managedId: canceledHetzner.managedId,
        expectedIntentRevision: 1,
        expectedAllocation: 'may-exist',
        expectedRecovery: canceledHetzner.recovery,
        responsibility: 'manual',
      },
    ]);
  });

  it('tells two resources of the same provider apart by their tag, native identity, controller and console (G-C01)', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createMachineFixture } = await import('@/dev/testkit');
    const controllerMachine = createMachineFixture({ id: 'nldw3' });
    storage.setState({ machineListByServerId: { srv: [{ ...controllerMachine, metadata: { ...controllerMachine.metadata!, displayName: 'NLDW3' } }] } });
    const bound = (managedId: string, server: string): ManagedResourceDependencyV1 => ({ managedId, homeId: 'srv_home', custodianAccountId: 'acct_c',
      intentRevision: 2, controller: { machineId: 'nldw3', installationId: 'inst' }, provider: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' },
      allocation: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1, value: { serverId: server } },
      recovery: { reference: managedId, reason: 'cleanup_unconfirmed', consoleUrl: `https://console.hetzner.cloud/servers/${server}` },
      cleanup: { disposition: 'unavailable', reason: 'provider_unavailable' } } as ManagedResourceDependencyV1);
    const confirm = vi.fn(async (..._args: Parameters<IModal['confirm']>) => true);
    await reviewManagedResourceRemoval([bound('managed-a', '1001'), bound('managed-b', '1002')], { confirm });
    const paragraphs = confirm.mock.calls[0]![2]!.messageParagraphs!;
    const text = paragraphs.map(paragraph => paragraph.text).join('\n');
    for (const fact of ['managed-a', 'managed-b', 'serverId: 1001', 'serverId: 1002', t('managedMachines.detail.happierTag')]) expect(text).toContain(fact);
    expect(text).toContain('NLDW3');
    expect(text).not.toContain('{');
    const links = paragraphs.flatMap(paragraph => paragraph.link ? [paragraph.link] : []);
    expect(links).toHaveLength(2);
    expect(links.every(link => link.label === t('managedMachines.actions.openProvider', { provider: 'Hetzner' }))).toBe(true);
  });

  it('reviews opaque preset custody using only its admitted lifecycle', async () => {
    const resource: ManagedResourceDependencyV1 = {
      managedId: 'opaque-preset-machine', homeId: 'srv_home', custodianAccountId: 'acct_c',
      intentRevision: 7, allocation: 'may-exist', opaquePreset: true,
    };
    const { modal, calls } = recordingModal(true);
    await expect(reviewManagedResourceRemoval([resource], modal)).resolves.toEqual([{
      managedId: resource.managedId, expectedIntentRevision: 7, expectedAllocation: 'may-exist',
      opaquePreset: true, responsibility: 'manual',
    }]);
    expect(calls[0]?.paragraphs.join('\n')).toContain(t('common.machine'));
  });

  it('returns null when the person keeps the connection', async () => {
    const { modal } = recordingModal(false);
    expect(
      await reviewManagedResourceRemoval([canceledHetzner], modal),
    ).toBeNull();
  });
});
