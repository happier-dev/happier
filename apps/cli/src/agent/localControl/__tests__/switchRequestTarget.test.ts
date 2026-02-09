import { describe, expect, it } from 'vitest';

import { resolveSwitchRequestTarget } from '../switchRequestTarget';

describe('resolveSwitchRequestTarget', () => {
  it('returns local and remote targets for valid switch payloads', () => {
    expect(resolveSwitchRequestTarget({ to: 'local' })).toBe('local');
    expect(resolveSwitchRequestTarget({ to: 'remote' })).toBe('remote');
  });

  it('returns undefined for invalid or missing targets', () => {
    expect(resolveSwitchRequestTarget(undefined)).toBeUndefined();
    expect(resolveSwitchRequestTarget(null)).toBeUndefined();
    expect(resolveSwitchRequestTarget('local')).toBeUndefined();
    expect(resolveSwitchRequestTarget({})).toBeUndefined();
    expect(resolveSwitchRequestTarget({ to: 'other' })).toBeUndefined();
  });
});
