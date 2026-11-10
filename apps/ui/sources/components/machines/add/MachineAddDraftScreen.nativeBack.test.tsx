import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';

installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
// Load the real route graph outside the per-test budget, as the managed Add test does.
await import('./MachineAddDraftScreen');
afterEach(() => standardCleanup());

type Listener = (event: { preventDefault(): void }) => void;

/** A navigation boundary that records `beforeRemove` subscriptions as React Navigation delivers them. */
function createNavigationBoundary() {
  const listeners: Listener[] = [];
  return {
    listeners,
    navigation: {
      addListener(type: 'beforeRemove', listener: Listener) {
        if (type === 'beforeRemove') listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    },
  };
}

describe('Add machine opened from a composer: native Back', () => {
  it('returns to the composer once instead of popping to the settings page beneath, then lets the return pass', async () => {
    const { useNativeBackReturnsToComposer } =
      await import('./MachineAddDraftScreen');
    const { Platform } = await import('react-native');
    const platformOs = Platform.OS;
    (Platform as { OS: string }).OS = 'ios';
    const boundary = createNavigationBoundary();
    const onReturn = vi.fn();
    function Host() {
      useNativeBackReturnsToComposer(boundary.navigation, true, onReturn);
      return null;
    }
    const screen = await renderScreen(<Host />);
    try {
      expect(boundary.listeners).toHaveLength(1);
      const back = vi.fn();
      await act(async () => boundary.listeners[0]!({ preventDefault: back }));
      expect(back).toHaveBeenCalledOnce();
      expect(onReturn).toHaveBeenCalledOnce();
      // The return's own removal of this screen is not intercepted.
      const returnRemoval = vi.fn();
      await act(async () =>
        boundary.listeners[0]!({ preventDefault: returnRemoval }),
      );
      expect(returnRemoval).not.toHaveBeenCalled();
      expect(onReturn).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      (Platform as { OS: string }).OS = platformOs;
    }
  });

  it('leaves Back alone on the web and outside a composer continuation', async () => {
    const { useNativeBackReturnsToComposer } =
      await import('./MachineAddDraftScreen');
    const web = createNavigationBoundary();
    function WebHost() {
      useNativeBackReturnsToComposer(web.navigation, true, vi.fn());
      return null;
    }
    const screen = await renderScreen(<WebHost />);
    expect(web.listeners).toHaveLength(0);
    await screen.unmount();
  });
});

describe('Back to a docked composer (native, nested settings stack)', () => {
  it('hands the draft back to the host and leaves the nested stack through its parent, not inside it', async () => {
    const { leaveToDockedComposer } = await import('./MachineAddDraftScreen');
    const order: string[] = [];
    const parentBack = vi.fn(() => order.push('parent.goBack'));
    const back = vi.fn();
    leaveToDockedComposer({
      applyToHost: () => order.push('applyToHost'),
      navigation: { getParent: () => ({ canGoBack: () => true, goBack: parentBack }) },
      back,
    });
    expect(order).toEqual(['applyToHost', 'parent.goBack']);
    expect(back).not.toHaveBeenCalled();
  });

  it('falls back to its own Back when there is no parent to leave through', async () => {
    const { leaveToDockedComposer } = await import('./MachineAddDraftScreen');
    const back = vi.fn();
    leaveToDockedComposer({ applyToHost: vi.fn(), navigation: { getParent: () => undefined }, back });
    expect(back).toHaveBeenCalledOnce();
  });
});
