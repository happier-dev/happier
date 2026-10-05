import { describe, expect, it } from 'vitest';

import { applyPublicReleaseRingScopeToEnv } from './releaseRingScopedEnv.js';

describe('applyPublicReleaseRingScopeToEnv', () => {
  it('injects dev scoping env vars for the publicdev ring when missing', () => {
    const env = applyPublicReleaseRingScopeToEnv({}, 'publicdev');
    expect(env.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
    expect(env.HAPPIER_RELEASE_RING).toBe('dev');
  });

  it('injects preview scoping env vars for the preview ring when missing', () => {
    const env = applyPublicReleaseRingScopeToEnv({}, 'preview');
    expect(env.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('preview');
    expect(env.HAPPIER_RELEASE_RING).toBe('preview');
  });

  it.each(['stable', 'preview', 'publicdev'] as const)('owns conflicting inherited hints for the explicit %s ring', (ring) => {
    const env = applyPublicReleaseRingScopeToEnv({
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
      HAPPIER_RELEASE_CHANNEL: 'preview',
      PATH: '/bin',
    }, ring);
    const label = ring === 'publicdev' ? 'dev' : ring;
    expect(env.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe(label);
    expect(env.HAPPIER_RELEASE_RING).toBe(label);
    expect(env).not.toHaveProperty('HAPPIER_RELEASE_CHANNEL');
    expect(env.PATH).toBe('/bin');
  });

  it('retains the environment when no ring scope was requested', () => {
    const env = applyPublicReleaseRingScopeToEnv({ HELLO: 'world' }, null);
    expect(env.HELLO).toBe('world');
    expect(env).not.toHaveProperty('HAPPIER_PUBLIC_RELEASE_CHANNEL');
    expect(env).not.toHaveProperty('HAPPIER_RELEASE_RING');
  });
});
