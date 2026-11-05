import { describe, expect, it } from 'vitest';
import type { ManagedResourceDependencyV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { IModal } from '@/modal';
import { t } from '@/text';

import { reviewManagedResourceRemoval } from './reviewManagedResourceRemoval';

const canceledHetzner: ManagedResourceDependencyV1 = {
  managedId: 'cmw0pjiad007vmc0nsrva3cr7',
  homeId: 'srv_home',
  custodianAccountId: 'acct_c',
  intentRevision: 1,
  controller: null,
  provider: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' },
  allocation: 'may-exist',
  recovery: { kind: 'native_acquisition_unconfirmed' },
  cleanup: { disposition: 'pending', reason: 'creation_canceled' },
} as unknown as ManagedResourceDependencyV1;

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
  it('names each resource by its provider and state, never as its raw record (CLOUD27)', async () => {
    const { modal, calls } = recordingModal(true);
    const dispositions = await reviewManagedResourceRemoval(
      [canceledHetzner],
      modal,
    );

    const shown = [calls[0]!.message ?? '', ...calls[0]!.paragraphs].join('\n');
    expect(shown).not.toContain('{');
    expect(shown).not.toContain(canceledHetzner.managedId);
    expect(calls[0]!.paragraphs).toEqual([
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

  it('returns null when the person keeps the connection', async () => {
    const { modal } = recordingModal(false);
    expect(
      await reviewManagedResourceRemoval([canceledHetzner], modal),
    ).toBeNull();
  });
});
