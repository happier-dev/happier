import { describe, expect, it } from 'vitest';

import { resolveMachinesDoor } from './machinesDoor';

describe('resolveMachinesDoor', () => {
  it('follows the shell column, so one machine list stands beside the page (R88)', () => {
    // Machines column already lists the machines: a Settings URL in it must not draw a second list.
    expect(
      resolveMachinesDoor({
        pathname: '/settings/machines/m1/agents',
        shellColumnId: 'machines',
      }),
    ).toBe('rail');
    // Settings column: the collection draws its list beside it, whichever URL opened the page.
    expect(
      resolveMachinesDoor({
        pathname: '/machines/m1',
        shellColumnId: 'settings',
      }),
    ).toBe('settings');
  });

  it('falls back to the URL beside any other column or none', () => {
    expect(
      resolveMachinesDoor({
        pathname: '/machines/m1',
        shellColumnId: 'sessions',
      }),
    ).toBe('rail');
    expect(
      resolveMachinesDoor({
        pathname: '/settings/machines/m1',
        shellColumnId: null,
      }),
    ).toBe('settings');
  });
});
