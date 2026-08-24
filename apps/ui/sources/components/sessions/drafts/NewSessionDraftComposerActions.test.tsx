import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const dimensions = vi.hoisted(() => ({ width: 1200, height: 800 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: 'Pressable',
        useWindowDimensions: () => ({ ...dimensions, scale: 1, fontScale: 1 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Readonly<Record<string, unknown>>) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({ toggle: vi.fn() })
            : null,
    ),
}));

describe('NewSessionDraftComposerActions', () => {
    beforeEach(() => {
        standardCleanup();
        dimensions.width = 1200;
    });

    it('keeps both actions directly reachable on wide composers', async () => {
        const { NewSessionDraftComposerActions } = await import('./NewSessionDraftComposerActions');
        const onStartAnother = vi.fn();
        const onDelete = vi.fn(async () => undefined);
        const screen = await renderScreen(
            <NewSessionDraftComposerActions
                deleteDisabled={false}
                onStartAnother={onStartAnother}
                onDelete={onDelete}
            />,
        );

        await act(async () => screen.findByTestId('new-session-draft-start-another')?.props.onPress());
        await act(async () => screen.findByTestId('new-session-draft-delete')?.props.onPress());
        expect(onStartAnother).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('new-session-draft-actions-menu')).toBeNull();
    });

    it('keeps Start another direct and moves only Delete into overflow on compact composers', async () => {
        dimensions.width = 390;
        const { NewSessionDraftComposerActions } = await import('./NewSessionDraftComposerActions');
        const screen = await renderScreen(
            <NewSessionDraftComposerActions
                deleteDisabled={false}
                onStartAnother={vi.fn()}
                onDelete={vi.fn(async () => undefined)}
            />,
        );

        expect(screen.findByTestId('new-session-draft-start-another')).toBeTruthy();
        expect(screen.findByTestId('new-session-draft-delete')).toBeNull();
        expect(screen.findByTestId('new-session-draft-actions-menu')).toBeTruthy();
        expect(screen.findByType('DropdownMenu' as React.ElementType).props.items[0]).toMatchObject({
            id: 'delete',
            testID: 'new-session-draft-delete',
        });
    });
});
