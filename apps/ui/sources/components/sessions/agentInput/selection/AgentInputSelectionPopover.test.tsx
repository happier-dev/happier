import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ModalPortalTargetProvider, useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
    });
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedPopoverProps = Record<string, unknown> & {
    open: boolean;
    anchorRef: React.RefObject<any>;
    maxHeightCap?: number;
    maxWidthCap?: number;
    placement?: string;
    boundaryRef?: React.RefObject<any> | null;
    portal?: {
        web?: { target?: string };
        native?: boolean;
        matchAnchorWidth?: boolean;
        anchorAlign?: string;
    };
};

const capturedPopoverProps: { current: CapturedPopoverProps | null } = { current: null };

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        capturedPopoverProps.current = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: 312 })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, renderedChildren);
    },
}));

describe('AgentInputSelectionPopover', () => {
    it('uses the shared popover shell contract and forwards maxHeight to the content renderer', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;
        const requestClose = vi.fn();
        const renderContent = vi.fn(({ maxHeight }: { maxHeight: number }) => (
            React.createElement('View', { testID: `content:${maxHeight}` })
        ));

        const screen = await renderScreen(<AgentInputSelectionPopover
                    open
                    anchorRef={anchorRef}
                    onRequestClose={requestClose}
                    maxHeightCap={480}
                    maxWidthCap={512}
                >
                    {renderContent}
                </AgentInputSelectionPopover>);

        expect(capturedPopoverProps.current?.open).toBe(true);
        expect(capturedPopoverProps.current?.anchorRef).toBe(anchorRef);
        // On web, AgentInput popovers should default to the viewport boundary (ignore any boundary provider).
        expect(capturedPopoverProps.current?.boundaryRef).toBeNull();
        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.maxHeightCap).toBe(480);
        expect(capturedPopoverProps.current?.maxWidthCap).toBe(512);
        expect(capturedPopoverProps.current?.edgePadding).toEqual({ horizontal: 16 });
        expect(capturedPopoverProps.current?.portal).toEqual({
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
        });
        expect(capturedPopoverProps.current?.closeOnAnchorPress).toBe(false);
        expect(capturedPopoverProps.current?.consumeOutsidePointerDown).toBe(false);
        expect(capturedPopoverProps.current?.containerStyle).toEqual({ paddingHorizontal: 0 });
        expect(capturedPopoverProps.current?.backdrop).toEqual({
            style: { backgroundColor: 'transparent' },
            blockOutsidePointerEvents: false,
        });
        expect(renderContent).toHaveBeenCalledWith({ maxHeight: 312 });
        expect(screen.findByTestId('content:312')).toBeTruthy();
    });

    it('does not override an existing modal portal target on web', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const externalTarget = { tag: 'external-modal-portal-target' } as any;
        const anchorRef = { current: { nodeType: 'View' } } as any;

        const seenTargets: Array<Element | DocumentFragment | null> = [];
        function RecordTarget() {
            const target = useModalPortalTarget();
            seenTargets.push(target);
            return React.createElement('View', { testID: 'record-target' });
        }

        await renderScreen(
            <ModalPortalTargetProvider target={externalTarget}>
                <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                    {() => <RecordTarget />}
                </AgentInputSelectionPopover>
            </ModalPortalTargetProvider>,
        );

        expect(seenTargets.length).toBeGreaterThan(0);
        expect(seenTargets[seenTargets.length - 1]).toBe(externalTarget);
    });
});
