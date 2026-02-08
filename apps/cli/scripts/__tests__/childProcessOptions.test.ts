import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('scripts/childProcessOptions.cjs', () => {
  it('adds windowsHide on win32', () => {
    const mod = require('../childProcessOptions.cjs') as {
      withWindowsHide: (options: Record<string, unknown>, platform?: string) => Record<string, unknown>;
    };
    expect(mod.withWindowsHide({ foo: 'bar' }, 'win32')).toEqual({ foo: 'bar', windowsHide: true });
  });

  it('does not add windowsHide on non-win32', () => {
    const mod = require('../childProcessOptions.cjs') as {
      withWindowsHide: (options: Record<string, unknown>, platform?: string) => Record<string, unknown>;
    };
    expect(mod.withWindowsHide({ foo: 'bar' }, 'darwin')).toEqual({ foo: 'bar' });
  });
});
