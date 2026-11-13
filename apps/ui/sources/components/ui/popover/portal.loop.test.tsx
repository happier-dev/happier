import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

installPopoverCommonModuleMocks();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNativeOverlayPortalNode (loop safety)', () => {
    it('preserves the originating surface environment at the native overlay host', async () => {
        const { HappierUiPlatformProvider, useHappierUiPlatform } = await import('@happier-dev/plugin-ui/environment');
        const { OverlayPortalProvider, OverlayPortalHost, useOverlayPortal } = await import('./OverlayPortal');
        const { useNativeOverlayPortalNode } = await import('./portal');
        function Probe() {
            const platform = useHappierUiPlatform();
            return <PlatformProbe testID="ported-platform" platform={platform.platform} />;
        }
        function PlatformProbe(props: Readonly<{ testID: string; platform: string }>) {
            return React.createElement('PlatformProbe', props);
        }
        function Origin() {
            useNativeOverlayPortalNode({ overlayPortal: useOverlayPortal(), portalId: 'surface', enabled: true, content: <Probe /> });
            return null;
        }
        const scene = (platform: 'ios' | 'android') => <OverlayPortalProvider>
            <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}><Origin /></HappierUiPlatformProvider>
            <OverlayPortalHost />
        </OverlayPortalProvider>;
        const screen = await renderScreen(scene('ios'));
        try {
            expect(screen.findByTestId('ported-platform')?.props.platform).toBe('ios');
            await screen.update(scene('android'));
            expect(screen.findByTestId('ported-platform')?.props.platform).toBe('android');
        }
        finally { await screen.unmount(); }
    });

    it('does not trigger an update loop when portal content is referentially unstable', async () => {
        const { useNativeOverlayPortalNode } = await import('./portal');

        function Harness() {
            const [portalNode, setPortalNode] = React.useState<React.ReactNode | null>(null);

            const overlayPortal = React.useMemo(() => ({
                setPortalNode: (_id: string, node: React.ReactNode) => {
                    setPortalNode(node);
                },
                removePortalNode: () => {
                    setPortalNode(null);
                },
            }), []);

            useNativeOverlayPortalNode({
                overlayPortal,
                portalId: 'test-portal',
                enabled: true,
                content: React.createElement('PortalContent', { style: { opacity: 1 } }, 'Hello'),
            });

            return React.createElement('Harness', null, portalNode);
        }

        await expect(renderScreen(<Harness />)).resolves.toBeTruthy();
    });
});
