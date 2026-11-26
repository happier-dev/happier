import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
    useLayoutMaxWidth: () => 850,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

afterEach(() => {
    standardCleanup();
    vi.resetModules();
});

function textsInOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.findAllByType('Text' as never).map((node) => String(node.props.children));
}

async function renderGroup(presentation: 'page' | 'grouped', props: Readonly<{ description?: React.ReactNode }>) {
    const { ItemGroup } = await import('./ItemGroup');
    const { ListPresentationProvider } = await import('./listPresentation');
    return renderScreen(
        <ListPresentationProvider value={presentation}>
            <ItemGroup title="Session list" description={props.description}>
                {React.createElement('Text', null, 'ROW')}
            </ItemGroup>
        </ListPresentationProvider>,
    );
}

function sectionHeader(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const styleOf = (node: { props: { style?: unknown } }) => [node.props.style].flat(Infinity).filter(Boolean) as Array<Record<string, unknown>>;
    const directionOf = (node: { props: { style?: unknown } }) => styleOf(node)
        .reduce<unknown>((current, entry) => entry.flexDirection ?? current, undefined);
    const containsAction = (node: ReactTestInstance) =>
        node.findAll((child) => child.props?.testID === 'section-action').length > 0;
    const header = () => screen.findAll((node) => directionOf(node) !== undefined && containsAction(node)).at(-1)!;
    const action = () => header().findAll((node) => typeof node.props?.onLayout === 'function'
        && containsAction(node)).at(-1);
    return { header, action, direction: () => directionOf(header()) };
}

describe('ItemGroup page presentation', () => {
    it('announces a section title one level below the page title', async () => {
        const screen = await renderGroup('page', {});
        const title = screen.findAllByType('Text' as never).find((node) => node.props.children === 'Session list');
        expect(title?.props.accessibilityRole).toBe('header');
        expect(title?.props['aria-level']).toBe(2);
    });

    it('reads the section explanation before its rows on a configuration page', async () => {
        const screen = await renderGroup('page', { description: 'How sessions appear in the sidebar.' });
        expect(textsInOrder(screen)).toEqual(['Session list', 'How sessions appear in the sidebar.', 'ROW']);
    });

    it('reads a description with inline code as one description text, in the section description step', async () => {
        const screen = await renderGroup('page', {
            description: React.createElement(React.Fragment, null, 'Run it with ', React.createElement('Text', { testID: 'inline-code' }, 'happier project script run'), ' in a terminal.'),
        });
        const wrapping = screen.findAllByType('Text' as never).filter((node) => node.props.testID !== 'inline-code'
            && node.findAll((child) => child.props?.testID === 'inline-code').length > 0);
        expect(wrapping).toHaveLength(1);
    });

    it('keeps the footer after the rows outside page presentation (menus, pickers, sheets)', async () => {
        const screen = await renderGroup('grouped', { description: 'How sessions appear in the sidebar.' });
        const texts = textsInOrder(screen);
        expect(texts.indexOf('ROW')).toBeLessThan(texts.indexOf('How sessions appear in the sidebar.'));
    });

    it('keeps a grouped section title in sentence case (no uppercase eyebrow) in menus, pickers and sheets', async () => {
        const screen = await renderGroup('grouped', {});
        const title = screen.findAllByType('Text' as never).find((node) => node.props.children === 'Session list');
        expect(title).toBeDefined();
        const style = [title!.props.style].flat(Infinity).filter(Boolean) as Array<Record<string, unknown>>;
        const textTransform = style.reduce<unknown>((current, entry) => entry.textTransform ?? current, undefined);
        expect(textTransform === undefined || textTransform === 'none').toBe(true);
    });

    it('keeps a compact section action beside the title on a phone while the title keeps its column', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Add by address" action={React.createElement('Action', { testID: 'section-action' })}>
                    {React.createElement('Text', null, 'ROW')}
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const { direction, header, action } = sectionHeader(screen);
        const layout = (widths: Readonly<{ header: number; action: number }>) => act(async () => {
            header().props.onLayout({ nativeEvent: { layout: { width: widths.header, height: 40, x: 0, y: 0 } } });
            action()?.props.onLayout({ nativeEvent: { layout: { width: widths.action, height: 32, x: 0, y: 0 } } });
        });

        // A 390pt phone: a "Cancel"-sized action leaves the title well over its label column.
        await layout({ header: 358, action: 84 });
        expect(direction()).toBe('row');
        // Outer width alone suggests enough room, but the heading's two insets consume it.
        await layout({ header: 390, action: 160 });
        expect(direction()).toBe('column');
        // The same width with an action that would squeeze the title below its column.
        await layout({ header: 358, action: 160 });
        expect(direction()).toBe('column');
    });

    it.each([
        { width: 390, direction: 'column' },
        { width: 720, direction: 'row' },
    ])('places the adaptive section action on the first frame of a $width px page column', async ({ width, direction }) => {
        const { ItemGroup } = await import('./ItemGroup');
        const { ListPresentationProvider, PageFrameWidthsContext } = await import('./listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <PageFrameWidthsContext.Provider value={{ outer: 1440, column: width }}>
                    <ItemGroup title="Environment variables" description="Values used when starting a session."
                        actionLayout="adaptive" action={React.createElement('Action', { testID: 'section-action' })}>
                        {React.createElement('Text', null, 'ROW')}
                    </ItemGroup>
                </PageFrameWidthsContext.Provider>
            </ListPresentationProvider>,
        );
        expect(sectionHeader(screen).direction()).toBe(direction);
    });
});
