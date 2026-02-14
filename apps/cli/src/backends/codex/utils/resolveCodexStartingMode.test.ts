import { describe, expect, it } from 'vitest';

import { resolveCodexStartingMode } from './resolveCodexStartingMode';

describe('resolveCodexStartingMode', () => {
  it('respects an explicit startingMode override', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'remote',
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'local',
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: false,
      }),
    ).toBe('local');
  });

  it('defaults to remote when started by daemon', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'daemon',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('remote');
  });

  it('defaults to local when local control is enabled and a TTY is available', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('local');
  });

  it('defaults to remote when local control is disabled or a TTY is unavailable', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: false,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: false,
        localControlEnabled: true,
      }),
    ).toBe('remote');
  });
});
