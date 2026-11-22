import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { MACHINE_PRESET_TEAM_KEY_PENDING } from '@/sync/domains/machines/presets/machinePresetReadFailure';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  storage: 'real',
});
afterEach(() => standardCleanup());

const { PresetImageCell, readPresetTableImage } = await import('./presetTable');

function waitingPreset(): ManagedMachinePresetListEntryV1 {
  const {
    content: _content,
    recipients: _recipients,
    ...metadata
  } = createPlainManagedMachinePresetFixture({
    id: 'shared-gpu',
    homeId: 'home',
    revision: 1,
    name: 'Unread',
    owner: { kind: 'team', teamId: 'team' },
    launch: {
      provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
      schemaVersion: 1,
      name: 'Guest',
      choices: {},
    },
  });
  return {
    ...metadata,
    kind: 'private_content_unavailable',
    reason: MACHINE_PRESET_TEAM_KEY_PENDING,
  };
}

describe('preset table Image cell', () => {
  it('shows the empty-value dash for a preset whose body cannot be read yet, like its Size and Last used cells', async () => {
    const image = readPresetTableImage({
      key: 'waiting',
      serverId: 'server',
      preset: waitingPreset(),
      title: 'Unread',
    });
    const screen = await renderScreen(
      <PresetImageCell image={image} testID="cell" />,
    );
    try {
      expect(screen.getTextContent().trim()).toBe('—');
    } finally {
      await screen.unmount();
    }
  });
});
