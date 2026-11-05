import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 1440, height: 900 }) });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The Popover's measuring and portal are the platform boundary; the picker's own props are what is read.
vi.mock('@/components/ui/popover', async () => ({
    ...await vi.importActual<typeof import('@/components/ui/popover')>('@/components/ui/popover'),
    // This owner-level check observes the native portal's measured-frame inputs.
    Popover: (props: React.ComponentProps<typeof import('@/components/ui/popover')['Popover']>) => {
        const { children: _children, ...frameProps } = props;
        return React.createElement('Popover', { ...frameProps, testID: 'workflow-examples-popover-boundary' });
    },
}));

describe('WorkflowExamplesPopover', () => {
    it('lets a picker whose window-high cap fits on neither side open below a trigger near the top', async () => {
        const { WorkflowExamplesPopover } = await import('./WorkflowExamplesPopover');
        const screen = await renderScreen(<WorkflowExamplesPopover anchorRef={{ current: null }} onRequestClose={() => {}} />);
        const popover = screen.findHostByTestId('workflow-examples-popover-boundary');
        // The cap is the whole window; the room a side must offer to be chosen is a menu's, not the window's.
        expect(popover?.props.maxHeightCap).toBe(900);
        expect(popover?.props.placementMinSpace).toBeLessThan(900);
        expect(popover?.props.placementMinSpace).toBeGreaterThan(0);
        // The card picker takes the room it is given; a content-sized width belongs to the Session's list.
        expect(popover?.props.portal.sizeToContent).toBeUndefined();
    });

    it('keeps the picker clear of the window title strip above, so a tall list never covers the tabs', async () => {
        const { WorkflowExamplesPopover } = await import('./WorkflowExamplesPopover');
        const { APP_SHELL_TITLE_STRIP_HEIGHT_PX } = await import('@/components/navigation/shell/appRail/appRailMetrics');
        const screen = await renderScreen(<WorkflowExamplesPopover anchorRef={{ current: null }} onRequestClose={() => {}} />);
        const edge = screen.findHostByTestId('workflow-examples-popover-boundary')?.props.edgePadding;
        expect(edge.top).toBeGreaterThanOrEqual(APP_SHELL_TITLE_STRIP_HEIGHT_PX);
    });

    it('sizes a Session\'s example list to its content, so a description takes two lines, not five', async () => {
        const { WorkflowExamplesPopover } = await import('./WorkflowExamplesPopover');
        const screen = await renderScreen(<WorkflowExamplesPopover anchorRef={{ current: null }} onRequestClose={() => {}}
            session={{ sessionId: 's1', machineId: 'm1' }} />);
        expect(screen.findHostByTestId('workflow-examples-popover-boundary')?.props.portal.sizeToContent).toBe(true);
    });
});
