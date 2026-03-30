import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
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

    const screen = await renderScreen(<AppPaneModalProvider>{React.createElement(PortalInjector)}</AppPaneModalProvider>);
    await flushMicrotasks(3);

    const json = JSON.stringify(screen.tree.toJSON());
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

    await expect(
      renderScreen(
        <ModalProvider>
          <AppPaneProvider>
            <PortalInjector />
          </AppPaneProvider>
        </ModalProvider>,
      ).then(async () => {
        await flushMicrotasks(3);
      }),
    ).rejects.toThrow('useAppPaneContext must be used within <AppPaneProvider>');
  });
});
