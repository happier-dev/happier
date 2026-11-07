import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'sessionDrafts.badge') return 'Draft';
                if (key === 'sessionDrafts.continueEditing') return 'Continue editing';
                if (key === 'sessionDrafts.delete.action') return 'Delete draft';
                return key;
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                }),
                useSession: () => null,
            },
        });
    },
});
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({ Swipeable: 'Swipeable' }));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => '/workspace/project',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        state: 'waiting',
        isConnected: true,
        statusText: '',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
        shouldShowStatus: false,
    }),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (_fn: unknown) => [false, vi.fn()] }));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});

const SESSION_ID = 'session-draft-row';
const PREVIEW = 'Fix the flaky release test';

function createSession() {
    return {
        id: SESSION_ID,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadata: { name: 'Release work', path: '/workspace/project' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    } as any;
}

async function renderDraftRow(density: 'default' | 'compact' | 'minimal') {
    const { SessionItem } = await import('./SessionItem');
    const session = createSession();
    const compact = density !== 'default';
    const compactMinimal = density === 'minimal';
    const rowModel = createSessionItemTestRowModel({
        session,
        serverId: 'server-a',
        isFirst: true,
        isLast: true,
        isSingle: true,
        compact,
        compactMinimal,
        subtitleOverride: '/workspace/project',
    });

    return renderScreen(
        <SessionItem
            session={session}
            rowModel={{
                ...rowModel,
                draft: { preview: PREVIEW },
            } as typeof rowModel}
        />,
    );
}

describe('SessionItem existing-session draft presentation', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shows a localized badge and one-line preview at default density', async () => {
        const screen = await renderDraftRow('default');

        const indicator = screen.findByTestId(`session-list-draft-indicator:${SESSION_ID}`);
        expect(indicator?.props.accessibilityLabel).toBe(`Draft, ${PREVIEW}`);
        expect(indicator?.props.accessibilityHint).toBe('Continue editing');
        expect(screen.findByTestId(`session-list-draft-preview:${SESSION_ID}`)?.props.children)
            .toBe(`Draft · ${PREVIEW}`);
    });

    it.each(['compact', 'minimal'] as const)(
        'keeps the stable accessible draft indicator at %s density without adding another session row',
        async (density) => {
            const screen = await renderDraftRow(density);

            const indicator = screen.findByTestId(`session-list-draft-indicator:${SESSION_ID}`);
            expect(indicator?.props.accessibilityLabel).toBe(`Draft, ${PREVIEW}`);
            expect(screen.findAllByTestId(`session-list-item-${SESSION_ID}`)).toHaveLength(1);
        },
    );

    it('does not offer draft deletion from an existing-session row', async () => {
        const screen = await renderDraftRow('default');
        const hoverContainer = screen.root.findAll((node) => typeof node.props.onPointerEnter === 'function')[0];
        await act(async () => hoverContainer?.props.onPointerEnter());
        const menu = screen.findByType('DropdownMenu' as React.ElementType);

        expect(menu?.props.items.map((item: { title: string }) => item.title)).not.toContain('Delete draft');
        const row = screen.findByTestId(`session-list-item-${SESSION_ID}`);
        expect(row?.props.accessibilityActions ?? []).not.toContainEqual({ name: 'deleteDraft', label: 'Delete draft' });
    });

    it('keeps a compact clock visible in a narrow row without replacing its subtitle', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createSession();
        const rowModel = createSessionItemTestRowModel({
            session,
            serverId: 'server-a',
            compact: true,
            compactMinimal: true,
            subtitleOverride: '/workspace/project',
        });
        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowModel={{
                    ...rowModel,
                    reminder: { state: 'scheduled', remindAt: Date.now() + 60_000 },
                }}
            />,
        );

        expect(screen.findByTestId(`session-list-reminder-indicator:${SESSION_ID}`)).not.toBeNull();
        expect(rowModel.subtitle).toBe('/workspace/project');
    });
});
