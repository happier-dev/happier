import { describe, expect, it } from 'vitest';

import { resolveOpenCodeManagedServerChildEnv } from './openCodeManagedServerEnv';

describe('resolveOpenCodeManagedServerChildEnv', () => {
  it('defaults OPENCODE_CONFIG_CONTENT when missing and does not override XDG dirs when no xdgRootDir is provided', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { PATH: '/bin', XDG_CONFIG_HOME: '/cfg' },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.PATH).toBe('/bin');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{}');
    expect(env.XDG_CONFIG_HOME).toBe('/cfg');
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.XDG_STATE_HOME).toBeUndefined();
    expect(env.XDG_CACHE_HOME).toBeUndefined();
  });

  it('sets XDG data/state/cache directories under xdgRootDir and preserves existing config dir by default', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { XDG_CONFIG_HOME: '/cfg', OPENCODE_CONFIG_CONTENT: '{"ok":true}' },
      xdgRootDir: '/xdg-root',
      isolateConfig: false,
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"ok":true}');
    expect(env.XDG_DATA_HOME).toBe('/xdg-root/data');
    expect(env.XDG_STATE_HOME).toBe('/xdg-root/state');
    expect(env.XDG_CACHE_HOME).toBe('/xdg-root/cache');
    expect(env.XDG_CONFIG_HOME).toBe('/cfg');
  });

  it('can isolate config directory under xdgRootDir when requested', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { XDG_CONFIG_HOME: '/cfg' },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    expect(env.XDG_CONFIG_HOME).toBe('/xdg-root/config');
  });
});
