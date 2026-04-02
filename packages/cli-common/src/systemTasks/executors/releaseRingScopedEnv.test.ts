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

  it('does not override existing scoping env vars', () => {
    const env = applyPublicReleaseRingScopeToEnv({
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
    }, 'preview');
    expect(env.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
    expect(env.HAPPIER_RELEASE_RING).toBe('dev');
  });

  it('does not inject scoping env vars for stable by default', () => {
    const env = applyPublicReleaseRingScopeToEnv({ HELLO: 'world' }, 'stable');
    expect(env.HELLO).toBe('world');
    expect(env).not.toHaveProperty('HAPPIER_PUBLIC_RELEASE_CHANNEL');
    expect(env).not.toHaveProperty('HAPPIER_RELEASE_RING');
  });
});
