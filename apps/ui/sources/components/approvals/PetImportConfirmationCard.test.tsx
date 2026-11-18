import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import type { PetImportConfirmationV1, PetImportOutcomeV1 } from '@happier-dev/protocol/pets/importActionV1';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';

vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const { PetImportConfirmationCard } = await import('./PetImportConfirmationCard');
const { t } = await import('@/text');

const pet = {
  accountPetId: 'pet-capy',
  packageFormat: 'codex-compatible-atlas-v1',
  origin: { kind: 'manualImport' },
  digest: 'sha256:x',
  sizeBytes: 1,
  createdAt: 0,
  updatedAt: 0,
  manifest: { id: 'capy', displayName: 'Capy', description: 'Capy', spritesheetPath: 'spritesheet.webp' },
  spritesheetAssetRef: { assetId: 'a', mediaType: 'image/webp', digest: 'sha256:x', sizeBytes: 1 },
} as AccountPetLibraryEntryV1;

function confirmation(outcome: PetImportOutcomeV1 | null): PetImportConfirmationV1 {
  return {
    actionId: 'pet.import',
    input: { source: { kind: 'machine', machineId: 'machine-1', sourceKey: 'source-1' } },
    preview: {
      validation: {
        ok: true, manifest: pet.manifest, mediaType: 'image/webp', digest: 'sha256:x', width: 1536, height: 1872,
      },
      previewHandle: { kind: 'daemonSourceKey', sourceKey: 'source-1' },
    },
    outcome,
  } as unknown as PetImportConfirmationV1;
}

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => { restorePopoverGlobals = withPopoverWebGlobals(); });
afterEach(async () => { restorePopoverGlobals?.(); await standardCleanup(); });

describe('the Session pet card after Keep (R12 §16: the Store listing\'s outcome)', () => {
  it('says Added and offers Use as a Bot\'s face…, Make it my companion and Undo for a pet the Add created', async () => {
    const screen = await renderScreen(<PetImportConfirmationCard serverId={null} testID="card"
      confirmation={confirmation({ kind: 'added', pet, undo: { actionId: 'pet.delete', input: { accountPetId: 'pet-capy' } } })} />);
    expect(screen.getTextContent()).toContain(t('settingsPets.store.addedNow'));
    expect(screen.getTextContent()).not.toContain(t('settingsPets.store.checkedAll'));
    expect(screen.findByTestId('card:useAsFace')).not.toBeNull();
    expect(screen.findByTestId('card:companion')).not.toBeNull();
    expect(screen.findByTestId('card:undo')).not.toBeNull();
  });

  it('offers no Undo for a reused pet, so the pet you already had survives', async () => {
    const screen = await renderScreen(<PetImportConfirmationCard serverId={null} testID="card"
      confirmation={confirmation({ kind: 'added', pet, reused: true })} />);
    expect(screen.findByTestId('card:useAsFace')).not.toBeNull();
    expect(screen.findByTestId('card:undo')).toBeNull();
  });

  it('says a refusal in the listing\'s words, and the check line before Keep', async () => {
    const full = await renderScreen(<PetImportConfirmationCard serverId={null} testID="card"
      confirmation={confirmation({ kind: 'library_full', errorCode: 'quota_exceeded' })} />);
    expect(full.findByTestId('card:libraryFull')).not.toBeNull();
    expect(full.findByTestId('card:useAsFace')).toBeNull();
    const before = await renderScreen(<PetImportConfirmationCard serverId={null} testID="card" confirmation={confirmation(null)} />);
    expect(before.getTextContent()).toContain(t('settingsPets.store.checkedAll'));
  });
});
