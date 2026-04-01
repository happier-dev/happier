import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

installPopoverCommonModuleMocks();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNativeOverlayPortalNode (loop safety)', () => {
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
