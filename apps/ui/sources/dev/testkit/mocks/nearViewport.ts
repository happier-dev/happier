import type * as NearViewport from '@/components/widgets/nearViewport';

/** The host renderer has no screen coordinates; retain real tracking with a visible native span. */
export function createMeasuredNearViewportModuleMock(actual: typeof NearViewport) {
    return { ...actual,
        createScrollViewNearViewportTracker: (...args: Parameters<typeof actual.createScrollViewNearViewportTracker>) => ({
            ...actual.createScrollViewNearViewportTracker(...args), measureSpan: async () => ({ top: 0 }),
        }),
    };
}
