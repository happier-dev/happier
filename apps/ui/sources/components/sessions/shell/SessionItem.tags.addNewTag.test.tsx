import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'ios',
                                            },
                                        }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
    useSession: () => null,
    useSessionListMeaningfulActivityAt: () => null,
});
});

const promptSpy = vi.fn(async () => 'new-tag');
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: promptSpy,
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SessionItem tags (new tag)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('creates a new tag via the tag dropdown create action and adds it to active tags', async () => {
        promptSpy.mockClear();
        const onSetTags = vi.fn();

        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                tagsEnabled={true}
                tags={[]}
                allKnownTags={[]}
                onSetTags={onSetTags}
            />,
        );

        const stableItemLocator = screen.findAll((node: any) => {
            return node.type === 'Pressable' && node.props?.testID === 'session-list-item-sess_1';
        });
        expect(stableItemLocator).toHaveLength(1);

        const tagButton = screen.findByProps({ testID: 'session-item-tag-action' });
        expect(tagButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(tagButton);
        });

        const dropdowns = screen.findAllByType('DropdownMenu');
        const dropdown = dropdowns.find((d: any) => d.props.search === true);
        expect(dropdown).toBeTruthy();
        if (!dropdown) {
            throw new Error('Tag dropdown not found');
        }
        expect(dropdown.props.emptyLabel).toBe(null);
        expect(dropdown.props.showCategoryTitles).toBe(false);
        expect(typeof dropdown.props.createItemDisplay).toBe('function');

        const createDisplay = dropdown.props.createItemDisplay('ddd');
        expect(createDisplay.leftGap).toBe(8);
        expect(createDisplay.titleStyle).toMatchObject({ fontSize: 14 });
        expect(createDisplay.rowContainerStyle).toMatchObject({ paddingVertical: 6 });

        await act(async () => {
            invokeTestInstanceHandler(dropdown, 'onCreateItem', 'new-tag');
        });

        expect(promptSpy).not.toHaveBeenCalled();
        await act(async () => {});

        expect(onSetTags).toHaveBeenCalledWith(['new-tag']);
    });
});
