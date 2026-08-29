import * as React from 'react';
import { act } from 'react-test-renderer';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const nativeAppState = vi.hoisted(() => ({
    currentState: 'active' as string,
    platformOS: 'ios' as string,
    listeners: new Set<(state: string) => void>(),
}));

const hostView = vi.hoisted(() => ({
    visibility: 'visible' as 'visible' | 'hidden',
    focused: true,
    listeners: new Set<() => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return nativeAppState.platformOS;
            },
        },
        AppState: {
            get currentState() {
                return nativeAppState.currentState;
            },
            addEventListener: (_event: string, listener: (state: string) => void) => {
                nativeAppState.listeners.add(listener);
                return { remove: () => nativeAppState.listeners.delete(listener) };
            },
        },
    });
});

// These provider tests verify how the composer reacts to a lifecycle fact.
// The lifecycle fact itself is exercised through real browser/native
// boundaries in useHostActivelyViewed.test.tsx; this is not integration proof
// of that owner.
vi.mock('@/utils/runtime/useHostActivelyViewed', async () => {
    const ReactModule = await import('react');
    const readHostActivelyViewed = (): boolean => (
        nativeAppState.currentState === 'active'
        && hostView.visibility === 'visible'
        && hostView.focused
    );
    const subscribeToHostActivelyViewed = (listener: () => void): (() => void) => {
        hostView.listeners.add(listener);
        return () => {
            hostView.listeners.delete(listener);
        };
    };
    return {
        readHostActivelyViewed,
        useHostActivelyViewed: (): boolean => ReactModule.useSyncExternalStore(
            subscribeToHostActivelyViewed,
            readHostActivelyViewed,
            () => true,
        ),
    };
});

const providerState = vi.hoisted(() => ({
    focusedSessionId: 'session-b' as string | null,
    routeParams: { id: 'session-a' } as Record<string, unknown>,
    routeSegments: ['(app)', 'session', '[id]'] as string[],
    visibleModalKind: null as string | null,
    focusedDetailsWorkspace: false,
    settingsTitle: null as string | null,
    session: null as object | null,
    sessionDisplaySource: null as object | null,
    machine: null as object | null,
    voiceSettings: null as unknown,
}));

vi.mock('expo-router', () => ({
    useGlobalSearchParams: () => providerState.routeParams,
    useSegments: () => providerState.routeSegments,
}));

vi.mock('@/modal', () => ({
    useVisibleModalKind: () => providerState.visibleModalKind,
}));

vi.mock('@/components/appShell/panes/AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        state: providerState.focusedDetailsWorkspace
            ? {
                activeScopeId: 'details',
                scopes: {
                    details: {
                        details: { isOpen: true, focusedGroupId: 'current' },
                    },
                },
            }
            : {
                activeScopeId: null,
                scopes: {},
            },
    }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ pluginUiProjection: null }),
    // Mirrors the real resolver bound to a null projection: strings pass
    // through and only the declared fallback can answer.
    useProjectedPluginLocalizedTextResolver: () => (_pluginId: string, value: unknown) => {
        if (typeof value === 'string') return value;
        const fallback = (value as { fallback?: unknown } | null)?.fallback;
        return typeof fallback === 'string' ? fallback : '';
    },
}));

vi.mock('@/components/appShell/plugins/pluginAppPageRoute', () => ({
    readPluginAppPageRouteIdentity: () => ({ pluginId: null, localId: null }),
}));

vi.mock('@/components/appShell/plugins/pluginAppPages', () => ({
    resolvePluginAppPageForRoute: () => null,
    resolvePluginAppPages: () => [],
    selectPluginAppPagePlacements: () => [],
}));

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => providerState.settingsTitle === null
        ? { activePageId: null, tree: [] }
        : {
            activePageId: 'voice',
            tree: [{ id: 'voice', title: providerState.settingsTitle, keywords: [] }],
        },
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    useMainAppTabState: () => ({ activeTab: null }),
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    useFocusedSessionId: () => providerState.focusedSessionId,
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/store/hooks')>()),
    useMachine: () => providerState.machine as never,
    useSession: () => providerState.session as never,
    useSessionDisplayNameSource: () => (providerState.sessionDisplaySource ?? providerState.session) as never,
    useSetting: () => providerState.voiceSettings as never,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => null,
        useProfile: () => null,
        useSetting: () => null,
    });
});

