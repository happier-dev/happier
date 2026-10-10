import * as React from 'react';
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

async function renderGroup(presentation: 'page' | 'grouped', props: Readonly<{ description?: string }>) {
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

/**
 * The section header and its action, both measured (layout is the platform boundary here): the header is
 * the measured view that lays the text and the action out; the action's own measured wrapper reports its width.
 */
function measuredSectionHeader(screen: Awaited<ReturnType<typeof renderScreen>>, act: (callback: () => Promise<void>) => Promise<void>) {
    const measured = () => screen.findAll((node) => typeof node.props?.onLayout === 'function'
        && node.findAll((child) => child.props?.testID === 'section-action').length > 0);
    const styleOf = (node: { props: { style?: unknown } }) => [node.props.style].flat(Infinity).filter(Boolean) as Array<Record<string, unknown>>;
    const header = () => measured().find((node) => styleOf(node).some((entry) => entry.flexDirection !== undefined))!;
    const action = () => measured().find((node) => node !== header()) ?? null;
    const direction = () => styleOf(header()).reduce<unknown>((current, entry) => entry.flexDirection ?? current, undefined);
    const layout = async (widths: Readonly<{ header: number; action: number }>) => act(async () => {
        header().props.onLayout({ nativeEvent: { layout: { width: widths.header, height: 40, x: 0, y: 0 } } });
        action()?.props.onLayout({ nativeEvent: { layout: { width: widths.action, height: 32, x: 0, y: 0 } } });
    });
    return { header, direction, layout };
}

describe('ItemGroup page presentation', () => {
    it('reads the section explanation before its rows on a configuration page', async () => {
        const screen = await renderGroup('page', { description: 'How sessions appear in the sidebar.' });
        expect(textsInOrder(screen)).toEqual(['Session list', 'How sessions appear in the sidebar.', 'ROW']);
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

    it('drops a section action beneath the title and description when the section is too narrow for both', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup
                    title="Agent"
                    description="How it appears when you start a session."
                    action={React.createElement('Action', { testID: 'section-action' })}
                >
                    {React.createElement('Text', null, 'ROW')}
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const { header, direction, layout } = measuredSectionHeader(screen, act);

        await layout({ header: PAGE_LIST_METRICS.rowStackBelowWidthPx + 200, action: 200 });
        expect(header()).toBeDefined();
        expect(direction()).toBe('row');
        await layout({ header: PAGE_LIST_METRICS.rowStackBelowWidthPx - 150, action: 200 });
        expect(direction()).toBe('column');
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
        const { direction, layout } = measuredSectionHeader(screen, act);

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

    it('moves an adaptive section action below its explanation on a phone and beside it on desktop', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Environment variables" description="Values used when starting a session."
                    actionLayout="adaptive" action={React.createElement('Action', { testID: 'section-action' })}>
                    {React.createElement('Text', null, 'ROW')}
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const { direction, layout } = measuredSectionHeader(screen, act);

        // Real source capture: the 390px phone's Add variable action measures 118px.
        await layout({ header: 390, action: 118 });
        expect(direction()).toBe('column');
        await layout({ header: 720, action: 118 });
        expect(direction()).toBe('row');
    });
});
