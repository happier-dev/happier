import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ModalPortalTargetProvider, useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

const windowWidthState = vi.hoisted(() => ({ value: 480 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
        useWindowDimensions: () => ({
            width: windowWidthState.value,
            height: 800,
            scale: 1,
            fontScale: 1,
        }),
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
        topBottomLayout?: string;
    };
};

const capturedPopoverProps: { current: CapturedPopoverProps | null } = { current: null };

vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
    },
    Popover: (props: CapturedPopoverProps) => {
        capturedPopoverProps.current = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: 312 })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, renderedChildren);
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
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
        expect(capturedPopoverProps.current?.edgePadding).toEqual({ horizontal: 12, vertical: 12 });
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
        expect(renderContent).toHaveBeenCalledWith({ maxHeight: 312, presentation: 'popover' });
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

    it('keeps the wider edge padding on desktop-sized web layouts', async () => {
        windowWidthState.value = 1024;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        // The desktop title strip (tabs, window controls) stays clear above; below keeps the ordinary margin.
        expect(capturedPopoverProps.current?.edgePadding).toEqual({ horizontal: 16, vertical: 16, top: 56 });

        windowWidthState.value = 480;
    });

    it('opens every composer popover above its chip (owner 2026-10-18) and below it only when the room above cannot hold its content', async () => {
        windowWidthState.value = 1440;
        const { resolveHappierPopoverPlacement } = await import('@happier-dev/plugin-ui/presentation');
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const { AgentInputPopoverClearanceContext, AgentInputPopoverColumnContext } = await import('./useAgentInputPopoverLayout');
        const anchorRef = { current: { nodeType: 'View' } } as any;
        const composerRef = { current: { nodeType: 'View' } } as any;
        const columnRef = { current: { nodeType: 'View' } } as any;
        await renderScreen(
            <AgentInputPopoverClearanceContext.Provider value={composerRef}>
                <AgentInputPopoverColumnContext.Provider value={columnRef}>
                    <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}} maxHeightCap={560}>
                        {() => <React.Fragment />}
                    </AgentInputSelectionPopover>
                </AgentInputPopoverColumnContext.Provider>
            </AgentInputPopoverClearanceContext.Provider>,
        );
        // The chip itself is the vertical anchor: the picker may overlap the composer's text.
        expect(capturedPopoverProps.current?.clearanceRef).toBeUndefined();
        // Horizontally it stays inside the composer: a chip near its end does not hang a wide picker past it.
        expect(capturedPopoverProps.current?.horizontalBoundaryRef).toBe(columnRef);
        const decide = (available: Readonly<{ top: number; bottom: number }>) => resolveHappierPopoverPlacement({
            placement: capturedPopoverProps.current?.placement as 'top' | 'bottom',
            preferredMinAvailable: (capturedPopoverProps.current?.placementMinSpace as number | undefined) ?? 560,
            flip: capturedPopoverProps.current?.flip !== false,
            available: { ...available, left: 0, right: 0 },
        });
        // The Home composer at 1440×900, and the chat composer at the window's bottom: above.
        expect(decide({ top: 400, bottom: 256 })).toBe('top');
        expect(decide({ top: 360, bottom: 12 })).toBe('top');
        // A composer high in the window (first-run Home, New Session): the room above cannot hold the
        // popover's content, so it opens below rather than clipping it to a sliver (calm-shell ruling 2026-11-01).
        expect(decide({ top: 75, bottom: 640 })).toBe('bottom');
        expect(decide({ top: 120, bottom: 640 })).toBe('bottom');
        windowWidthState.value = 480;
    });

    it('lets a chip picker use the window\'s width where the composer floats as a narrow card (Docked New)', async () => {
        windowWidthState.value = 1440;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const { AgentInputPopoverColumnContext, AgentInputPopoverWidthContext } = await import('./useAgentInputPopoverLayout');
        const anchorRef = { current: { nodeType: 'View' } } as any;
        const columnRef = { current: { nodeType: 'View' } } as any;
        await renderScreen(
            <AgentInputPopoverWidthContext.Provider value="window">
                <AgentInputPopoverColumnContext.Provider value={columnRef}>
                    <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                        {() => <React.Fragment />}
                    </AgentInputSelectionPopover>
                </AgentInputPopoverColumnContext.Provider>
            </AgentInputPopoverWidthContext.Provider>,
        );
        // The card is narrower than the pickers it opens: they extend past it, bounded by the window only.
        expect(capturedPopoverProps.current?.horizontalBoundaryRef).toBeUndefined();
        windowWidthState.value = 480;
    });

    it('drops a document composer\'s chip picker below its chip when the room above cannot hold it (a Run now form at the window top)', async () => {
        windowWidthState.value = 1440;
        const { resolveHappierPopoverPlacement } = await import('@happier-dev/plugin-ui/presentation');
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const { AgentInputDocumentPanelContext } = await import('./useAgentInputPopoverLayout');
        const anchorRef = { current: { nodeType: 'View' } } as any;
        await renderScreen(
            <AgentInputDocumentPanelContext.Provider value>
                <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}} maxHeightCap={560}>
                    {() => <React.Fragment />}
                </AgentInputSelectionPopover>
            </AgentInputDocumentPanelContext.Provider>,
        );
        const decide = (available: Readonly<{ top: number; bottom: number }>) => resolveHappierPopoverPlacement({
            placement: capturedPopoverProps.current?.placement as 'top' | 'bottom',
            preferredMinAvailable: (capturedPopoverProps.current?.placementMinSpace as number | undefined) ?? 560,
            flip: capturedPopoverProps.current?.flip !== false,
            available: { ...available, left: 0, right: 0 },
        });
        // A step card mid-page keeps the composer placement: above its chip.
        expect(decide({ top: 400, bottom: 256 })).toBe('top');
        // The Run now form hangs from the page header: 130 above, the page below.
        expect(decide({ top: 130, bottom: 640 })).toBe('bottom');
        windowWidthState.value = 480;
    });

    it('forwards an explicit top/bottom portal layout override to the shared popover', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover
                open
                anchorRef={anchorRef}
                onRequestClose={() => {}}
                portalTopBottomLayout="boundary"
            >
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.portal).toMatchObject({
            topBottomLayout: 'boundary',
        });
    });
    it('opens a + menu row picker beside its row; Left and dismissals return to the menu', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const { AgentInputActionMenuSubmenuContext } = await import('./agentInputActionMenuSubmenu');
        const row = { focus: vi.fn() };
        const anchorRef = { current: row } as any;
        const requestClose = vi.fn();
        const returnToMenu = vi.fn();
        const onSurfacePointerChange = vi.fn();

        let contentDismiss: (() => void) | undefined;
        const screen = await renderScreen(<AgentInputActionMenuSubmenuContext.Provider value={{ title: 'Default session type', returnToMenu, onSurfacePointerChange }}>
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={requestClose}>
                {({ dismiss }) => { contentDismiss = dismiss; return React.createElement('View', { testID: 'picker' }); }}
            </AgentInputSelectionPopover>
        </AgentInputActionMenuSubmenuContext.Provider>);

        expect(capturedPopoverProps.current?.placement).toBe('auto-horizontal');
        expect(capturedPopoverProps.current?.portal).toMatchObject({ anchorAlignVertical: 'start' });
        // Focus moves into the submenu as it opens, so Left and Escape work from inside it.
        expect(capturedPopoverProps.current?.autoFocusOnOpen).toBe(true);
        // On a phone it is a sheet, so the shared Popover pushes it inside the menu's sheet, named by its row.
        expect(capturedPopoverProps.current?.phonePresentation).toBe('sheet');
        expect(capturedPopoverProps.current?.accessibilityLabel).toBe('Default session type');

        const surface = screen.findByTestId('agent-input-submenu-surface');
        // Left inside a field keeps its caret.
        surface?.props.onKeyDown({ nativeEvent: { key: 'ArrowLeft' }, target: { tagName: 'INPUT' } });
        expect(returnToMenu).not.toHaveBeenCalled();
        surface?.props.onKeyDown({ nativeEvent: { key: 'ArrowLeft' }, target: { tagName: 'DIV' }, preventDefault: () => {} });
        expect(returnToMenu).toHaveBeenCalledTimes(1);
        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(row.focus).toHaveBeenCalled();

        // The popover's own dismissal (Escape, an outside press) returns to the menu too.
        (capturedPopoverProps.current as { onRequestClose?: () => void } | null)?.onRequestClose?.();
        expect(returnToMenu).toHaveBeenCalledTimes(2);
        expect(requestClose).toHaveBeenCalledTimes(2);

        // The content's own dismissal (a list's Escape) returns to the menu as well.
        contentDismiss?.();
        expect(returnToMenu).toHaveBeenCalledTimes(3);

        surface?.props.onPointerEnter({ pointerType: 'mouse' });
        expect(onSurfacePointerChange).toHaveBeenCalledWith(true, { pointerType: 'mouse' });
    });
    it('opens toward the side that holds what its content needs, flipping when the preferred side cannot', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        await renderScreen(<AgentInputSelectionPopover open anchorRef={{ current: { nodeType: 'View' } } as any}
            onRequestClose={() => {}} maxHeightCap={480} contentRoom={480}>
            {() => React.createElement('View', { testID: 'fixed-list' })}
        </AgentInputSelectionPopover>);
        // The shared Popover flips to the roomier side when the preferred one cannot hold this much.
        expect(capturedPopoverProps.current?.placementMinSpace).toBe(480);
        expect(capturedPopoverProps.current?.flip).toBe(true);
    });
});
