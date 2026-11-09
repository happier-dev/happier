import { describe, expect, it } from 'vitest';

import { desktopInstallationsShareInstallHome } from './desktopInstallations.js';

describe('Desktop installation home identity', () => {
  it('groups Windows install homes across case and separator spelling while keeping sibling homes distinct', () => {
    const first = { happyHomeDir: 'C:\\Users\\Alice\\one', firstPartyInstallHome: 'C:\\Users\\Alice\\Programs\\' };
    expect(desktopInstallationsShareInstallHome(first, {
      happyHomeDir: 'C:/Users/Alice/two', firstPartyInstallHome: 'c:/users/alice/Programs',
    })).toBe(true);
    expect(desktopInstallationsShareInstallHome(first, {
      happyHomeDir: 'C:/Users/Alice/two', firstPartyInstallHome: 'c:/users/alice/Programs2',
    })).toBe(false);
  });
});
