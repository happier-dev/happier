import { describe, expect, it } from 'vitest';

import { ensureHeadlessTmuxRemoteStartingModeArgs } from './headlessArgs';

describe('ensureHeadlessTmuxRemoteStartingModeArgs', () => {
  it('appends remote mode when not present', () => {
    expect(ensureHeadlessTmuxRemoteStartingModeArgs(['--foo'])).toEqual([
      '--foo',
      '--happy-starting-mode',
      'remote',
    ]);
  });

  it('keeps explicit remote mode', () => {
    expect(ensureHeadlessTmuxRemoteStartingModeArgs(['--happy-starting-mode', 'remote'])).toEqual([
      '--happy-starting-mode',
      'remote',
    ]);
  });

  it('throws when terminal mode is requested', () => {
    expect(() => ensureHeadlessTmuxRemoteStartingModeArgs(['--happy-starting-mode', 'local'])).toThrow(
      'Headless tmux sessions require remote mode; terminal mode is not supported.',
    );
  });

  it('fails closed when any duplicate --happy-starting-mode value is terminal mode', () => {
    expect(() =>
      ensureHeadlessTmuxRemoteStartingModeArgs([
        '--happy-starting-mode',
        'remote',
        '--happy-starting-mode',
        'local',
      ]),
    ).toThrow('Headless tmux sessions require remote mode; terminal mode is not supported.');
  });

  it('throws a helpful error when --happy-starting-mode is missing a value', () => {
    expect(() => ensureHeadlessTmuxRemoteStartingModeArgs(['--happy-starting-mode'])).toThrow(
      'Missing value for --happy-starting-mode (expected "remote" or "local" for terminal mode)',
    );
  });
});