import {
    type CurrentUiContextMountedEnrichment,
} from './currentUiContextModel';
import {
    CurrentUiContextProvider,
    type CurrentUiContextReader,
    useCurrentUiContextMountPublisher,
    useOptionalCurrentUiContextReader,
    usePublishCurrentUiContext,
} from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CurrentUiContextTestProvider(props: React.PropsWithChildren): React.ReactElement {
    return React.createElement(CurrentUiContextProvider, null, props.children);
}

function StrictCurrentUiContextTestProvider(props: React.PropsWithChildren): React.ReactElement {
    return React.createElement(
        React.StrictMode,
        null,
        React.createElement(CurrentUiContextTestProvider, null, props.children),
    );
}

function CurrentUiContextReaderProbe(props: Readonly<{
    onReader: (reader: CurrentUiContextReader | null) => void;
}>): null {
    props.onReader(useOptionalCurrentUiContextReader());
    return null;
}

function BuiltInCurrentUiContextSurface(props: Readonly<{
    enrichment: CurrentUiContextMountedEnrichment | null;
}>): null {
    usePublishCurrentUiContext(props.enrichment);
    return null;
}

function requireCurrentUiContextReader(reader: CurrentUiContextReader | null): CurrentUiContextReader {
    if (reader === null) throw new Error('Current UI context reader was not mounted');
    return reader;
}

function setNativeAppState(nextState: string): void {
    nativeAppState.currentState = nextState;
    for (const listener of [...nativeAppState.listeners]) {
        listener(nextState);
    }
    for (const listener of [...hostView.listeners]) {
        listener();
    }
}

function setDesktopHost(enabled: boolean): void {
    const globals = globalThis as Record<string, unknown>;
    if (enabled) {
        globals.__TAURI_INTERNALS__ = { invoke: () => undefined };
    } else {
        delete globals.__TAURI_INTERNALS__;
    }
}

function setHostVisibility(visibility: 'visible' | 'hidden'): void {
    hostView.visibility = visibility;
    for (const listener of [...hostView.listeners]) {
        listener();
    }
}

afterAll(() => {
    hostView.listeners.clear();
    nativeAppState.listeners.clear();
});

beforeEach(() => {
    nativeAppState.currentState = 'active';
    nativeAppState.platformOS = 'ios';
    hostView.visibility = 'visible';
    hostView.focused = true;
    setDesktopHost(false);
    providerState.focusedSessionId = 'session-b';
    providerState.routeParams = { id: 'session-a' };
    providerState.routeSegments = ['(app)', 'session', '[id]'];
    providerState.visibleModalKind = null;
    providerState.focusedDetailsWorkspace = false;
    providerState.settingsTitle = null;
    providerState.session = null;
    providerState.sessionDisplaySource = null;
    providerState.machine = null;
    providerState.voiceSettings = null;
});

afterEach(() => {
    standardCleanup();
    nativeAppState.currentState = 'active';
    nativeAppState.platformOS = 'ios';
    hostView.visibility = 'visible';
    hostView.focused = true;
    setDesktopHost(false);
    setHostVisibility('visible');
    vi.doUnmock('@/voice/adapters/registerBuiltinVoiceAdapters');
});

