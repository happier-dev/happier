import { afterEach, describe, expect, it, vi } from 'vitest';

const requires = vi.hoisted(() => ({ count: 0 }));

// The boundary here is module loading itself: every session runner imports this
// module, and the shipped owner is a self-contained 10 MB CommonJS bundle.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      const counted = Object.assign(((id: string) => {
        if (id.endsWith('process_tree.cjs')) requires.count += 1;
        return real(id);
      }) as NodeJS.Require, real);
      return counted;
    },
  };
});

describe('process tree owner loading', () => {
  afterEach(() => {
    requires.count = 0;
    vi.resetModules();
  });

  it('loads the shipped process tree owner on first use, not on import', async () => {
    const owner = await import('./terminateProcessTree');

    expect(requires.count).toBe(0);

    const firstCapture = await owner.captureProcessTree({ pid: process.pid });
    expect(requires.count).toBe(1);

    expect((await owner.captureProcessTree({ pid: process.pid })).status).toBe(firstCapture.status);
    expect(requires.count).toBe(1);
  });

  it('applies the first use to one injected terminator without reloading the owner', async () => {
    const owner = await import('./terminateProcessTree');
    const terminate = owner.createProcessTreeTerminator({ platform: process.platform });

    expect(requires.count).toBe(0);

    const result = await terminate({ targets: [] });
    expect(result.status).toBe('complete');
    expect(result.outcomes).toEqual([]);
    expect(requires.count).toBe(1);
  });

  it('loads the Windows taskkill owner only when taskkill runs', async () => {
    const taskkill = await import('@/subprocess/supervision/taskkillWindowsProcessTree');
    expect(typeof taskkill.taskkillWindowsProcessTree).toBe('function');
    expect(requires.count).toBe(0);
  });
});
