import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeManagedServerChildEnv,
  resolveOpenCodeManagedServerLaunchFingerprint,
} from './openCodeManagedServerEnv';

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

  it('defaults XDG_CONFIG_HOME to the Happier home config directory when unset', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: { PATH: '/bin', HAPPIER_HOME_DIR: '/tmp/happier-home' },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.XDG_CONFIG_HOME).toBe('/tmp/happier-home/.config');
  });

  it('isolates HOME/config under the Happier home while preserving host XDG runtime dirs by default', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: {
        PATH: '/bin',
        HOME: '/Users/example',
        HAPPIER_HOME_DIR: '/tmp/happier-home',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.HOME).toBe('/tmp/happier-home');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/happier-home/.config');
    expect(env.XDG_DATA_HOME).toBe('/Users/example/.local/share');
    expect(env.XDG_STATE_HOME).toBe('/Users/example/.local/state');
    expect(env.XDG_CACHE_HOME).toBe('/Users/example/.cache');
  });

  it('prefers the Happier home config directory over inherited XDG_CONFIG_HOME when a Happier home is available', () => {
    const env = resolveOpenCodeManagedServerChildEnv({
      baseEnv: {
        PATH: '/bin',
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        XDG_CONFIG_HOME: '/Users/example/.config',
      },
      xdgRootDir: null,
      isolateConfig: false,
    });

    expect(env.XDG_CONFIG_HOME).toBe('/tmp/happier-home/.config');
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

  it('changes the launch fingerprint when auth-relevant provider env changes', () => {
    const fingerprintA = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENAI_API_KEY: 'key-a',
        OPENCODE_SERVER_USERNAME: 'user-a',
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    const fingerprintB = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENAI_API_KEY: 'key-b',
        OPENCODE_SERVER_USERNAME: 'user-a',
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
    });

    expect(fingerprintA).not.toBe(fingerprintB);
  });
});
