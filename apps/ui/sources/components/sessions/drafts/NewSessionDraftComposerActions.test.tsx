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
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/ui/icons/Icon')>()),
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
    NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE,
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
        expect(flattenStyle(startAnother.props.style).minHeight).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE);
        expect(flattenStyle(deleteAction.props.style).minHeight).toBe(NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE);
        await pressTestInstanceAsync(startAnother);
        await pressTestInstanceAsync(deleteAction);
        expect(onStartAnother).toHaveBeenCalledOnce();
        expect(onDelete).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('keeps Start another labelled and Delete a direct icon action, with no overflow, on compact layouts', async () => {
        windowState.width = 390;
        const onDelete = vi.fn(async () => undefined);
        const screen = await renderScreen(
            <NewSessionDraftComposerActions
                deleteDisabled={false}
                onStartAnother={vi.fn()}
                onDelete={onDelete}
            />,
        );

        expect(screen.findByTestId('new-session-draft-start-another')).toBeTruthy();
        expect(screen.findAllByType('DropdownMenu' as React.ElementType)).toHaveLength(0);
        expect(screen.findByTestId('new-session-draft-actions-menu')).toBeFalsy();
        const deleteAction = screen.findByTestId('new-session-draft-delete');
        if (!deleteAction) throw new Error('Expected the compact Delete draft action');
        expect(deleteAction.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(screen.findAll((node) => node.type === 'Text' && node.props.children === 'sessionDrafts.delete.action')).toHaveLength(0);
        await pressTestInstanceAsync(deleteAction);
        expect(onDelete).toHaveBeenCalledOnce();
        await screen.unmount();
    });
});