describe('CurrentUiContextProvider', () => {
    it('retains a Tauri record when the provider lifecycle seam withdraws hidden reads, then retires it on unmount', async () => {
        setDesktopHost(true);
        setHostVisibility('visible');
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const reader = requireCurrentUiContextReader(hook.getCurrent().reader);
        const publisher = hook.getCurrent().publisher;
        expect(publisher).not.toBeNull();
        const publication = publisher!.createMount();
        await act(async () => {
            expect(publication.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open B',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2 },
                    },
                }],
            })).toBe(true);
        });
        const retiredCommandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(retiredCommandId).not.toBe('');
        const retainedSignal = reader.resolveCurrentUiCommand(retiredCommandId)?.retirementSignal;
        expect(retainedSignal).toBeInstanceOf(AbortSignal);
        expect(retainedSignal?.aborted).toBe(false);
        const port = createCurrentUiContextVoiceToolPort({
            reader,
            readProjection: () => null,
            readNavigationBinding: () => null,
        });
        await act(async () => {
            setHostVisibility('hidden');
        });
        expect(reader.readCurrentUiContext()).toBeNull();
        expect(reader.resolveCurrentUiCommand(retiredCommandId)).toBeNull();
        await expect(port.invokeCurrentUiCommand?.({ commandId: retiredCommandId })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
        });

        await act(async () => {
            setHostVisibility('visible');
        });
        // Refocus only re-enables the reader. The existing mount record has
        // not republished, so its exact descriptor and opaque command ID must
        // be restored without publisher churn.
        expect(reader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue A' });
        expect(reader.readCurrentUiContext()?.commands.map((entry) => entry.id)).toEqual([retiredCommandId]);
        expect(reader.resolveCurrentUiCommand(retiredCommandId)).not.toBeNull();
        expect(retainedSignal?.aborted).toBe(false);

        await hook.unmount();
        expect(retainedSignal?.aborted).toBe(true);
        expect(reader.readCurrentUiContext()).toBeNull();
        expect(reader.resolveCurrentUiCommand(retiredCommandId)).toBeNull();
    });

    it('retires an imperative native mount record instead of resurrecting its command on foreground', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const reader = requireCurrentUiContextReader(hook.getCurrent().reader);
        const publisher = hook.getCurrent().publisher;
        expect(publisher).not.toBeNull();
        const publication = publisher!.createMount();
        await act(async () => {
            expect(publication.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open B',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2 },
                    },
                }],
            })).toBe(true);
        });
        const commandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
        const retirementSignal = reader.resolveCurrentUiCommand(commandId)?.retirementSignal;
        expect(commandId).not.toBe('');
        expect(retirementSignal?.aborted).toBe(false);

        await act(async () => {
            setNativeAppState('background');
        });
        expect(retirementSignal?.aborted).toBe(true);
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();

        await act(async () => {
            setNativeAppState('active');
        });
        expect(reader.readCurrentUiContext()?.entity).toBeUndefined();
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();
        await hook.unmount();
    });

    it('restores web current UI when the provider lifecycle seam reports active again', async () => {
        nativeAppState.platformOS = 'web';
        setHostVisibility('visible');
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const reader = requireCurrentUiContextReader(hook.getCurrent().reader);
        const publisher = hook.getCurrent().publisher;
        expect(publisher).not.toBeNull();
        const publication = publisher!.createMount();
        await act(async () => {
            expect(publication.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open B',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2 },
                    },
                }],
            })).toBe(true);
        });
        const commandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
        await act(async () => {
            setHostVisibility('hidden');
        });
        expect(reader.readCurrentUiContext()).toBeNull();
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();

        await act(async () => {
            setHostVisibility('visible');
        });
        expect(reader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue A' });
        expect(reader.resolveCurrentUiCommand(commandId)).not.toBeNull();
    });

    it('provides VoiceSessionRuntime its non-null reader through the AppShell provider wiring', async () => {
        const createAssembly = vi.fn(() => ({ adapters: [], dispose: vi.fn(async () => {}) }));
        vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
            createBuiltinVoiceAdapterAssembly: createAssembly,
        }));

        const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
        await renderScreen(
            React.createElement(
                CurrentUiContextProvider,
                null,
                React.createElement(VoiceSessionRuntime),
            ),
        );

        expect(createAssembly).toHaveBeenCalledTimes(1);
        expect(createAssembly).toHaveBeenCalledWith({
            currentUiContext: expect.objectContaining({
                readCurrentUiContext: expect.any(Function),
                resolveCurrentUiCommand: expect.any(Function),
                subscribe: expect.any(Function),
                invokeCurrentUiCommand: expect.any(Function),
                invokeAction: expect.any(Function),
            }),
        });
    });

    it('lets a reader observe the current snapshot without granting a stale focused Session route', async () => {
        const hook = await renderHook(() => useOptionalCurrentUiContextReader(), {
            wrapper: CurrentUiContextTestProvider,
        });

        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation.area).toBe('app');

        providerState.focusedSessionId = 'session-a';
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation.area).toBe('session');

        providerState.visibleModalKind = 'confirm';
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).toMatchObject({
            area: 'modal',
            presentation: 'modal',
            screen: 'confirm',
        });
    });

    it('does not notify current-context readers for a foreground Session activity update that preserves display metadata', async () => {
        providerState.focusedSessionId = 'session-a';
        providerState.session = {
            id: 'session-a',
            metadata: { summary: { text: 'Stable title' } },
            active: true,
            thinking: false,
        };
        providerState.sessionDisplaySource = {
            id: 'session-a',
            metadata: { summary: { text: 'Stable title' } },
        };
        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        };

        let reader: CurrentUiContextReader | null = null;
        const renderProvider = () => React.createElement(
            CurrentUiContextProvider,
            null,
            React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
        );
        const screen = await renderScreen(renderProvider());
        const currentReader = requireCurrentUiContextReader(reader);
        const onSnapshotChange = vi.fn();
        const unsubscribe = currentReader.subscribe(onSnapshotChange);

        providerState.session = {
            ...providerState.session,
            thinking: true,
        };
        await screen.update(renderProvider());

        expect(currentReader.readCurrentUiContext()?.navigation).toMatchObject({
            area: 'session',
            title: 'Stable title',
        });
        expect(onSnapshotChange).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('enriches only the exact foreground Session or machine with privacy-approved incumbent labels', async () => {
        providerState.focusedSessionId = 'session-a';
        providerState.session = {
            id: 'session-a',
            metadata: {
                summary: { text: 'FOCUSED_SESSION_TITLE', updatedAt: 1 },
                path: '/Users/alice/SECRET_PROVIDER_WORKSPACE',
            },
        };
        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: true,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        };

        const hook = await renderHook(() => useOptionalCurrentUiContextReader(), {
            wrapper: CurrentUiContextTestProvider,
        });
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).toMatchObject({
            area: 'session',
            title: 'FOCUSED_SESSION_TITLE',
        });
        expect(JSON.stringify(hook.getCurrent()?.readCurrentUiContext())).not.toContain('SECRET_PROVIDER_WORKSPACE');

        // The provider must use the canonical fail-closed reader, rather than
        // treating a truthy raw settings value as disclosure authority.
        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: 'true',
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        };
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).not.toHaveProperty('title');

        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: false,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        };
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).not.toHaveProperty('title');

        providerState.focusedSessionId = null;
        providerState.session = null;
        providerState.routeSegments = ['(app)', 'machine', '[id]'];
        providerState.routeParams = { id: 'machine-a' };
        providerState.machine = {
            id: 'machine-a',
            metadata: { displayName: 'FOCUSED_MACHINE_LABEL' },
        };
        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: false,
                shareFilePaths: false,
                shareDeviceInventory: true,
            },
        };
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).toMatchObject({
            area: 'machine',
            title: 'FOCUSED_MACHINE_LABEL',
        });

        providerState.voiceSettings = {
            privacy: {
                shareSessionSummary: false,
                shareFilePaths: false,
                shareDeviceInventory: false,
            },
        };
        await hook.rerender();
        expect(hook.getCurrent()?.readCurrentUiContext()?.navigation).not.toHaveProperty('title');
    });

    it('has no mount publisher outside the AppShell provider', async () => {
        const hook = await renderHook(() => useCurrentUiContextMountPublisher());

        expect(hook.getCurrent()).toBeNull();
    });

    it('offers one provider-local reader that projects descriptors only and rejects stale command ids immediately', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const reader = hook.getCurrent().reader;
        const publisher = hook.getCurrent().publisher;
        expect(reader).not.toBeNull();
        expect(publisher).not.toBeNull();

        const a = publisher!.createMount();
        let commandId = '';
        await act(async () => {
            expect(a.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open private issue',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2, privateQuery: 'must-not-reach-voice-read' },
                    },
                }],
            })).toBe(true);
        });

        const snapshot = reader!.readCurrentUiContext();
        expect(snapshot?.commands).toHaveLength(1);
        commandId = snapshot?.commands[0]?.id ?? '';
        expect(commandId).toMatch(/^current-ui-command:/);
        expect(JSON.stringify(snapshot)).not.toContain('privateQuery');
        expect(reader!.resolveCurrentUiCommand(commandId)?.command).toMatchObject({
            kind: 'openSurface',
            input: { issueNumber: 2, privateQuery: 'must-not-reach-voice-read' },
        });

        await act(async () => {
            a.clear();
            const immediatelyClearedSnapshot = reader!.readCurrentUiContext();
            expect(immediatelyClearedSnapshot?.entity).toBeUndefined();
            expect(immediatelyClearedSnapshot?.commands).toEqual([]);
        });
        expect(reader!.resolveCurrentUiCommand(commandId)).toBeNull();

        const b = publisher!.createMount();
        await act(async () => {
            expect(b.publish({
                entity: { kind: 'issue', label: 'Issue B' },
                commands: [{
                    title: 'New command',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 3 },
                    },
                }],
            })).toBe(true);
            const immediateReplacementSnapshot = reader!.readCurrentUiContext();
            expect(immediateReplacementSnapshot?.entity?.label).toBe('Issue B');
            expect(immediateReplacementSnapshot?.commands).toHaveLength(1);
        });
        expect(reader!.resolveCurrentUiCommand(commandId)).toBeNull();

        await act(async () => {
            b.dispose();
        });
        expect(reader!.resolveCurrentUiCommand(commandId)).toBeNull();
    });

    it('retires each private command signal synchronously on replacement, clear, disposal, and provider teardown', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const publisher = hook.getCurrent().publisher;
        const reader = requireCurrentUiContextReader(hook.getCurrent().reader);
        expect(publisher).not.toBeNull();

        const publication = publisher!.createMount();
        const publish = async (label: string) => {
            await act(async () => {
                expect(publication.publish({
                    entity: { kind: 'issue', label },
                    commands: [{
                        title: 'File remote update',
                        command: {
                            kind: 'executeAction',
                            action: { pluginId: 'triage', localId: 'file-remote-update' },
                        },
                    }],
                })).toBe(true);
            });
            const commandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
            const retirementSignal = reader.resolveCurrentUiCommand(commandId)?.retirementSignal;
            expect(commandId).not.toBe('');
            expect(retirementSignal).toBeInstanceOf(AbortSignal);
            expect(retirementSignal?.aborted).toBe(false);
            return retirementSignal!;
        };

        const replaced = await publish('Issue A');
        const current = await publish('Issue B');
        expect(replaced.aborted).toBe(true);

        await act(async () => {
            publication.clear();
        });
        expect(current.aborted).toBe(true);

        const disposed = await publish('Issue C');
        await act(async () => {
            publication.dispose();
        });
        expect(disposed.aborted).toBe(true);

        const teardownPublication = publisher!.createMount();
        await act(async () => {
            expect(teardownPublication.publish({
                entity: { kind: 'issue', label: 'Issue D' },
                commands: [{
                    title: 'File remote update',
                    command: {
                        kind: 'executeAction',
                        action: { pluginId: 'triage', localId: 'file-remote-update' },
                    },
                }],
            })).toBe(true);
        });
        const teardownCommandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
        const tornDown = reader.resolveCurrentUiCommand(teardownCommandId)?.retirementSignal;
        expect(tornDown).toBeInstanceOf(AbortSignal);
        await hook.unmount();
        expect(tornDown?.aborted).toBe(true);
    });

    it('resolves only commands advertised by the current composed snapshot', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const publisher = hook.getCurrent().publisher;
        const reader = requireCurrentUiContextReader(hook.getCurrent().reader);
        expect(publisher).not.toBeNull();

        const publication = publisher!.createMount();
        await act(async () => {
            expect(publication.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open issue B',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2 },
                    },
                }],
            })).toBe(true);
        });
        const commandId = reader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandId).not.toBe('');
        expect(reader.resolveCurrentUiCommand(commandId)).not.toBeNull();

        providerState.visibleModalKind = 'confirm';
        await hook.rerender();
        expect(reader.readCurrentUiContext()?.navigation.area).toBe('modal');
        expect(reader.readCurrentUiContext()?.commands).toEqual([]);
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();

        providerState.visibleModalKind = null;
        providerState.focusedDetailsWorkspace = true;
        await hook.rerender();
        expect(reader.readCurrentUiContext()?.navigation.area).toBe('workspace');
        expect(reader.readCurrentUiContext()?.commands).toEqual([]);
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();

        providerState.focusedDetailsWorkspace = false;
        await hook.rerender();
        expect(reader.resolveCurrentUiCommand(commandId)).not.toBeNull();

        providerState.routeSegments = ['(app)', 'settings', 'voice'];
        providerState.settingsTitle = 'x'.repeat(10_000);
        await hook.rerender();
        expect(reader.readCurrentUiContext()).toMatchObject({
            detail: { incomplete: true },
            commands: [],
        });
        expect(reader.resolveCurrentUiCommand(commandId)).toBeNull();
    });

    it('keeps its committed mount capability usable across StrictMode effect replay', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: StrictCurrentUiContextTestProvider,
        });
        const publication = hook.getCurrent().publisher!.createMount();

        await act(async () => {
            expect(publication.publish({
                entity: { kind: 'entry', label: 'Strict entry' },
            })).toBe(true);
        });

        expect(hook.getCurrent().reader?.readCurrentUiContext()?.entity).toEqual({ kind: 'entry', label: 'Strict entry' });
    });

    it('keeps a layout-effect publisher current across StrictMode effect replay', async () => {
        let reader: CurrentUiContextReader | null = null;
        const enrichment: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'entry', label: 'Strict mounted entry' },
            commands: [{
                title: 'Open strict entry',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'entries' },
                },
            }],
        };
        const screen = await renderScreen(
            React.createElement(
                React.StrictMode,
                null,
                React.createElement(
                    CurrentUiContextProvider,
                    null,
                    React.createElement(
                        PluginSurfaceFocusEligibilityProvider,
                        {
                            active: true,
                            currentUiContextActive: true,
                            children: React.createElement(BuiltInCurrentUiContextSurface, { enrichment }),
                        },
                    ),
                    React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
                ),
            ),
        );

        const currentReader = requireCurrentUiContextReader(reader);
        expect(currentReader.readCurrentUiContext()?.entity).toEqual({
            kind: 'entry',
            label: 'Strict mounted entry',
        });
        const commandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandId).not.toBe('');
        expect(currentReader.resolveCurrentUiCommand(commandId)?.retirementSignal.aborted).toBe(false);

        await screen.unmount();
    });

    it('projects only one exact mounted record, never leaks command payloads, and fences a retired A mount from B', async () => {
        const hook = await renderHook(() => ({
            publisher: useCurrentUiContextMountPublisher(),
            reader: useOptionalCurrentUiContextReader(),
        }), {
            wrapper: CurrentUiContextTestProvider,
        });
        const publisher = hook.getCurrent().publisher;
        expect(publisher).not.toBeNull();
        const a = publisher!.createMount();
        const b = publisher!.createMount();

        await act(async () => {
            expect(a.publish({
                entity: { kind: 'issue', label: 'Issue A' },
                commands: [{
                    title: 'Open issue B',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: 'triage', localId: 'issues' },
                        input: { issueNumber: 2, privateQuery: 'do-not-disclose' },
                    },
                }],
            })).toBe(true);
        });
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue A' });
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.commands).toHaveLength(1);
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.commands[0]).toMatchObject({ title: 'Open issue B' });
        expect(JSON.stringify(hook.getCurrent().reader?.readCurrentUiContext())).not.toContain('privateQuery');

        await act(async () => {
            // A second concurrently visible mount cannot turn this into a
            // last-publisher-wins selection mechanism.
            expect(b.publish({ entity: { kind: 'issue', label: 'Issue B' } })).toBe(false);
        });
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue A' });

        await act(async () => {
            a.dispose();
            // The presentation owner republishes B through the normal current
            // mount path once A retires; a stale A must not clear it.
            expect(b.publish({ entity: { kind: 'issue', label: 'Issue B' } })).toBe(true);
            a.clear();
        });
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue B' });

        await act(async () => {
            b.dispose();
        });
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.entity).toBeUndefined();
        expect(hook.getCurrent().reader?.readCurrentUiContext()?.commands).toEqual([]);
    });

    it('omits simultaneous pane-like publications without a named current-focus owner, including after A retires', async () => {
        let reader: CurrentUiContextReader | null = null;
        const renderAmbiguousSurfaces = (showA: boolean) => React.createElement(
            CurrentUiContextProvider,
            null,
            React.createElement(
                PluginSurfaceFocusEligibilityProvider,
                {
                    active: true,
                    children: React.createElement(
                        React.Fragment,
                        null,
                        showA
                            ? React.createElement(BuiltInCurrentUiContextSurface, {
                                enrichment: { entity: { kind: 'issue', label: 'Issue A' } },
                            })
                            : null,
                        React.createElement(BuiltInCurrentUiContextSurface, {
                            enrichment: { entity: { kind: 'issue', label: 'Issue B' } },
                        }),
                    ),
                },
            ),
            React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
        );

        const screen = await renderScreen(renderAmbiguousSurfaces(true));
        const currentReader = requireCurrentUiContextReader(reader);

        expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
        await screen.update(renderAmbiguousSurfaces(false));
        expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
        expect(currentReader.readCurrentUiContext()?.commands).toEqual([]);
    });

    it('publishes, replaces, clears, and retires a built-in product-screen enrichment through the one composer', async () => {
        let reader: CurrentUiContextReader | null = null;
        const issueA: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'issue', label: 'Issue A' },
            commands: [{
                title: 'Open B',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'issues' },
                    input: { issueNumber: 2 },
                },
            }],
        };
        const issueB: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'issue', label: 'Issue B' },
            commands: [{
                title: 'Open C',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'issues' },
                    input: { issueNumber: 3 },
                },
            }],
        };
        const renderBuiltInSurface = (
            enrichment: CurrentUiContextMountedEnrichment | null,
            mounted = true,
        ) => React.createElement(
            CurrentUiContextProvider,
            null,
            React.createElement(
                PluginSurfaceFocusEligibilityProvider,
                {
                    active: true,
                    currentUiContextActive: true,
                    children: mounted ? React.createElement(BuiltInCurrentUiContextSurface, { enrichment }) : null,
                },
            ),
            React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
        );

        const screen = await renderScreen(renderBuiltInSurface(issueA));
        const currentReader = requireCurrentUiContextReader(reader);
        const commandA = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(currentReader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue A' });
        expect(currentReader.resolveCurrentUiCommand(commandA)).not.toBeNull();

        await screen.update(renderBuiltInSurface(issueB));
        const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(currentReader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue B' });
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandB)).not.toBeNull();

        await screen.update(renderBuiltInSurface(null));
        expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
        expect(currentReader.readCurrentUiContext()?.commands).toEqual([]);
        expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();

        await screen.update(renderBuiltInSurface(issueA));
        const commandC = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(currentReader.resolveCurrentUiCommand(commandC)).not.toBeNull();
        await screen.update(renderBuiltInSurface(issueA, false));
        expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
        expect(currentReader.resolveCurrentUiCommand(commandC)).toBeNull();
    });

    it('retires the native record through simultaneous background and focus loss, then republishes fresh on foreground', async () => {
        let reader: CurrentUiContextReader | null = null;
        const issueA: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'issue', label: 'Issue A' },
            commands: [{
                title: 'Open B',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'issues' },
                    input: { issueNumber: 2 },
                },
            }],
        };
        const issueB: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'issue', label: 'Issue B' },
            commands: [{
                title: 'Open C',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'issues' },
                    input: { issueNumber: 3 },
                },
            }],
        };
        const renderCurrentSurface = (
            enrichment: CurrentUiContextMountedEnrichment,
            focusEligible = true,
        ) => React.createElement(
            CurrentUiContextProvider,
            null,
            React.createElement(
                PluginSurfaceFocusEligibilityProvider,
                {
                    active: focusEligible,
                    currentUiContextActive: focusEligible,
                    children: React.createElement(BuiltInCurrentUiContextSurface, { enrichment }),
                },
            ),
            React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
        );
        const screen = await renderScreen(renderCurrentSurface(issueA));
        const currentReader = requireCurrentUiContextReader(reader);
        const retiredCommandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        await screen.update(renderCurrentSurface(issueB));
        const commandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandId).not.toBe('');
        expect(currentReader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue B' });
        expect(currentReader.resolveCurrentUiCommand(retiredCommandId)).toBeNull();
        const retiredSignal = currentReader.resolveCurrentUiCommand(commandId)?.retirementSignal;
        const observedSnapshots: Array<string | null> = [];
        const unsubscribe = currentReader.subscribe(() => {
            observedSnapshots.push(currentReader.readCurrentUiContext()?.entity?.label ?? null);
        });

        await act(async () => {
            hostView.focused = false;
            setNativeAppState('background');
        });
        await screen.update(renderCurrentSurface(issueB, false));
        expect(currentReader.readCurrentUiContext()).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();
        expect(observedSnapshots.at(-1)).toBeNull();

        await act(async () => {
            hostView.focused = true;
            setNativeAppState('active');
        });
        await screen.update(renderCurrentSurface(issueB, true));
        const restoredCommandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(currentReader.readCurrentUiContext()?.entity).toEqual({ kind: 'issue', label: 'Issue B' });
        expect(restoredCommandId).not.toBe('');
        expect(restoredCommandId).not.toBe(commandId);
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();
        expect(retiredSignal).toBeInstanceOf(AbortSignal);
        expect(retiredSignal?.aborted).toBe(true);
        expect(currentReader.resolveCurrentUiCommand(restoredCommandId)?.retirementSignal?.aborted).toBe(false);

        unsubscribe();
        await screen.unmount();
    });

    it('preserves one begun navigation success after the provider lifecycle seam retires the native record', async () => {
        let reader: CurrentUiContextReader | null = null;
        const issue: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'issue', label: 'Issue B' },
            commands: [{
                title: 'Open C',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: 'triage', localId: 'issues' },
                    input: { issueNumber: 3 },
                },
            }],
        };
        const renderCurrentSurface = () => React.createElement(
            CurrentUiContextProvider,
            null,
            React.createElement(
                PluginSurfaceFocusEligibilityProvider,
                {
                    active: true,
                    currentUiContextActive: true,
                    children: React.createElement(BuiltInCurrentUiContextSurface, { enrichment: issue }),
                },
            ),
            React.createElement(CurrentUiContextReaderProbe, { onReader: (next) => { reader = next; } }),
        );
        const screen = await renderScreen(renderCurrentSurface());
        const currentReader = requireCurrentUiContextReader(reader);
        const commandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        const navigationSettlement = createDeferred<{ ok: true }>();
        const openSurface = vi.fn(() => navigationSettlement.promise);
        const port = createCurrentUiContextVoiceToolPort({
            reader: currentReader,
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => undefined }),
        });
        const invokeCurrentUiCommand = port.invokeCurrentUiCommand;
        if (!invokeCurrentUiCommand) throw new Error('Current UI command invoker was not mounted');

        const pendingInvocation = invokeCurrentUiCommand({ commandId });
        expect(openSurface).toHaveBeenCalledTimes(1);
        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'triage', localId: 'issues' },
            input: { issueNumber: 3 },
        });

        await act(async () => {
            setNativeAppState('background');
        });
        expect(currentReader.readCurrentUiContext()).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();

        await act(async () => {
            setNativeAppState('active');
        });
        const refreshedCommandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(refreshedCommandId).not.toBe('');
        expect(refreshedCommandId).not.toBe(commandId);
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(refreshedCommandId)).not.toBeNull();
        await screen.unmount();

        await expect(invokeCurrentUiCommand({ commandId })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
        });
        expect(openSurface).toHaveBeenCalledTimes(1);

        navigationSettlement.resolve({ ok: true });
        await expect(pendingInvocation).resolves.toEqual({ ok: true });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });
});
