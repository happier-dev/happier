import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionMobileSurface } from './sessionCockpitState';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const persistedStorage = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistedStorage.get(key);
        }

        set(key: string, value: string) {
            persistedStorage.set(key, value);
        }

        delete(key: string) {
            persistedStorage.delete(key);
        }

        getAllKeys() {
            return [...persistedStorage.keys()];
        }

        clearAll() {
            persistedStorage.clear();
        }
    }

    return { MMKV };
});

const transcriptState = vi.hoisted(() => ({
    ids: [] as string[],
    messagesById: {} as Record<string, unknown>,
}));

installNavigationCommonModuleMocks({
    // The cockpit tree reaches far more typography styles than the navigation panel alone,
    // so keep the real constants rather than a narrow stub.
    typography: async () => await vi.importActual('@/constants/Typography'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Boundary stub for the RN list host: `any` mirrors the untyped mock-module shape.
            FlatList: ({ data, renderItem, keyExtractor, ...rest }: any) => React.createElement(
                'FlatList',
                rest,
                (data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor ? keyExtractor(item, index) : String(index) },
                    renderItem?.({ item, index }),
                )),
            ),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useForkedTranscriptSnapshot: () => null,
            useSessionTranscriptIds: () => ({ ids: transcriptState.ids, isLoaded: true }),
            useSessionMessagesById: () => transcriptState.messagesById,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
        });
    },
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/session-1' }).module;
});

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown> & { contentOverride?: React.ReactNode }) => React.createElement(
        'SessionView',
        props,
        props.contentOverride ?? null,
    ),
}));

// Sibling cockpit surfaces are irrelevant here and pull very large module graphs.
vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: Record<string, unknown>) => React.createElement('SessionDetailsPanel', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('SessionBrowseFilesSurface', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: (props: Record<string, unknown>) => React.createElement('SessionGitSurface', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionTerminalSurface', () => ({
    SessionTerminalSurface: (props: Record<string, unknown>) => React.createElement('SessionTerminalSurface', props),
}));
vi.mock('@/components/browser/surfaces/BrowserMobileSurfaceScreen', () => ({
    BrowserMobileSurfaceScreen: (props: Record<string, unknown>) => React.createElement('BrowserMobileSurfaceScreen', props),
}));
vi.mock('./SessionServicesSurfaceScreen', () => ({
    SessionServicesSurfaceScreen: (props: Record<string, unknown>) => React.createElement('SessionServicesSurfaceScreen', props),
}));
vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHost', props),
}));
vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        machineId: null,
        serverId: null,
        interactionEnabled: false,
        platform: 'web',
    }),
}));
vi.mock('@/components/sessions/localServices/useServicesOpenInBrowser', () => ({
    useServicesOpenInBrowser: () => () => {},
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-1', basePath: '/repo' }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));
vi.mock('@/components/appShell/panes/hooks/useDetailsTabCount', () => ({
    useDetailsTabCount: () => 0,
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/store/hooks', () => ({ useActiveServerAccountScope: () => null }));
vi.mock('@/sync/sync', () => ({ sync: { prefetchForkedTranscriptContext: async () => undefined } }));
vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistoryRemoteEntries: () => ({
        rows: [],
        hasMore: false,
        nextBeforeSeq: null,
        pagesLoaded: 0,
        pendingEncryption: false,
        requestNextPage: () => {},
    }),
}));

const SCREEN_TEST_ID = 'session-transcript-navigation-screen';
const ENTRY_TEST_ID = 'session-transcript-navigation-entry:session-1:user-turn:3';

function userMessage(id: string, seq: number, text: string): Message {
    return {
        id,
        localId: null,
        seq,
        createdAt: seq * 1000,
        kind: 'user-text',
        text,
        displayText: text,
    } as unknown as Message;
}

function seedTranscript() {
    const messages = [userMessage('m3', 3, 'Run the tests')];
    transcriptState.ids = messages.map((message) => message.id);
    transcriptState.messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
}

/**
 * Mirrors the cockpit tab navigator: it owns the visible surface, so a switch really does
 * unmount the navigation surface the way it does on the phone.
 *
 * Built lazily: the module mocks above are only installed once this file's body has run,
 * so the cockpit tree must not be imported from the static import list.
 */
async function loadCockpitHarness(): Promise<React.ComponentType<Readonly<{ events: string[] }>>> {
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitSurfaceNavigationProvider } = await import('./SessionCockpitSurfaceNavigation');
    const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');

    return function CockpitHarness(props: Readonly<{ events: string[] }>) {
        const [surface, setSurface] = React.useState<SessionMobileSurface>('navigation');
        const switchSurface = React.useCallback((next: SessionMobileSurface) => {
            props.events.push(`surface:${next}`);
            setSurface(next);
        }, [props.events]);

        return (
            <AppPaneProvider>
                <SessionCockpitChromeRegistryProvider>
                    <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                        <SessionCockpitSurfaceScreen
                            sessionId="session-1"
                            scopeId="session:session-1"
                            surface={surface}
                            terminalTabAvailable={false}
                        />
                    </SessionCockpitSurfaceNavigationProvider>
                </SessionCockpitChromeRegistryProvider>
            </AppPaneProvider>
        );
    };
}

describe('SessionCockpitSurfaceScreen navigation surface', () => {
    beforeEach(async () => {
        standardCleanup();
        persistedStorage.clear();
        seedTranscript();
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        transcriptNavigationPaneStore.set('session-1', null);
    });

    it('renders the session timeline with no transcript host mounted for the session', async () => {
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={[]} />);

        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeTruthy();
        expect(screen.findByTestId(ENTRY_TEST_ID)).toBeTruthy();
        expect(screen.getTextContent()).toContain('Run the tests');
        // The surface replaces the transcript subtree, so nothing registered a jump handler.
        expect(transcriptNavigationPaneStore.get('session-1').onEntryPress).toBeNull();
    });

    it('reveals the chat surface before the transcript jump runs', async () => {
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const events: string[] = [];
        const jumped: Array<{ id: string; seq: number | null }> = [];
        const onEntryPress = vi.fn((entry: { id: string; seq: number | null }) => {
            events.push('jump');
            jumped.push(entry);
            return { status: 'scrolled' as const };
        });

        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeTruthy();

        await screen.pressByTestIdAsync(ENTRY_TEST_ID);

        // The surface really switched, so the navigation screen is gone and the transcript
        // scene is the visible one before anything scrolls it.
        expect(events).toEqual(['surface:chat']);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeNull();
        expect(onEntryPress).not.toHaveBeenCalled();

        // The revealed (un-frozen) transcript host republishes its jump handler.
        await act(async () => {
            transcriptNavigationPaneStore.set('session-1', { onEntryPress });
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(jumped[0]).toMatchObject({ id: 'session-1:user-turn:3', seq: 3 });
        expect(events).toEqual(['surface:chat', 'jump']);
    });

    it('exits the navigation surface through the close affordance', async () => {
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);

        await screen.pressByTestIdAsync('session-transcript-navigation-close');

        expect(events).toEqual(['surface:chat']);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeNull();
    });

    it('exits the navigation surface on Escape from the timeline', async () => {
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-transcript-navigation-entry-list'),
                'onKeyDown',
                { nativeEvent: { key: 'Escape' }, preventDefault: () => {} },
            );
        });

        expect(events).toEqual(['surface:chat']);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeNull();
    });
});
