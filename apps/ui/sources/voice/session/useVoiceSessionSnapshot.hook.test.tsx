import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useVoiceSessionSnapshot (hook)', () => {
  it('does not trigger an infinite update loop when the store has not changed', async () => {
    vi.resetModules();

    const unexpectedConsoleErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      // React warns about react-test-renderer deprecation. We still want to fail on
      // other unexpected console errors, but ignore this specific warning.
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return;
      }
      unexpectedConsoleErrors.push(args);
    });

    try {
      const { useVoiceSessionSnapshot } = await import('./voiceSession');

      const snapshots: unknown[] = [];

      const hook = await renderHook(
        ({ tick }: { tick: number }) => {
          const snap = useVoiceSessionSnapshot();
          React.useEffect(() => {
            snapshots.push(snap);
          }, [tick]);
          return snap;
        },
        {
          initialProps: { tick: 0 },
          wrapper: React.StrictMode,
        },
      );

      await hook.rerender({ tick: 1 });

      // If the underlying store hasn't changed, the snapshot should be referentially stable across renders.
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      expect(snapshots[1]).toBe(snapshots[0]);
      expect(unexpectedConsoleErrors).toEqual([]);
      await hook.unmount();

      // Some test harnesses fail tests if a console spy is invoked at all; clear any
      // ignored deprecation warnings so those hooks don't flag this test.
      consoleError.mockClear();
    } finally {
      consoleError.mockRestore();
    }
  });
});
