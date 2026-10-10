import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { StyleSheet } from 'react-native';
import Color from 'color';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDeleteDraft = vi.hoisted(() => vi.fn(async () => true));

// The shared press owner's motion tokens build their easing curves at import.
vi.mock('react-native-reanimated', () => ({ Easing: { bezier: () => (value: number) => value, linear: (value: number) => value } }));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: Record<string, unknown>) => React.createElement('Swipeable', props),
    GestureDetector: (props: React.PropsWithChildren) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: Record<string, unknown>) => React.createElement('ContextMenu', props),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: unknown) => [false, fn] }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: confirmDeleteDraft } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => ({
                'sessionDrafts.badge': 'Draft',
                'sessionDrafts.continueEditing': 'Continue editing',
                'sessionDrafts.delete.action': 'Delete draft',
                'sessionDrafts.delete.confirmTitle': 'Delete draft?',
                'sessionDrafts.delete.confirmDescription': 'This draft will be removed from your devices.',
                'common.cancel': 'Cancel',
                'common.delete': 'Delete',
            }[key] ?? key),
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useSession: () => null,
                useLocalSetting: ((_key: string) => null) as never,
            },
        });
    },
});

const { SessionItem } = await import('./SessionItem');

describe('SessionItem existing-session draft presentation', () => {
    afterEach(() => {
        standardCleanup();
        confirmDeleteDraft.mockClear();
    });

    it('keeps the session sheet transparent within the sidebar material', async () => {
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const session = createSessionFixture({ id: 'session-glass-row', active: false });
        const rowViewModel = createSessionItemRowViewModel({ session });
        const screen = await renderScreen(
            <GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320}
                titleStrip={null} rail={null} peek={null}
                column={<SessionItem session={session} rowViewModel={rowViewModel} />}>
                {null}
            </AppShellMaterialFrame>
            </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>,
        );
        const container = screen.root.findAll(node => typeof node.props.onPointerEnter === 'function')[0]!;
        const paint = StyleSheet.flatten(container.props.style);
        expect(Color(paint.backgroundColor).alpha()).toBe(0);
        expect(paint.opacity).toBeUndefined();
    });

    it('presents and deletes the repository draft without deleting the session row', async () => {
        const session = createSessionFixture({ id: 'session-draft-row', active: false });
        const onDeleteDraft = vi.fn(async () => undefined);
        const rowViewModel = createSessionItemRowViewModel({
            session,
            overrides: {
                draft: {
                    listed: true,
                    text: 'Fix the flaky release test',
                    preview: 'Fix the flaky release test',
                    status: 'clean',
                    conflict: null,
                    updatedAt: 10,
                },
            },
        });
        const screen = await renderScreen(
            <SessionItem session={session} rowViewModel={rowViewModel} onDeleteDraft={onDeleteDraft} />,
        );

        expect(screen.findByTestId('session-list-draft-indicator:session-draft-row')?.props.accessibilityLabel)
            .toBe('Draft, Fix the flaky release test');
        expect(screen.findByTestId('session-list-draft-preview:session-draft-row')?.props.children)
            .toBe('Draft · Fix the flaky release test');

        const hoverContainer = screen.root.findAll((node) => typeof node.props.onPointerEnter === 'function')[0];
        await act(async () => hoverContainer?.props.onPointerEnter());
        const menu = screen.findByType('DropdownMenu' as React.ElementType);
        expect(menu?.props.items).toContainEqual(expect.objectContaining({
            id: 'session-draft.delete',
            testID: 'session-draft-delete:existing-session:session-draft-row',
            title: 'Delete draft',
        }));

        await menu?.props.onSelect('session-draft.delete');

        expect(confirmDeleteDraft).toHaveBeenCalledWith(
            'Delete draft?',
            'This draft will be removed from your devices.',
            { confirmText: 'Delete', cancelText: 'Cancel', destructive: true },
        );
        expect(onDeleteDraft).toHaveBeenCalledTimes(1);
        expect(screen.findAllHostsByTestId('session-list-item-session-draft-row')).toHaveLength(1);
        expect(screen.findByTestId('session-list-item-session-draft-row')?.props.accessibilityActions)
            .toContainEqual({ name: 'deleteDraft', label: 'Delete draft' });
    });

    it('shows the reminder clock in a minimal session row', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createSessionFixture({ id: 'session-reminder-row', active: false });
        const rowViewModel = createSessionItemRowViewModel({
            session,
            overrides: {
                reminder: { state: 'scheduled', remindAt: Date.now() + 60_000 },
                subtitleOverride: '/workspace/project',
            },
        });
        const screen = await renderScreen(
            <SessionItem session={session} rowViewModel={rowViewModel} compact compactMinimal />,
        );

        expect(screen.findByTestId('session-list-reminder-indicator:session-reminder-row')).not.toBeNull();
        expect(rowViewModel.subtitleOverride).toBe('/workspace/project');
    });
});
