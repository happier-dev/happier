import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderWithAppProviders } from '@/dev/testkit';

import type { BrowserSurfaceLifecycleSnapshot } from './browserSurfaceLifecycle';
import { BrowserPresentationRetentionProvider } from './browserPresentationRetention';
import { useBrowserSurfaceHostProps } from './useBrowserSurfaceHostProps';

type Captured = {
    onLifecycleChange: ((snapshot: BrowserSurfaceLifecycleSnapshot) => void) | null;
    isLogicalViewRetained: (() => boolean) | null;
    presentationSlotId: string;
};

function visibleSnapshot(slotId: string): BrowserSurfaceLifecycleSnapshot {
    return {
        logicalViewId: 'logical-view-1',
        lifecycleState: 'visible',
        slotsById: {
            [slotId]: {
                presentationSlotId: slotId,
                visible: true,
                active: true,
                measuredRect: { x: 0, y: 0, width: 100, height: 100 },
            },
        },
        cleanupReason: null,
    };
}

describe('useBrowserSurfaceHostProps retention (UX-6 keep-alive above the router)', () => {
    it('persists retention across a consumer remount when wrapped in the route-stable provider', async () => {
        const captured: Captured = {
            onLifecycleChange: null,
            isLogicalViewRetained: null,
            presentationSlotId: '',
        };

        function Consumer(): null {
            const bundle = useBrowserSurfaceHostProps({
                scope: 'sessionDetails',
                sessionId: 's1',
                // Disable the live machine-RPC controllers (inject explicit null feeds).
                launcherState: null,
                localServicePreviewState: null,
            });
            captured.onLifecycleChange = bundle.onLifecycleChange;
            captured.isLogicalViewRetained = bundle.isLogicalViewRetained;
            captured.presentationSlotId = bundle.presentationSlotId;
            return null;
        }

        function Harness(props: Readonly<{ mounted: boolean }>): React.ReactElement {
            return (
                <BrowserPresentationRetentionProvider>
                    {props.mounted ? <Consumer /> : null}
                </BrowserPresentationRetentionProvider>
            );
        }

        const result = await renderWithAppProviders(<Harness mounted />);
        const slotId = captured.presentationSlotId;
        expect(slotId).toBe('session:s1:details:slot');
        expect(captured.isLogicalViewRetained?.()).toBe(false);

        // The mounted panel records a live logical view.
        await act(async () => {
            captured.onLifecycleChange?.(visibleSnapshot(slotId));
        });
        expect(captured.isLogicalViewRetained?.()).toBe(true);

        // The panel fully unmounts (surface switch) — the provider/store stay mounted above the router.
        await result.update(<Harness mounted={false} />);
        // A brand-new panel mounts and, before emitting any lifecycle, still sees the retained view.
        await result.update(<Harness mounted />);
        expect(captured.isLogicalViewRetained?.()).toBe(true);

        await result.unmount();
    });
});
