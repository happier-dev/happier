import { describe, expect, it } from 'vitest';

import { resolveTerminalRemoteSwitchRequestTarget } from '../switchTarget';

describe('resolveTerminalRemoteSwitchRequestTarget', () => {
  it('returns terminal and remote targets for valid switch payloads', () => {
    expect(resolveTerminalRemoteSwitchRequestTarget({ to: 'local' })).toBe('local');
    expect(resolveTerminalRemoteSwitchRequestTarget({ to: 'remote' })).toBe('remote');
  });

  it('returns undefined for invalid or missing targets', () => {
    expect(resolveTerminalRemoteSwitchRequestTarget(undefined)).toBeUndefined();
    expect(resolveTerminalRemoteSwitchRequestTarget(null)).toBeUndefined();
    expect(resolveTerminalRemoteSwitchRequestTarget('local')).toBeUndefined();
    expect(resolveTerminalRemoteSwitchRequestTarget({})).toBeUndefined();
    expect(resolveTerminalRemoteSwitchRequestTarget({ to: 'other' })).toBeUndefined();
  });
});
