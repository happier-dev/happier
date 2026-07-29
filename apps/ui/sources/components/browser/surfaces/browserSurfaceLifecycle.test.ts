import { describe, expect, it } from 'vitest';

describe('browser surface presentation lifecycle', () => {
    it('derives lifecycle state from logical view and presentation slot visibility', async () => {
        const { resolveBrowserSurfaceLifecycleState } = await import('./browserSurfaceLifecycle');

        expect(resolveBrowserSurfaceLifecycleState({
            logicalViewState: 'open',
            slot: { presentationSlotId: 'slot-1', visible: true, active: true, measuredRect: { x: 0, y: 0, width: 100, height: 80 } },
            hostAvailability: 'available',
        })).toBe('visible');

        expect(resolveBrowserSurfaceLifecycleState({
            logicalViewState: 'open',
            slot: { presentationSlotId: 'slot-1', visible: false, active: false, measuredRect: { x: 0, y: 0, width: 100, height: 80 } },
            hostAvailability: 'available',
        })).toBe('hidden');

        expect(resolveBrowserSurfaceLifecycleState({
            logicalViewState: 'open',
            slot: null,
            hostAvailability: 'available',
        })).toBe('orphaned');

        expect(resolveBrowserSurfaceLifecycleState({
            logicalViewState: 'closed',
            slot: { presentationSlotId: 'slot-1', visible: true, active: true, measuredRect: { x: 0, y: 0, width: 100, height: 80 } },
            hostAvailability: 'available',
        })).toBe('closed');
    });

    it('reconciles slots without closing the logical browser view when a presentation slot hides', async () => {
        const { reconcileBrowserPresentationSlots } = await import('./browserSurfaceLifecycle');

        const result = reconcileBrowserPresentationSlots({
            logicalViewId: 'browser-view-1',
            previous: {
                logicalViewId: 'browser-view-1',
                lifecycleState: 'visible',
                slotsById: {
                    'details-slot': {
                        presentationSlotId: 'details-slot',
                        visible: true,
                        active: true,
                        measuredRect: { x: 0, y: 0, width: 800, height: 600 },
                    },
                },
                cleanupReason: null,
            },
            nextSlots: [{
                presentationSlotId: 'details-slot',
                visible: false,
                active: false,
                measuredRect: { x: 0, y: 0, width: 800, height: 600 },
            }],
            hostAvailability: 'available',
        });

        expect(result.logicalViewId).toBe('browser-view-1');
        expect(result.lifecycleState).toBe('hidden');
        expect(result.cleanupReason).toBeNull();
    });

    it('retains a disappeared previous presentation slot as orphaned logical view state', async () => {
        const { reconcileBrowserPresentationSlots } = await import('./browserSurfaceLifecycle');

        const result = reconcileBrowserPresentationSlots({
            logicalViewId: 'browser-view-1',
            previous: {
                logicalViewId: 'browser-view-1',
                lifecycleState: 'visible',
                slotsById: {
                    'details-slot': {
                        presentationSlotId: 'details-slot',
                        visible: true,
                        active: true,
                        measuredRect: { x: 0, y: 0, width: 800, height: 600 },
                    },
                },
                cleanupReason: null,
            },
            nextSlots: [],
            hostAvailability: 'available',
        });

        expect(result.lifecycleState).toBe('orphaned');
        expect(result.cleanupReason).toBeNull();
        expect(result.slotsById['details-slot']).toMatchObject({
            presentationSlotId: 'details-slot',
            visible: false,
            active: false,
            measuredRect: { x: 0, y: 0, width: 800, height: 600 },
        });
    });
});
