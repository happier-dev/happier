import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ComposerKeyboardProvider } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';

let mockKeyboardHeight = 0;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: (value: any) => value.android ?? value.native ?? value.default ?? value.ios ?? null,
        },
        useWindowDimensions: () => ({ width: 2400, height: 1080 }),
    });
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => mockKeyboardHeight,
}));

type CapturedPopoverProps = Record<string, unknown> & {
    backdrop?: { blockOutsidePointerEvents?: boolean | string };
    gap?: number;
    keyboardBottomInset?: number;
    maxHeightCap?: number;
    placement?: string;
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

function createSharedValue<T>(value: T) {
    return { value };
}

function createRenderReadThrowingSharedValue(label: string) {
    return {
        get value(): number {
            throw new Error(`${label} must not be read during render`);
        },
        set value(_value: number) {},
    };
}

function createComposerKeyboardLayout(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        availablePanelHeight: createSharedValue(0),
        bottomInset: createSharedValue(0),
        composerHeight: createSharedValue(0),
        isKeyboardLiftSuppressed: createSharedValue(false),
        keyboardHeightForInset: createSharedValue(0),
        keyboardHeightLive: createSharedValue(0),
        keyboardProgress: createSharedValue(0),
        listBottomInset: createSharedValue(0),
        getKeyboardHeight: () => 0,
        retainKeyboardLift: () => () => {},
        setComposerMeasuredHeight: () => {},
        subscribeAvailablePanelHeight: () => () => {},
        subscribeKeyboardHeight: () => () => {},
        subscribeListBottomInset: () => () => {},
        ...overrides,
    } as any;
}

describe('AgentInputSelectionPopover (native placement)', () => {
    beforeEach(() => {
        mockKeyboardHeight = 0;
        capturedPopoverProps.current = null;
    });

    it('uses placement=top when the keyboard is not visible', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.gap).toBe(8);
    });

    it('keeps native chip popovers above the anchor when the keyboard is visible', async () => {
        mockKeyboardHeight = 320;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.keyboardBottomInset).toBe(320);
        expect(capturedPopoverProps.current?.gap).toBe(8);
        expect(capturedPopoverProps.current?.backdrop?.blockOutsidePointerEvents).toBe('above-anchor');
    });

    it('keeps the native keyboard inset while an open composer popover sees a passive height drop', async () => {
        mockKeyboardHeight = 320;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;
        const renderPopover = () => (
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>
        );

        const screen = await renderScreen(renderPopover());

        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.keyboardBottomInset).toBe(320);

        mockKeyboardHeight = 0;
        await screen.update(renderPopover());

        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.keyboardBottomInset).toBe(320);
    });

    it('caps native popover height to the shallow visible viewport left above a landscape keyboard', async () => {
        mockKeyboardHeight = 686;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover
                open
                anchorRef={anchorRef}
                maxHeightCap={420}
                onRequestClose={() => {}}
            >
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.maxHeightCap).toBe(197);
    });

    it('retains the composer keyboard lift while open inside a composer scaffold', async () => {
        mockKeyboardHeight = 320;
        const release = vi.fn();
        const retainKeyboardLift = vi.fn(() => release);
        const layout = createComposerKeyboardLayout({
            keyboardHeightLive: createSharedValue(320),
            retainKeyboardLift,
        });
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                    {() => <React.Fragment />}
                </AgentInputSelectionPopover>
            </ComposerKeyboardProvider>,
        );

        expect(retainKeyboardLift).toHaveBeenCalledTimes(1);

        act(() => {
            screen.tree.unmount();
        });

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('does not release the retained composer lift when passive keyboard height drops while open', async () => {
        mockKeyboardHeight = 320;
        const release = vi.fn();
        const retainKeyboardLift = vi.fn(() => release);
        const layout = createComposerKeyboardLayout({
            keyboardHeightForInset: createSharedValue(320),
            keyboardHeightLive: createSharedValue(320),
            retainKeyboardLift,
        });
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        const renderPopover = () => (
            <ComposerKeyboardProvider layout={layout}>
                <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                    {() => <React.Fragment />}
                </AgentInputSelectionPopover>
            </ComposerKeyboardProvider>
        );
        const screen = await renderScreen(renderPopover());

        expect(retainKeyboardLift).toHaveBeenCalledTimes(1);

        mockKeyboardHeight = 0;
        await screen.update(renderPopover());

        expect(retainKeyboardLift).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
    });

    it('uses the scaffold keyboard-height subscription without reading shared values during render', async () => {
        mockKeyboardHeight = 0;
        const layout = createComposerKeyboardLayout({
            keyboardHeightForInset: createRenderReadThrowingSharedValue('keyboardHeightForInset'),
            keyboardHeightLive: createRenderReadThrowingSharedValue('keyboardHeightLive'),
            getKeyboardHeight: () => 320,
            subscribeKeyboardHeight: (listener: (height: number) => void) => {
                listener(320);
                return () => {};
            },
        });
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                    {() => <React.Fragment />}
                </AgentInputSelectionPopover>
            </ComposerKeyboardProvider>,
        );

        expect(capturedPopoverProps.current?.placement).toBe('top');
        expect(capturedPopoverProps.current?.keyboardBottomInset).toBe(320);
    });
});
