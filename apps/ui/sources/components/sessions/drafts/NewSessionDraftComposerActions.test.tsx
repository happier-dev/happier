import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

const windowState = vi.hoisted(() => ({ width: 800 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: 'Pressable',
        View: 'View',
        useWindowDimensions: () => ({ width: windowState.width, height: 600, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown> & {
        trigger: (args: { toggle: () => void }) => React.ReactNode;
    }) => React.createElement('DropdownMenu', props, props.trigger({ toggle: vi.fn() })),
}));

import {
    NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE,
    NewSessionDraftComposerActions,
} from './NewSessionDraftComposerActions';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('NewSessionDraftComposerActions', () => {
    beforeEach(() => {
        windowState.width = 800;
    });
    afterEach(() => standardCleanup());

    it('keeps both actions directly reachable on wide layouts with 44-point targets', async () => {
        const onStartAnother = vi.fn();
        const onDelete = vi.fn(async () => undefined);
        const screen = await renderScreen(
            <NewSessionDraftComposerActions
                deleteDisabled={false}
                onStartAnother={onStartAnother}
                onDelete={onDelete}
            />,
        );

        const startAnother = screen.findByTestId('new-session-draft-start-another');
        const deleteAction = screen.findByTestId('new-session-draft-delete');
        if (!startAnother || !deleteAction) throw new Error('Expected both wide draft actions');
        expect(flattenStyle(startAnother.props.style).minHeight).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE);
        expect(flattenStyle(deleteAction.props.style).minHeight).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE);
        await pressTestInstanceAsync(startAnother);
        await pressTestInstanceAsync(deleteAction);
        expect(onStartAnother).toHaveBeenCalledOnce();
        expect(onDelete).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('keeps Start another inline and moves Delete into overflow on compact layouts', async () => {
        windowState.width = 390;
        const screen = await renderScreen(
            <NewSessionDraftComposerActions
                deleteDisabled
                onStartAnother={vi.fn()}
                onDelete={vi.fn(async () => undefined)}
            />,
        );

        expect(screen.findByTestId('new-session-draft-start-another')).toBeTruthy();
        const menu = screen.findByType('DropdownMenu' as React.ElementType);
        expect(screen.findByTestId('new-session-draft-actions-menu')).toBeTruthy();
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'delete', testID: 'new-session-draft-delete', disabled: true }),
        ]));
        const menuTrigger = screen.findByTestId('new-session-draft-actions-menu');
        if (!menuTrigger) throw new Error('Expected compact draft actions menu');
        const triggerStyle = flattenStyle(menuTrigger.props.style);
        expect(triggerStyle.minHeight).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE);
        expect(triggerStyle.minWidth).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE);
        await screen.unmount();
    });
});
