import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen } from '@/dev/testkit';
import { EmptyState } from './EmptyState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

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

    it('omits the action slot when no action is provided', async () => {
        const screen = await renderScreen(
            <EmptyState icon={<Stub />} title="Nothing here" actionTestID="empty-action" />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('empty-action');
    });
});
