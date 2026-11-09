import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveConfiguredNativeHomePath } from './nativeHome.js';

describe('resolveConfiguredNativeHomePath', () => {
  it('shares absolute native overrides and source precedence with the host', () => {
    const home = resolve('test-home');
    const declaration = { environmentKey: 'NATIVE_HOME', defaultRelativePath: '.config',
      sourceEnvironmentKey: 'ORIGINAL_NATIVE_HOME', fallbackEnvironmentKeys: ['FALLBACK_NATIVE_HOME'] };
    expect(resolveConfiguredNativeHomePath(declaration, { HOME: home, NATIVE_HOME: join(home, 'selected'),
      ORIGINAL_NATIVE_HOME: join(home, 'original') })).toBe(join(home, 'original'));
    expect(resolveConfiguredNativeHomePath(declaration, { HOME: home, FALLBACK_NATIVE_HOME: join(home, 'fallback') }))
      .toBe(join(home, 'fallback'));
    expect(resolveConfiguredNativeHomePath(declaration, { HOME: home })).toBe(join(home, '.config'));
    expect(resolveConfiguredNativeHomePath({ environmentKey: 'HOME', defaultRelativePath: '.' }, {}, home)).toBe(home);
  });

  it.each(['relative-config', '~/config', '~\\config'])('refuses a relative native environment override: %s', override => {
    expect(() => resolveConfiguredNativeHomePath({ environmentKey: 'NATIVE_HOME', defaultRelativePath: '.config' },
      { HOME: resolve('test-home'), NATIVE_HOME: override })).toThrow('connected_service_native_home_environment_must_be_absolute');
  });

  it.each(['..', '../sibling'])('refuses a default outside the home: %s', defaultRelativePath => {
    expect(() => resolveConfiguredNativeHomePath({ environmentKey: 'NATIVE_HOME', defaultRelativePath },
      { HOME: resolve('test-home') })).toThrow('connected_service_native_home_default_must_be_home_relative');
  });
});
