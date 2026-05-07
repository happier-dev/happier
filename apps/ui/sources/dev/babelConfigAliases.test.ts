import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type BabelApi = {
  cache: ((value: boolean) => void) & {
    using?: (callback: () => string) => void;
  };
};

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadBabelConfig(envOverrides: Record<string, string | undefined> = {}) {
  // `apps/ui/babel.config.js` is CJS; use require for compatibility.
  const factory = require('../../babel.config.js') as (api: BabelApi) => unknown;

  const cacheCalls: boolean[] = [];
  const cacheUsingCalls: string[] = [];
  const api: BabelApi = {
    cache: Object.assign((value: boolean) => {
      cacheCalls.push(value);
    }, {
      using: (callback: () => string) => {
        cacheUsingCalls.push(callback());
      },
    }),
  };

  return withEnv(envOverrides, () => ({ config: factory(api) as any, cacheCalls, cacheUsingCalls }));
}

describe('babel.config.js', () => {
  it('does not throw when loaded without a Babel api object', () => {
    const factory = require('../../babel.config.js') as (api?: BabelApi) => unknown;
    expect(() => factory(undefined)).not.toThrow();
  });

  it('configures @/* alias to sources/* for Metro builds', () => {
    const { config } = loadBabelConfig();
    const plugins = Array.isArray(config?.plugins) ? config.plugins : [];

    const moduleResolver = plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'module-resolver',
    ) as [string, any] | undefined;

    expect(moduleResolver, 'expected module-resolver plugin to be configured').toBeTruthy();
    expect(moduleResolver?.[1]?.cwd).toBe('babelrc');
    expect(moduleResolver?.[1]?.alias?.['@']).toBe('./sources');
  });

  it('keeps Worklets Bundle Mode disabled by default for native stability', () => {
    const { config } = loadBabelConfig();
    const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
    const workletsPlugin = plugins.at(-1) as [string, Record<string, unknown>] | undefined;

    expect(Array.isArray(workletsPlugin)).toBe(true);
    expect(workletsPlugin?.[0]).toBe('react-native-worklets/plugin');
    expect(workletsPlugin?.[1]).toEqual(expect.objectContaining({
      bundleMode: false,
      workletizableModules: expect.arrayContaining(['remend']),
    }));
  });

  it('allows Worklets Bundle Mode to be enabled explicitly for native experiments', () => {
    const { config, cacheUsingCalls } = loadBabelConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });
    const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
    const workletsPlugin = plugins.at(-1) as [string, Record<string, unknown>] | undefined;

    expect(workletsPlugin?.[1]).toEqual(expect.objectContaining({
      bundleMode: true,
      strictGlobal: true,
      workletizableModules: expect.arrayContaining(['remend']),
    }));
    expect(cacheUsingCalls).toContain('1|0');
  });

  it('allows release perf validation builds to keep console telemetry explicitly', () => {
    const { config, cacheUsingCalls } = loadBabelConfig({ HAPPIER_UI_KEEP_CONSOLE_IN_RELEASE: '1' });
    const productionPlugins = Array.isArray(config?.env?.production?.plugins)
      ? config.env.production.plugins
      : [];

    expect(productionPlugins).not.toContain('transform-remove-console');
    expect(cacheUsingCalls).toContain('0|1');
  });
});
