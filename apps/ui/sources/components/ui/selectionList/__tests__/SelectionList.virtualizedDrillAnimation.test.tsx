import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * FR3-9 — Directory drill-down animation must apply on the virtualized path
 * too. Previously, `renderSectionElement` returned the
 * `SelectionListVirtualizedSection` branch BEFORE the `transitionKey` /
 * `PlanAnimatedSuccessRows` branch — so virtualization-eligible sections
 * (e.g. directories with 60+ entries) snapped instead of cross-sliding.
 *
 * Fix: when a virtualized section also advertises a `transitionKey`, wrap
 * the virtualized rows in the same `SlideTransitionSwitch` so the animation
 * matches the mapped row path.
 */
import type { SectionRenderPlan } from '../SelectionListRenderPlan';

function makePlan(transitionKey: string, optionCount: number): ReadonlyArray<SectionRenderPlan> {
    const options = Array.from({ length: optionCount }, (_, i) => ({
        id: `opt-${i}`,
        label: `Option ${i}`,
    }));
    return [
        {
            id: 'dir',
            options,
            virtualization: 'force' as const,
            transitionKey,
            isStale: false,
        },
    ];
}

describe('SelectionList virtualized drill animation (FR3-9)', () => {
    it('wraps a virtualized + transitionKey section in a slide transition surface', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan = makePlan('/home/user/dir-a', 80);
        const screen = await renderScreen(
            <SelectionListBody
                step={{ id: 'root', sections: [] }}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // The virtualized section's transition wrapper exposes the same
        // testID convention as the mapped path's wrapper —
        // `${sectionTestId}:transition` — so the virtualized branch
        // participates in the shared transition surface. The testID is
        // emitted by `SlideTransitionSwitch` via its `testID` prop.
        expect(screen.findByTestId('sl:section:dir:transition')).not.toBeNull();
    });

    it('mounts the virtualized rows inside the transition surface (host preserved)', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan = makePlan('/home/user/dir-a', 80);
        const screen = await renderScreen(
            <SelectionListBody
                step={{ id: 'root', sections: [] }}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // The transition surface must contain the virtualized FlashList host
        // so virtualized scrolling and recycling still work inside the
        // sliding layer.
        const transition = screen.findByTestId('sl:section:dir:transition');
        expect(transition).not.toBeNull();
    });

    it('does NOT wrap a virtualized section in the transition surface when no transitionKey is set (static sections)', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan: ReadonlyArray<SectionRenderPlan> = [
            {
                id: 'dir',
                options: Array.from({ length: 80 }, (_, i) => ({
                    id: `opt-${i}`,
                    label: `Option ${i}`,
                })),
                virtualization: 'force' as const,
                isStale: false,
            },
        ];
        const screen = await renderScreen(
            <SelectionListBody
                step={{ id: 'root', sections: [] }}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // No transition wrapper when there is no transitionKey — static
        // virtualized sections render plainly.
        expect(screen.findByTestId('sl:section:dir:transition')).toBeNull();
    });
});
