import type { MachineSetupPresetContributionV1 } from '@happier-dev/plugin-sdk';

/** Setup-only data, consumed by the same Preset source/online setup owner. */
export const browserBot: Omit<MachineSetupPresetContributionV1, 'id'> = {
  revision: '1', title: 'Browser bot',
  description: 'Chrome and fonts for this bot’s own browser tools. Happier Browser keeps its own managed Chromium. '
    + 'Optionally add Virtual display for an on-demand Linux desktop managed for the daemon’s lifetime. '
    + 'Native package and installation authority support is reviewed on each Machine.',
  setup: { items: ['google-chrome', 'fonts'].map(recipeId => ({ kind: 'softwareRecipe', selection: {
    ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' }, inputs: {},
  } })) },
};
