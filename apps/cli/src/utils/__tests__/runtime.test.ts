import { describe, expect, it } from 'vitest';

import { getRuntime, isBun, isDeno, isNode, type Runtime } from '../runtime';

function expectedRuntimeForCurrentProcess(): Runtime {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun';
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') return 'deno';
  if (process.versions?.bun) return 'bun';
  if (process.versions?.deno) return 'deno';
  if (process.versions?.node) return 'node';
  return 'unknown';
}

describe('Runtime Detection', () => {
  it('returns the runtime expected for this process', () => {
    expect(getRuntime()).toBe(expectedRuntimeForCurrentProcess());
  });

  it('keeps runtime predicates aligned with getRuntime', () => {
    const runtime = getRuntime();
    expect(isNode()).toBe(runtime === 'node');
    expect(isBun()).toBe(runtime === 'bun');
    expect(isDeno()).toBe(runtime === 'deno');
  });

  it('returns a valid runtime value', () => {
    expect(['node', 'bun', 'deno', 'unknown']).toContain(getRuntime());
  });

  it('is stable across repeated calls', () => {
    const first = getRuntime();
    expect(getRuntime()).toBe(first);
    expect(getRuntime()).toBe(first);
  });
});
