import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => importOriginal(),
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));


vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));


vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));


vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));


vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));


vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

function createSession() {
    return createSessionFixture({
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
    });
}

// Loaded once at collection: the module graph is heavy and must not count against a test's own timeout.
const { SessionItem: SessionItemModule } = await import('./SessionItem');

async function importSessionItem() {
    const SessionItem = SessionItemModule;
    return createModelBackedSessionItemTestComponent(SessionItem, {
        defaultRowViewModelOverrides: {
            activityAt: Date.now() - 60_000,
        },
    });
}

describe('SessionItem tags (web hover layout)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps compact tags in their place, hidden behind the hover actions, so the title never reflows', async () => {
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession()}
                serverId="server_a"
                selected={false}
                compact={true}
                tagsEnabled={true}
                tags={['v2']}
                allKnownTags={['v2']}
                onTogglePinned={vi.fn()}
            />,
        );

        const rightArea = screen.findByTestId('session-item-right-area');
        const rightAreaText = rightArea?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(rightAreaText).toContain('v2');

        await act(async () => {
            rightArea?.props.onPointerEnter?.({} as never);
        });

        // The tags keep their box (no reflow) but hide under the actions, out of the accessibility tree.
        const rest = screen.findByTestId('session-item-right-area:rest');
        const restText = rest?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(restText).toContain('v2');
        expect(Object.assign({}, ...[rest?.props.style].flat(Infinity).filter(Boolean)).opacity).toBe(0);
        expect(screen.findByTestId('session-item-tags-below-sess_1')).toBeNull();
        expect(screen.findAllByType('PinIcon')).toHaveLength(1);
    });
});
