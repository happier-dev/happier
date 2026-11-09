import type { MachineSetupPresetContributionV1 } from '@happier-dev/plugin-sdk';

/** Setup-only data, consumed by the same Preset source/online setup owner. */
export const browserBot: Omit<MachineSetupPresetContributionV1, 'id'> = {
  revision: '1', title: 'Browser bot',
  description: 'Chrome and fonts, so a bot can browse and take screenshots. Add Virtual display if it needs a desktop.',
  setup: { items: ['google-chrome', 'fonts'].map(recipeId => ({ kind: 'softwareRecipe', selection: {
    ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' }, inputs: {},
  } })) },
};
