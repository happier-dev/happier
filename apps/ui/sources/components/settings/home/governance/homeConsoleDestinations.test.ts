import { describe, expect, it } from 'vitest';
import { NO_HOME_CAPABILITIES_V1 } from '@happier-dev/protocol/home/governance';

import { resolveHomeConsoleViewer } from './homeConsoleDestinations';

const owner = {
  viewer: {
    accountId: 'acc_1',
    homeRole: 'owner' as const,
    status: 'active' as const,
  },
  capabilities: {
    ...NO_HOME_CAPABILITIES_V1,
    viewAdministration: true,
    manageAccounts: true,
  },
  setupState: 'owned' as const,
};
const member = {
  viewer: {
    accountId: 'acc_1',
    homeRole: 'member' as const,
    status: 'active' as const,
  },
  capabilities: NO_HOME_CAPABILITIES_V1,
  setupState: 'owned' as const,
};
const ids = (viewer: ReturnType<typeof resolveHomeConsoleViewer>) =>
  viewer.destinations.flat().map((destination) => destination.id);

describe('the Home console viewer', () => {
  it('stands on the last-known answer while the Home has not answered: role and destinations from the first frame', () => {
    const viewer = resolveHomeConsoleViewer({
      answered: false,
      setupRequired: false,
      access: owner,
    });
    expect(viewer.role).toBe('owner');
    expect(ids(viewer)).toEqual(
      expect.arrayContaining(['overview', 'people', 'features', 'data']),
    );
  });

  it('holds the role line and offers only Overview when nothing is known yet', () => {
    const viewer = resolveHomeConsoleViewer({
      answered: false,
      setupRequired: false,
      access: null,
    });
    expect(viewer.role).toBe('pending');
    expect(ids(viewer)).toEqual(['overview']);
  });

  it('never advertises administration to a viewer whose last-known role was not an administrator', () => {
    const viewer = resolveHomeConsoleViewer({
      answered: false,
      setupRequired: false,
      access: member,
    });
    expect(ids(viewer)).toEqual(['overview']);
    expect(viewer.role).toBeNull();
  });

  it('removes the destinations the moment a fresh answer withdraws the role', () => {
    const viewer = resolveHomeConsoleViewer({
      answered: true,
      setupRequired: false,
      access: null,
    });
    expect(viewer.role).toBeNull();
    expect(ids(viewer)).toEqual(['overview']);
  });

  it('names an ownerless Home and offers only Overview', () => {
    const viewer = resolveHomeConsoleViewer({
      answered: true,
      setupRequired: true,
      access: owner,
    });
    expect(viewer.role).toBe('noOwner');
    expect(ids(viewer)).toEqual(['overview']);
  });
});
