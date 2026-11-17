import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen } from '@/dev/testkit';
import { HAPPIER_MENU_ROW_METRICS, HAPPIER_STATE_LINE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { EmptyState } from './EmptyState';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

/** Host-element placeholder so passed-in icon/action nodes carry a discoverable testID. */
const Stub = (props: { testID?: string }) => React.createElement('Stub', props);

describe('EmptyState', () => {
    it('renders the icon, title and subtitle', async () => {
        const screen = await renderScreen(
            <EmptyState
                testID="empty"
                icon={<Stub testID="empty-icon" />}
                title="No accounts yet"
                subtitle="Connect an account to get started"
                titleTestID="empty-title"
                subtitleTestID="empty-subtitle"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('empty');
        expect(ids).toContain('empty-icon');

        const title = screen.findByTestId('empty-title');
        expect(title?.props.children).toBe('No accounts yet');
        const subtitle = screen.findByTestId('empty-subtitle');
        expect(subtitle?.props.children).toBe('Connect an account to get started');
    });

    it('names a page it stands alone on with a level-one heading, and stays a section heading under a page header', async () => {
        // C77: /projects with no project drew only "No projects yet", and the page had no heading at all.
        const state = <EmptyState layout="page" title="No projects yet" subtitle="Add one to start" titleTestID="empty-title" />;
        const heading = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const title = screen.findHostByTestId('empty-title')!;
            return [title.props.accessibilityRole, title.props['aria-level']];
        };
        const alone = await renderScreen(state);
        expect(heading(alone)).toEqual(['header', 1]);
        const underHeader = await renderScreen(<ListPresentationProvider value="page">{state}</ListPresentationProvider>);
        expect(heading(underHeader)).toEqual(['header', 2]);
        // C77 (Workflows first visit, 11-17): a page column with no header of its own is named by its state.
        const headerless = await renderScreen(<ListPresentationProvider value="page">
            <EmptyState layout="page" namesPage title="Save prompts that work" titleTestID="empty-title" />
        </ListPresentationProvider>);
        expect(heading(headerless)).toEqual(['header', 1]);
        const centered = await renderScreen(<EmptyState title="Nothing here" titleTestID="empty-title" />);
        expect(heading(centered)).toEqual([undefined, undefined]);
    });

    it('renders the action when provided', async () => {
        const screen = await renderScreen(
            <EmptyState
                icon={<Stub />}
                title="No pools yet"
                action={<Stub testID="cta" />}
                actionTestID="empty-action"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('empty-action');
        expect(ids).toContain('cta');
    });

    it('keeps every slot in reading order in the inline add layout', async () => {
        const screen = await renderScreen(
            <EmptyState
                testID="connect"
                variant="add"
                layout="inline"
                icon={<Stub testID="marks" />}
                title="Connect another service"
                subtitle="Gemini, Copilot and GitHub."
                titleTestID="connect-title"
                subtitleTestID="connect-subtitle"
                action={<Stub testID="connect-cta" />}
                actionTestID="connect-action"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Mark, then what it is, then what it offers, then the action: the order a reader meets them.
        expect(ids.filter((id) => ['marks', 'connect-title', 'connect-subtitle', 'connect-cta'].includes(id)))
            .toEqual(['marks', 'connect-title', 'connect-subtitle', 'connect-cta']);
        expect(screen.findByTestId('connect-title')?.props.children).toBe('Connect another service');
    });

    it('keeps the centered slots when the add variant frames them', async () => {
        const screen = await renderScreen(
            <EmptyState
                testID="pool-empty"
                variant="add"
                icon={<Stub testID="pool-mark" />}
                title="Add accounts to this pool"
                action={<Stub testID="pool-cta" />}
                actionTestID="pool-action"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toEqual(expect.arrayContaining(['pool-empty', 'pool-mark', 'pool-action', 'pool-cta']));
        // One element carries the state's test id, whether or not it is framed.
        expect(ids.filter((id) => id === 'pool-empty')).toHaveLength(1);
    });

    it('offers a quiet second way forward under the primary action, and only with one', async () => {
        const openPolicy = vi.fn();

        const screen = await renderScreen(
            <EmptyState
                layout="page"
                iconName="users"
                title="No Teams yet"
                primaryAction={{ label: 'New Team', onPress: vi.fn(), testID: 'empty-create' }}
                secondaryAction={{ label: 'Let everyone create Teams', onPress: openPolicy, testID: 'empty-open-policy' }}
            />,
        );
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => id === 'empty-create' || id === 'empty-open-policy'))
            .toEqual(['empty-create', 'empty-open-policy']);
        await screen.pressByTestIdAsync('empty-open-policy');
        expect(openPolicy).toHaveBeenCalledTimes(1);

        const withoutPrimary = await renderScreen(
            <EmptyState
                layout="page"
                title="No Teams yet"
                actionUnavailableReason="Ask an administrator."
                secondaryAction={{ label: 'Let everyone create Teams', onPress: openPolicy, testID: 'lonely-secondary' }}
            />,
        );
        expect(collectRenderedTestIds(withoutPrimary.tree.toJSON())).not.toContain('lonely-secondary');
    });

    it('offers a question-led second door beneath the action row, after the primary (journey-deploy empty)', async () => {
        const describe = vi.fn();
        const screen = await renderScreen(
            <EmptyState
                layout="page"
                title="Nothing deployed yet"
                primaryAction={{ label: 'Deploy an app', onPress: vi.fn(), testID: 'empty-deploy' }}
                prompt={{ question: 'Not sure where to start?', action: { label: 'Describe your app', onPress: describe, testID: 'empty-describe' } }}
            />,
        );
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => id === 'empty-deploy' || id === 'empty-describe')).toEqual(['empty-deploy', 'empty-describe']);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Not sure where to start?');
        await screen.pressByTestIdAsync('empty-describe');
        expect(describe).toHaveBeenCalledTimes(1);
    });

    it('says a list line\'s ways forward as quiet inline links, in order', async () => {
        const showAll = vi.fn();
        const archived = vi.fn();

        const screen = await renderScreen(
            <EmptyState
                layout="line"
                title="Nothing in My work."
                primaryAction={{ label: 'Show all sessions', onPress: showAll, testID: 'line-show-all' }}
                secondaryAction={{ label: 'Archived', onPress: archived, testID: 'line-archived' }}
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => id === 'line-show-all' || id === 'line-archived'))
            .toEqual(['line-show-all', 'line-archived']);
        const link = screen.findByTestId('line-show-all');
        expect(link?.props.accessibilityRole).toBe('button');
        expect(link?.props.accessibilityLabel).toBe('Show all sessions');
        await screen.pressByTestIdAsync('line-show-all');
        await screen.pressByTestIdAsync('line-archived');
        expect(showAll).toHaveBeenCalledTimes(1);
        expect(archived).toHaveBeenCalledTimes(1);
    });

    it('draws a list line through the one shared state line: its geometry, and a loading ring at the line\'s glyph size', async () => {
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.flat(Infinity).filter(Boolean).map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});
        const hostStyle = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => flatten(
            screen.tree.root.findAll((node) => typeof node.type === 'string' && node.props?.testID === testID)[0]?.props.style,
        );

        const list = await renderScreen(<EmptyState layout="line" testID="line" lineLoading title="Looking for sessions" />);
        expect(hostStyle(list, 'line').minHeight).toBe(HAPPIER_STATE_LINE_METRICS.minHeightPx);
        const ring = list.tree.root.findAll((node) => typeof node.type !== 'string' && node.props?.testID === 'line-loading-spinner')[0];
        // A row's density never re-sizes the line's quiet ring into a row glyph.
        expect(ring?.props.size).toBe(HAPPIER_STATE_LINE_METRICS.glyphPx - 2);

        // Among menu rows the line keeps the menu's density.
        const menu = await renderScreen(<EmptyState layout="line" testID="menu-line" lineDensity="menu" title="No matches" />);
        expect(hostStyle(menu, 'menu-line').minHeight).toBe(HAPPIER_MENU_ROW_METRICS.minHeightPx);
    });

    it('keeps a list line\'s explanation whole instead of cutting it to one line', async () => {
        const explanation = 'None of your machines is online. Services appear when one is, from the agents it runs.';

        const screen = await renderScreen(
            <EmptyState layout="line" title="No services to connect yet" subtitle={explanation} />,
        );

        const subtitle = screen.tree.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.children === explanation
        ))[0];
        expect(subtitle).toBeDefined();
        expect(subtitle?.props.numberOfLines ?? 0).toBe(0);
    });

    it('frames a page state with the dashed "add something here" outline only when it invites adding', async () => {
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});

        const add = await renderScreen(
            <EmptyState testID="pools" layout="page" variant="add" title="No pools yet" primaryAction={{ label: 'New pool', onPress: () => {} }} />,
        );
        expect(flatten(add.findHostByTestId('pools')?.props.style).borderStyle).toBe('dashed');

        // "All caught up", informational and offline page states are not invitations: no frame.
        const caughtUp = await renderScreen(<EmptyState testID="inbox" layout="page" title="You're all caught up" />);
        const style = flatten(caughtUp.findHostByTestId('inbox')?.props.style);
        expect(style.borderStyle).toBeUndefined();
        expect(style.borderWidth ?? 0).toBe(0);
    });

    it('takes the page column itself, but not a second time inside a section that already sits in it', async () => {
        const state = <EmptyState testID="tokens" layout="page" variant="add" title="No API tokens yet" />;
        const onPage = await renderScreen(<ListPresentationProvider value="page">{state}</ListPresentationProvider>);
        expect(onPage.findAllByType(PageContentColumn)).toHaveLength(1);

        const inSection = await renderScreen(
            <ListPresentationProvider value="page"><SectionLeadingColumnProvider>{state}</SectionLeadingColumnProvider></ListPresentationProvider>,
        );
        expect(inSection.findAllByType(PageContentColumn)).toHaveLength(0);
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});
        const sectionStyle = flatten(inSection.findHostByTestId('tokens')?.props.style);
        expect(sectionStyle.marginHorizontal).toBe(0);
        expect(sectionStyle.marginTop).toBe(0);
        expect(flatten(onPage.findHostByTestId('tokens')?.props.style).marginHorizontal).toBeGreaterThan(0);
    });

    it('omits the action slot when no action is provided', async () => {
        const screen = await renderScreen(
            <EmptyState icon={<Stub />} title="Nothing here" actionTestID="empty-action" />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('empty-action');
    });
});
