import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

/** Bot-owned Chrome. Happier Browser retains its own managed Chromium. */
export const googleChrome: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Google Chrome', software: true, icon: 'browser',
  description: 'The browser, for agents that test sites and take screenshots.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...packageSelection({
    apt: [{ name: 'google-chrome-stable' }],
    dnf: [{ name: 'google-chrome-stable' }],
    brew: [{ name: 'google-chrome', kind: 'cask' }],
    winget: [{ name: 'Google.Chrome', source: 'winget', scope: 'user' }],
  }),
};
