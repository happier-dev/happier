import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from '../ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ioniconPropsState: Array<Record<string, unknown>> = [];

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options.web ?? options.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#777',
                    surfacePressedOverlay: '#333',
                    text: '#111',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('./ToolTimelineIconFrame', () => ({
    ToolTimelineIconFrame: ({ icon }: { icon: React.ReactNode }) => React.createElement('ToolTimelineIconFrame', { testID: 'tool-timeline-row-icon' }, icon),
}));

// The row renders through the icon seam now, so the local capture mock follows it there. The
// testID shape is unchanged so the assertions below keep working.
vi.mock('@/components/ui/icons/Icon', () => ({
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
    Icon: (props: Record<string, unknown>) => {
        ioniconPropsState.push(props);
        return React.createElement('Icon', { ...props, testID: `tool-timeline-ionicon:${String(props.name)}` });
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

describe('ToolTimelineRowHeader', () => {
    function readOpacity(style: unknown): number | undefined {
        const entries = Array.isArray(style) ? style : [style];
        const opacityEntries = entries.filter((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { opacity?: unknown }).opacity === 'number');
        if (opacityEntries.length === 0) {
            return undefined;
        }
        return (opacityEntries[opacityEntries.length - 1] as { opacity: number }).opacity;
    }

    function readAnimatedOpacity(style: unknown): number | undefined {
        const entries = Array.isArray(style) ? style.flat(Infinity) : [style];
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i] as { opacity?: unknown } | null;
            const opacity = entry && typeof entry === 'object' ? entry.opacity : undefined;
            if (typeof opacity === 'number') return opacity;
            const animated = opacity as { __getValue?: () => number } | undefined;
            if (typeof animated?.__getValue === 'function') return animated.__getValue();
        }
        return undefined;
    }

    function readStyleNumber(style: unknown, key: string): number | undefined {
        const entries = Array.isArray(style) ? style : [style];
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            if (typeof entry !== 'object' || entry === null) continue;
            const value = (entry as Record<string, unknown>)[key];
            if (typeof value === 'number') return value;
        }
        return undefined;
    }

    afterEach(() => {
        standardCleanup();
        ioniconPropsState.length = 0;
    });

    it('shows an open action button with arrow-square-out icon when canOpen is true', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');
        const callOrder: string[] = [];
        const onOpen = vi.fn(() => {
            callOrder.push('onOpen');
        });

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                subtitle="Sub"
                statusText="ok"
                onPress={() => {}}
                canOpen={true}
                onOpen={onOpen}
                openActionTestID="tool-timeline-row-open"
            />,
        );

        expect(ioniconPropsState.some((i) => i.name === 'arrow-square-out')).toBe(true);
    });

    it('renders the open action outside the primary row pressable on web', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={true}
                onOpen={() => {}}
                openActionTestID="tool-timeline-row-open"
            />,
        );

        const openButton = screen.findByTestId('tool-timeline-row-open');
        expect(openButton).toBeTruthy();
        expect(openButton!.parent?.type).not.toBe('Pressable');
    });

    it('keeps the tool title fixed while the subtitle yields first in compact widths', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Turn Diff"
                subtitle="Recap of the changes that occurred during this turn"
                onPress={() => {}}
                canOpen={false}
                onOpen={null}
            />,
        );

        const textNodes = screen.findAllByType('Text');
        const titleNode = textNodes.find((node) => node.props.children === 'Turn Diff');
        const subtitleNode = textNodes.find((node) => node.props.children === 'Recap of the changes that occurred during this turn');

        expect(titleNode).toBeTruthy();
        expect(subtitleNode).toBeTruthy();
        expect(readStyleNumber(titleNode!.props.style, 'flexShrink')).toBe(0);
        expect(readStyleNumber(subtitleNode!.props.style, 'flexShrink')).toBe(1);
        expect(readStyleNumber(subtitleNode!.props.style, 'minWidth')).toBe(0);
    });

    it('stops propagation before invoking the open action button callback', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');
        const callOrder: string[] = [];
        const onOpen = vi.fn(() => {
            callOrder.push('onOpen');
        });

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={true}
                onOpen={onOpen}
                openActionTestID="tool-timeline-row-open"
            />,
        );

        const openButton = screen.findByTestId('tool-timeline-row-open');
        expect(openButton).toBeTruthy();
        if (!openButton) {
            throw new Error('Expected open button to be present');
        }
        const stopPropagation = vi.fn(() => {
            callOrder.push('stopPropagation');
        });

        await act(async () => {
            openButton.props.onPress?.({ stopPropagation });
        });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(callOrder).toEqual(['stopPropagation', 'onOpen']);
    });

    it('keeps the open action visually hidden until hover on web', async () => {
        const { ToolTimelineRowHeader, TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={true}
                onOpen={() => {}}
                openActionTestID="tool-timeline-row-open"
            />,
        );

        const getRevealOpacity = () =>
            readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID)?.props.style);

        expect(getRevealOpacity()).toBe(0);

        await act(async () => {
            screen.findByTestId('tool-timeline-row-header')?.props.onPointerEnter?.();
        });

        expect(getRevealOpacity()).toBe(1);
    });

    it('reveals the pin and the open action from one hover state without changing title truncation', async () => {
        const { ToolTimelineRowHeader, TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID, TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID } =
            await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Turn Diff"
                subtitle="Recap of the changes that occurred during this turn"
                onPress={() => {}}
                canOpen={true}
                onOpen={() => {}}
                openActionTestID="tool-timeline-row-open"
                revealAction={React.createElement('Pressable', { testID: 'tool-timeline-row-pin' })}
            />,
        );

        const readTitleShrink = () => {
            const titleNode = screen.findAllByType('Text').find((node) => node.props.children === 'Turn Diff');
            return readStyleNumber(titleNode!.props.style, 'flexShrink');
        };
        const pinSlot = () => screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID);
        const openSlot = () => screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID);

        expect(pinSlot()?.findByProps({ testID: 'tool-timeline-row-pin' })).toBeTruthy();
        expect(openSlot()?.findByProps({ testID: 'tool-timeline-row-open' })).toBeTruthy();
        expect(readAnimatedOpacity(pinSlot()?.props.style)).toBe(0);
        expect(readAnimatedOpacity(openSlot()?.props.style)).toBe(0);
        const unhoveredTitleShrink = readTitleShrink();

        await act(async () => {
            screen.findByTestId('tool-timeline-row-header')?.props.onPointerEnter?.();
        });

        expect(readAnimatedOpacity(pinSlot()?.props.style)).toBe(1);
        expect(readAnimatedOpacity(openSlot()?.props.style)).toBe(1);
        expect(readTitleShrink()).toBe(unhoveredTitleShrink);
    });

    it('keeps the row actions revealed while the pointer moves from the row onto the action buttons', async () => {
        const { ToolTimelineRowHeader, TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID, TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID } =
            await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={true}
                onOpen={() => {}}
                openActionTestID="tool-timeline-row-open"
                revealAction={React.createElement('Pressable', { testID: 'tool-timeline-row-pin' })}
            />,
        );

        // The hover region is the whole header (row + action slots), so entering over
        // the row text reveals both actions...
        const header = screen.findByTestId('tool-timeline-row-header');
        await act(async () => {
            header?.props.onPointerEnter?.();
        });
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(1);
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID)?.props.style)).toBe(1);

        // ...and crossing out of the row pressable toward its sibling action slots must not
        // hide them. The pin button carries no hover wiring of its own, so nothing else can
        // hold the reveal open.
        await act(async () => {
            screen.findByTestId('tool-timeline-row')?.props.onHoverOut?.();
        });
        await act(async () => {
            screen.findByTestId('tool-timeline-row-pin')?.props.onHoverOut?.();
        });
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(1);
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID)?.props.style)).toBe(1);

        // Leaving the header region itself is what hides them again.
        await act(async () => {
            header?.props.onPointerLeave?.();
        });
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(0);
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID)?.props.style)).toBe(0);
    });

    it('keeps a pinned row pin visible without dragging the open-details action into view', async () => {
        const { ToolTimelineRowHeader, TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID, TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID } =
            await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={true}
                onOpen={() => {}}
                openActionTestID="tool-timeline-row-open"
                revealAction={React.createElement('Pressable', { testID: 'tool-timeline-row-pin' })}
                revealActionSticky
            />,
        );

        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(1);
        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID)?.props.style)).toBe(0);
    });

    it('reveals a hidden pin when keyboard focus reaches it, so it can never be activated while invisible', async () => {
        const { ToolTimelineRowHeader, TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={false}
                onOpen={null}
                revealAction={React.createElement('Pressable', { testID: 'tool-timeline-row-pin' })}
            />,
        );

        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(0);

        await act(async () => {
            screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.onFocus?.();
        });

        expect(readAnimatedOpacity(screen.findByTestId(TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID)?.props.style)).toBe(1);
    });

    it('crossfades the left icon to a chevron-down on hover when expandable (web)', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={false}
                onOpen={null}
                disclosure={{ behavior: 'hover', state: 'collapsed' }}
                testID="tool-timeline-row"
            />,
        );

        expect(ioniconPropsState.some((i) => i.name === 'caret-down')).toBe(true);

        const getChevronLayerOpacity = () => {
            const chevronIcon = screen.findByTestId('tool-timeline-ionicon:caret-down');
            expect(chevronIcon).toBeTruthy();
            return readOpacity(chevronIcon!.parent?.parent?.props.style);
        };

        expect(getChevronLayerOpacity()).toBe(0);

        await act(async () => {
            screen.findByTestId('tool-timeline-row-header')?.props.onPointerEnter?.();
        });

        expect(getChevronLayerOpacity()).toBe(1);
    });

    it('shows a persistent chevron-up when expanded by user', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        const screen = await renderScreen(
            <ToolTimelineRowHeader
                density="comfortable"
                icon={React.createElement('Text', null, 'ICON')}
                title="Title"
                onPress={() => {}}
                canOpen={false}
                onOpen={null}
                disclosure={{ behavior: 'persistent', state: 'expanded' }}
            />,
        );

        expect(ioniconPropsState.some((i) => i.name === 'caret-up')).toBe(true);
        expect(ioniconPropsState.some((i) => i.name === 'caret-down')).toBe(false);
    });
});
