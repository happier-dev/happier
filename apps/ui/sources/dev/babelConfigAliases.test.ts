import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type BabelApi = { cache: (value: boolean) => void };

function loadBabelConfig() {
  // `apps/ui/babel.config.js` is CJS; use require for compatibility.
  const factory = require('../../babel.config.js') as (api: BabelApi) => unknown;

  const cacheCalls: boolean[] = [];
  const api: BabelApi = {
    cache: (value) => {
      cacheCalls.push(value);
    },
  };

  return { config: factory(api) as any, cacheCalls };
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
});
