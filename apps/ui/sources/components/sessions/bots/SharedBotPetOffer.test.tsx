import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });

// The Action front door is the UI's boundary to the Action runtime; the pet-import owner beyond it is tested in protocol.
const execute = vi.fn(
  async (
    _actionId: string,
    _input: unknown,
    _context?: unknown,
  ): Promise<unknown> => ({ ok: true, result: {} }),
);
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => execute,
    createFrontDoorUiActionExecutor: () => execute,
  }),
);

const { SharedBotPetOffer } = await import('./SharedBotPetOffer');
const { storage } = await import('@/sync/domains/state/storageStore');

const ORIGIN = {
  kind: 'registry',
  sourceId: 'codex-pets',
  itemId: 'capy',
} as const;
/** Another person's Bot, wearing a catalog pet from their own library (their id, never the viewer's). */
const SHARED_FACE: SessionBotFaceV1 = {
  seed: 'garden',
  pet: {
    kind: 'accountPet',
    accountPetId: 'owner-capy',
    displayName: 'Capy',
    origin: ORIGIN,
  },
};

function libraryEntry(
  accountPetId: string,
  origin: AccountPetLibraryEntryV1['origin'],
): AccountPetLibraryEntryV1 {
  return {
    accountPetId,
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: {
      id: accountPetId,
      displayName: 'Capy',
      description: 'A companion',
      spritesheetPath: 'spritesheet.webp',
    },
    spritesheetAssetRef: {
      assetId: `asset-${accountPetId}`,
      mediaType: 'image/webp',
      digest: `sha256:${accountPetId}`,
      sizeBytes: 3,
    },
    digest: `sha256:${accountPetId}`,
    sizeBytes: 3,
    createdAt: 1,
    updatedAt: 1,
    origin,
  };
}

let home: Awaited<ReturnType<typeof import('@/dev/testkit/harness/artifactStoreBoundary').createPlainArtifactHomeFixture>> | undefined;

/** A signed-in viewer on a Home with pets and their sync on: the real Account scope the import executes in. */
async function enablePets() {
  const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit');
  const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
  const features = createRootLayoutFeaturesResponse({ features: { pets: { companion: { enabled: true }, sync: { enabled: true } } } });
  home = await createPlainArtifactHomeFixture('https://pet-share.example.test', { currentAccount: true, serverFeatures: features,
    handleRequest: async path => path === '/v1/features/authenticated' ? Response.json(features) : null });
  storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'pets.companion': true, 'pets.sync': true } });
  await act(async () => { storage.getState().applyAccountPets([]); });
}

afterEach(async () => {
  execute.mockClear();
  await home?.dispose();
  home = undefined;
  const { resetServerFeaturesClientForTests } =
    await import('@/sync/api/capabilities/serverFeaturesClient');
  resetServerFeaturesClientForTests();
  standardCleanup();
});

describe('SharedBotPetOffer (PET-SHARE)', () => {
  it('offers a viewer without the pet one Add, imports it by registry origin, and goes once the face can draw it', async () => {
    await enablePets();
    execute.mockImplementationOnce(async () => ({
      ok: true,
      result: { pet: libraryEntry('viewer-capy', ORIGIN) },
    }));
    const screen = await renderScreen(<SharedBotPetOffer face={SHARED_FACE} />);
    expect(screen.getTextContent()).toContain('petShare.offerLine');
    await screen.pressByTestIdAsync('shared-bot-pet-offer-add');
    expect(execute.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['pet.import', { source: ORIGIN }],
    ]);
    expect(storage.getState().accountPetsById['viewer-capy']?.origin).toEqual(
      ORIGIN,
    );
    // The viewer now holds the same pet by origin, so the shared face draws it and there is nothing left to add.
    await vi.waitFor(() =>
      expect(screen.findByTestId('shared-bot-pet-offer')).toBeNull(),
    );
  });

  it('says why a full library refused, without an Add that cannot succeed', async () => {
    await enablePets();
    execute.mockImplementationOnce(async () => ({
      ok: false,
      errorCode: 'quota_exceeded',
      error: 'Full',
    }));
    const screen = await renderScreen(<SharedBotPetOffer face={SHARED_FACE} />);
    await screen.pressByTestIdAsync('shared-bot-pet-offer-add');
    expect(screen.getTextContent()).toContain('petShare.offerLibraryFull');
    expect(screen.findByTestId('shared-bot-pet-offer-add')).toBeNull();
  });

  it('offers nothing for a created pet, which never leaves its owner on a shared Bot', async () => {
    await enablePets();
    const created: SessionBotFaceV1 = {
      seed: 'garden',
      pet: {
        kind: 'accountPet',
        accountPetId: 'owner-made',
        displayName: 'Mochi',
      },
    };
    const screen = await renderScreen(<SharedBotPetOffer face={created} />);
    expect(screen.findByTestId('shared-bot-pet-offer')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
