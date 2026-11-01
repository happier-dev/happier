import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

/** Bot-owned Chrome. Happier Browser retains its own managed Chromium. */
export const googleChrome: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Google Chrome', software: true, icon: 'browser',
  description: 'Google Chrome for this bot’s own tools. Happier Browser uses its own managed Chromium. '
    + 'Linux requires an existing Google package repository and a supported native architecture; the Chrome package manages its repository. '
    + 'No duplicate repository or signing-key file is created. Homebrew must already exist; protected Windows installers are unsupported without a user-scope native installer. '
    + 'Removal preserves browser profiles and user data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...packageSelection({
    apt: [{ name: 'google-chrome-stable' }],
    dnf: [{ name: 'google-chrome-stable' }],
    brew: [{ name: 'google-chrome', kind: 'cask' }],
    winget: [{ name: 'Google.Chrome', source: 'winget', scope: 'user' }],
  }),
};
