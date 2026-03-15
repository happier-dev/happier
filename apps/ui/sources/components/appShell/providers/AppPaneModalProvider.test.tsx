import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flushMicrotasks(times: number) {
  return new Promise<void>((resolve) => {
    let remaining = times;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) return resolve();
      queueMicrotask(step);
    };
    queueMicrotask(step);
  });
}

describe('AppPaneModalProvider', () => {
  it('preserves AppPane context for overlay portal nodes', async () => {
    const { useOverlayPortal } = await import('@/components/ui/popover');

    function PortaledContent() {
      useAppPaneContext();
      return React.createElement('PortaledContentOk');
    }

    function PortalInjector() {
      const portal = useOverlayPortal();
      React.useEffect(() => {
        if (!portal) return;
        portal.setPortalNode('pane-test', React.createElement(PortaledContent));
        return () => {
          portal.removePortalNode('pane-test');
        };
      }, [portal]);
      return React.createElement('PortalInjector');
    }

    const { AppPaneModalProvider } = await import('./AppPaneModalProvider');

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<AppPaneModalProvider>{React.createElement(PortalInjector)}</AppPaneModalProvider>);
      await flushMicrotasks(3);
    });

    expect(tree).toBeTruthy();
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('PortaledContentOk');
  });

  it('loses AppPane context for overlay portal nodes when ModalProvider wraps AppPaneProvider', async () => {
    const { useOverlayPortal } = await import('@/components/ui/popover');
    const { ModalProvider } = await import('@/modal/ModalProvider');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

    function PortaledContent() {
      useAppPaneContext();
      return React.createElement('PortaledContentOk');
    }

    function PortalInjector() {
      const portal = useOverlayPortal();
      React.useEffect(() => {
        if (!portal) return;
        portal.setPortalNode('pane-test', React.createElement(PortaledContent));
        return () => {
          portal.removePortalNode('pane-test');
        };
      }, [portal]);
      return React.createElement('PortalInjector');
    }

    await expect(async () => {
      await act(async () => {
        renderer.create(
          <ModalProvider>
            <AppPaneProvider>
              <PortalInjector />
            </AppPaneProvider>
          </ModalProvider>,
        );
        await flushMicrotasks(3);
      });
    }).rejects.toThrow('useAppPaneContext must be used within <AppPaneProvider>');
  });
});
