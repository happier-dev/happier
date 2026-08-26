import type { Page } from '@playwright/test';

const MAIN_WINDOW_LABEL = 'main';
const DESKTOP_WINDOW_STATE_EVENT = 'desktopWindow://state';
const WINDOW_MOVED_EVENT = 'tauri://move';
const WINDOW_RESIZED_EVENT = 'tauri://resize';

export type FakeTauriDesktopPlatform = 'macos' | 'windows' | 'linux';
export type FakeTauriDesktopStrategy =
    | 'none'
    | 'native-macos-traffic-lights'
    | 'custom-controls';

export type FakeTauriDesktopUpdateState = Readonly<{
    installed?: boolean;
    version: string;
}>;

export type FakeTauriDesktopControlsState = Readonly<{
    closeCount: number;
    dragCount: number;
    minimizeCount: number;
    toggleMaximizeCount: number;
}>;

export type FakeTauriDesktopInvokeLogEntry = Readonly<{
    args: Record<string, unknown> | null;
    command: string;
}>;

export type FakeTauriDesktopState = Readonly<{
    autostartEnabled: boolean;
    controls: FakeTauriDesktopControlsState;
    currentWindowLabel: string;
    desktopActivityOverlayState: unknown | null;
    desktopPetOverlayState: unknown | null;
    invokeLog: readonly FakeTauriDesktopInvokeLogEntry[];
    isMaximized: boolean;
    platform: FakeTauriDesktopPlatform;
    strategy: FakeTauriDesktopStrategy;
    trayState: Record<string, unknown> | null;
    updateAvailable: FakeTauriDesktopUpdateState | null;
}>;

export type FakeTauriDesktopCommandResult = Readonly<{
    result: unknown;
    state: FakeTauriDesktopState;
}>;

type MutableFakeTauriDesktopWindow = Window & {
    __HAPPIER_FAKE_TAURI_DESKTOP__?: FakeTauriDesktopState;
    __HAPPIER_FAKE_TAURI_EVENT_LISTENERS__?: Record<string, number[]>;
    __TAURI__?: {
        core?: {
            invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
        unregisterListener: (event: string, id: number) => void;
    };
    __TAURI_INTERNALS__?: {
        callbacks?: Map<number, (data: unknown) => unknown>;
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        metadata?: {
            currentWindow: {
                label: string;
            };
            currentWebview: {
                label: string;
                windowLabel: string;
            };
        };
        runCallback?: (id: number, data: unknown) => void;
        transformCallback?: (callback: ((data: unknown) => unknown) | undefined, once?: boolean) => number;
        unregisterCallback?: (id: number) => void;
    };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDesktopActivityOverlaySyncPayload(args?: Record<string, unknown>): unknown | null {
    return args && 'payload' in args ? args.payload ?? null : null;
}

function resolveDesktopActivityOverlayExpandedState(
    current: unknown | null,
    expanded: unknown,
): unknown | null {
    if (!isRecord(current) || typeof expanded !== 'boolean') {
        return current;
    }
    return {
        ...current,
        expanded,
    };
}

function resolveDefaultStrategy(platform: FakeTauriDesktopPlatform): FakeTauriDesktopStrategy {
    return platform === 'macos' ? 'native-macos-traffic-lights' : 'custom-controls';
}

function resolveFakeTauriDesktopChromeStrategy(
    state: Pick<FakeTauriDesktopState, 'currentWindowLabel' | 'platform' | 'strategy'>,
): FakeTauriDesktopStrategy {
    if (state.currentWindowLabel !== MAIN_WINDOW_LABEL) {
        return 'none';
    }

    return state.strategy === 'none' ? resolveDefaultStrategy(state.platform) : state.strategy;
}

function createNextStateBase(
    state: FakeTauriDesktopState,
    command: string,
    args?: Record<string, unknown>,
): FakeTauriDesktopState {
    return {
        ...state,
        controls: {
            ...state.controls,
        },
        invokeLog: [
            ...state.invokeLog,
            {
                args: args ?? null,
                command,
            },
        ],
    };
}

function applyLegacyWindowStateResult(state: FakeTauriDesktopState): FakeTauriDesktopCommandResult {
    return {
        result: {
            controls: state.controls,
            isMaximized: state.isMaximized,
            platform: state.platform,
            strategy: resolveFakeTauriDesktopChromeStrategy(state),
        },
        state,
    };
}

function applyWindowCommand(
    state: FakeTauriDesktopState,
    command: string,
    resultMode: 'legacy' | 'plugin' | 'bridge',
): FakeTauriDesktopCommandResult {
    switch (command) {
        case 'plugin:window|minimize':
        case 'desktop_minimize_window':
        case 'desktop_window_minimize': {
            const nextState = {
                ...state,
                controls: {
                    ...state.controls,
                    minimizeCount: state.controls.minimizeCount + 1,
                },
            };
            return {
                result: resultMode === 'plugin' ? null : true,
                state: nextState,
            };
        }
        case 'plugin:window|toggle_maximize':
        case 'desktop_toggle_window_maximize':
        case 'desktop_window_toggle_maximize': {
            const isMaximized = !state.isMaximized;
            const nextState = {
                ...state,
                isMaximized,
                controls: {
                    ...state.controls,
                    toggleMaximizeCount: state.controls.toggleMaximizeCount + 1,
                },
            };
            return {
                result: resultMode === 'plugin'
                    ? null
                    : resultMode === 'legacy'
                        ? { isMaximized }
                        : true,
                state: nextState,
            };
        }
        case 'plugin:window|close':
        case 'desktop_close_window':
        case 'desktop_window_close': {
            const nextState = {
                ...state,
                controls: {
                    ...state.controls,
                    closeCount: state.controls.closeCount + 1,
                },
            };
            return {
                result: resultMode === 'plugin' ? null : true,
                state: nextState,
            };
        }
        case 'plugin:window|start_dragging':
        case 'desktop_start_window_dragging':
        case 'desktop_window_start_dragging': {
            const nextState = {
                ...state,
                controls: {
                    ...state.controls,
                    dragCount: state.controls.dragCount + 1,
                },
            };
            return {
                result: resultMode === 'plugin' ? null : true,
                state: nextState,
            };
        }
        case 'plugin:window|is_maximized':
            return {
                result: state.isMaximized,
                state,
            };
        case 'desktop_get_window_state':
            return {
                result: {
                    isMaximized: state.isMaximized,
                },
                state,
            };
        case 'desktop_window_get_state':
            return applyLegacyWindowStateResult(state);
        default:
            return {
                result: null,
                state,
            };
    }
}

export function createFakeTauriDesktopState(
    overrides: Partial<FakeTauriDesktopState> = {},
): FakeTauriDesktopState {
    const platform = overrides.platform ?? 'macos';
    return {
        autostartEnabled: false,
        controls: {
            closeCount: 0,
            dragCount: 0,
            minimizeCount: 0,
            toggleMaximizeCount: 0,
            ...(overrides.controls ?? {}),
        },
        currentWindowLabel: overrides.currentWindowLabel ?? MAIN_WINDOW_LABEL,
        desktopActivityOverlayState: overrides.desktopActivityOverlayState ?? null,
        desktopPetOverlayState: overrides.desktopPetOverlayState ?? null,
        invokeLog: overrides.invokeLog ?? [],
        isMaximized: false,
        platform,
        strategy: overrides.strategy ?? resolveDefaultStrategy(platform),
        trayState: overrides.trayState ?? null,
        updateAvailable: overrides.updateAvailable ?? null,
    };
}

export async function applyFakeTauriDesktopCommand(
    state: FakeTauriDesktopState,
    command: string,
    args?: Record<string, unknown>,
): Promise<FakeTauriDesktopCommandResult> {
    const nextStateBase = createNextStateBase(state, command, args);

    switch (command) {
        case 'desktop_activity_overlay_sync':
            return {
                result: null,
                state: {
                    ...nextStateBase,
                    desktopActivityOverlayState: readDesktopActivityOverlaySyncPayload(args),
                },
            };
        case 'desktop_activity_overlay_get_window_state':
            return {
                result: nextStateBase.desktopActivityOverlayState,
                state: nextStateBase,
            };
        case 'desktop_pet_overlay_read_window_state':
            return {
                result: nextStateBase.desktopPetOverlayState,
                state: nextStateBase,
            };
        case 'desktop_activity_overlay_set_expanded':
            return {
                result: null,
                state: {
                    ...nextStateBase,
                    desktopActivityOverlayState: resolveDesktopActivityOverlayExpandedState(
                        nextStateBase.desktopActivityOverlayState,
                        args?.expanded,
                    ),
                },
            };
        case 'desktop_activity_overlay_set_input_locked':
        case 'desktop_activity_overlay_apply_drag_delta':
        case 'desktop_activity_overlay_reset_position':
        case 'desktop_activity_overlay_emit_interaction':
        case 'desktop_activity_overlay_emit_interaction_result':
        case 'desktop_show_main_window':
            return {
                result: null,
                state: nextStateBase,
            };
        case 'desktop_get_window_chrome_policy':
            return {
                result: {
                    strategy: resolveFakeTauriDesktopChromeStrategy(nextStateBase),
                },
                state: nextStateBase,
            };
        case 'desktop_fetch_update':
            return {
                result: nextStateBase.updateAvailable,
                state: nextStateBase,
            };
        case 'desktop_install_update': {
            const installedUpdate = nextStateBase.updateAvailable
                ? {
                    ...nextStateBase.updateAvailable,
                    installed: true,
                }
                : null;
            return {
                result: installedUpdate != null,
                state: {
                    ...nextStateBase,
                    updateAvailable: installedUpdate,
                },
            };
        }
        case 'desktop_set_tray_state':
            return {
                result: null,
                state: {
                    ...nextStateBase,
                    trayState: args ?? null,
                },
            };
        case 'desktop_get_autostart_enabled':
            return {
                result: nextStateBase.autostartEnabled,
                state: nextStateBase,
            };
        case 'desktop_set_autostart_enabled': {
            const enabled = Boolean(args?.enabled);
            return {
                result: enabled,
                state: {
                    ...nextStateBase,
                    autostartEnabled: enabled,
                },
            };
        }
        case 'plugin:window|minimize':
        case 'plugin:window|toggle_maximize':
        case 'plugin:window|close':
        case 'plugin:window|start_dragging':
        case 'plugin:window|is_maximized':
            return applyWindowCommand(nextStateBase, command, 'plugin');
        case 'desktop_minimize_window':
        case 'desktop_toggle_window_maximize':
        case 'desktop_close_window':
        case 'desktop_start_window_dragging':
        case 'desktop_get_window_state':
            return applyWindowCommand(nextStateBase, command, 'bridge');
        case 'desktop_window_minimize':
        case 'desktop_window_toggle_maximize':
        case 'desktop_window_close':
        case 'desktop_window_start_dragging':
        case 'desktop_window_get_state':
            return applyWindowCommand(nextStateBase, command, 'legacy');
        default:
            return {
                result: null,
                state: nextStateBase,
            };
    }
}

export async function installFakeTauriDesktopBridge(
    page: Page,
    options: Readonly<{
        state?: Partial<FakeTauriDesktopState>;
    }> = {},
): Promise<void> {
    const initialState = createFakeTauriDesktopState(options.state);
    const installBridge = (serializedState: FakeTauriDesktopState) => {
        type BrowserFakeTauriDesktopState = FakeTauriDesktopState;
        type BrowserFakeCommandResult = FakeTauriDesktopCommandResult & {
            emittedEvents?: Array<Readonly<{ event: string; payload: unknown }>>;
        };

        const mainWindowLabel = 'main';
        const desktopWindowStateEvent = 'desktopWindow://state';
        const windowMovedEvent = 'tauri://move';
        const windowResizedEvent = 'tauri://resize';
        const win = window as MutableFakeTauriDesktopWindow;
        const listenersByEvent: Record<string, number[]> = Object.create(null);
        const callbacks = new Map<number, (data: unknown) => unknown>();
        let nextCallbackId = 1;

        const resolveDefaultStrategy = (platform: FakeTauriDesktopPlatform): FakeTauriDesktopStrategy =>
            platform === 'macos' ? 'native-macos-traffic-lights' : 'custom-controls';

        const resolveChromeStrategy = (
            state: Pick<BrowserFakeTauriDesktopState, 'currentWindowLabel' | 'platform' | 'strategy'>,
        ): FakeTauriDesktopStrategy => {
            if (state.currentWindowLabel !== mainWindowLabel) {
                return 'none';
            }
            return state.strategy === 'none' ? resolveDefaultStrategy(state.platform) : state.strategy;
        };

        const createNextStateBase = (
            state: BrowserFakeTauriDesktopState,
            command: string,
            args?: Record<string, unknown>,
        ): BrowserFakeTauriDesktopState => ({
            ...state,
            controls: {
                ...state.controls,
            },
            invokeLog: [
                ...state.invokeLog,
                {
                    args: args ?? null,
                    command,
                },
            ],
        });

        const applyWindowCommand = (
            state: BrowserFakeTauriDesktopState,
            command: string,
            resultMode: 'legacy' | 'plugin' | 'bridge',
        ): BrowserFakeCommandResult => {
            switch (command) {
                case 'plugin:window|minimize':
                case 'desktop_minimize_window':
                case 'desktop_window_minimize': {
                    const nextState = {
                        ...state,
                        controls: {
                            ...state.controls,
                            minimizeCount: state.controls.minimizeCount + 1,
                        },
                    };
                    return {
                        result: resultMode === 'plugin' ? null : true,
                        state: nextState,
                    };
                }
                case 'plugin:window|toggle_maximize':
                case 'desktop_toggle_window_maximize':
                case 'desktop_window_toggle_maximize': {
                    const isMaximized = !state.isMaximized;
                    const nextState = {
                        ...state,
                        isMaximized,
                        controls: {
                            ...state.controls,
                            toggleMaximizeCount: state.controls.toggleMaximizeCount + 1,
                        },
                    };
                    return {
                        emittedEvents: [
                            {
                                event: desktopWindowStateEvent,
                                payload: { isMaximized },
                            },
                            {
                                event: windowResizedEvent,
                                payload: { width: isMaximized ? 1440 : 1280, height: isMaximized ? 900 : 820 },
                            },
                        ],
                        result: resultMode === 'plugin'
                            ? null
                            : resultMode === 'legacy'
                                ? { isMaximized }
                                : true,
                        state: nextState,
                    };
                }
                case 'plugin:window|close':
                case 'desktop_close_window':
                case 'desktop_window_close': {
                    const nextState = {
                        ...state,
                        controls: {
                            ...state.controls,
                            closeCount: state.controls.closeCount + 1,
                        },
                    };
                    return {
                        result: resultMode === 'plugin' ? null : true,
                        state: nextState,
                    };
                }
                case 'plugin:window|start_dragging':
                case 'desktop_start_window_dragging':
                case 'desktop_window_start_dragging': {
                    const nextState = {
                        ...state,
                        controls: {
                            ...state.controls,
                            dragCount: state.controls.dragCount + 1,
                        },
                    };
                    return {
                        emittedEvents: [
                            {
                                event: windowMovedEvent,
                                payload: { x: 32, y: 24 },
                            },
                        ],
                        result: resultMode === 'plugin' ? null : true,
                        state: nextState,
                    };
                }
                case 'plugin:window|is_maximized':
                    return {
                        result: state.isMaximized,
                        state,
                    };
                case 'desktop_get_window_state':
                    return {
                        result: {
                            isMaximized: state.isMaximized,
                        },
                        state,
                    };
                case 'desktop_window_get_state':
                    return {
                        result: {
                            controls: state.controls,
                            isMaximized: state.isMaximized,
                            platform: state.platform,
                            strategy: resolveChromeStrategy(state),
                        },
                        state,
                    };
                default:
                    return {
                        result: null,
                        state,
                    };
            }
        };

        const emitEvent = (event: string, payload: unknown) => {
            for (const callbackId of listenersByEvent[event] ?? []) {
                const handler = callbacks.get(callbackId);
                if (!handler) {
                    continue;
                }
                handler({
                    event,
                    id: callbackId,
                    payload,
                });
            }
        };

        const unregisterListener = (event: string, id: number) => {
            const listeners = listenersByEvent[event] ?? [];
            listenersByEvent[event] = listeners.filter((value) => value !== id);
            callbacks.delete(id);
        };

        const applyCommand = (
            currentState: BrowserFakeTauriDesktopState,
            command: string,
            args?: Record<string, unknown>,
        ): BrowserFakeCommandResult => {
            const nextStateBase = createNextStateBase(currentState, command, args);

            switch (command) {
                case 'desktop_activity_overlay_sync': {
                    const payload = readDesktopActivityOverlaySyncPayload(args);
                    return {
                        emittedEvents: [
                            {
                                event: 'activityOverlay://state',
                                payload,
                            },
                        ],
                        result: null,
                        state: {
                            ...nextStateBase,
                            desktopActivityOverlayState: payload,
                        },
                    };
                }
                case 'desktop_activity_overlay_get_window_state':
                    return {
                        result: nextStateBase.desktopActivityOverlayState,
                        state: nextStateBase,
                    };
                case 'desktop_pet_overlay_read_window_state':
                    return {
                        result: nextStateBase.desktopPetOverlayState,
                        state: nextStateBase,
                    };
                case 'desktop_activity_overlay_set_expanded': {
                    const payload = resolveDesktopActivityOverlayExpandedState(
                        nextStateBase.desktopActivityOverlayState,
                        args?.expanded,
                    );
                    return {
                        emittedEvents: [
                            {
                                event: 'activityOverlay://state',
                                payload,
                            },
                        ],
                        result: null,
                        state: {
                            ...nextStateBase,
                            desktopActivityOverlayState: payload,
                        },
                    };
                }
                case 'desktop_activity_overlay_set_input_locked':
                case 'desktop_activity_overlay_apply_drag_delta':
                case 'desktop_activity_overlay_reset_position':
                case 'desktop_activity_overlay_emit_interaction':
                case 'desktop_activity_overlay_emit_interaction_result':
                case 'desktop_show_main_window':
                    return {
                        result: null,
                        state: nextStateBase,
                    };
                case 'plugin:event|listen': {
                    const event = String(args?.event ?? '').trim();
                    const handler = Number(args?.handler);
                    if (!event || !Number.isFinite(handler)) {
                        return {
                            result: null,
                            state: nextStateBase,
                        };
                    }
                    listenersByEvent[event] = [...(listenersByEvent[event] ?? []), handler];
                    return {
                        result: handler,
                        state: nextStateBase,
                    };
                }
                case 'plugin:event|unlisten': {
                    const event = String(args?.event ?? '').trim();
                    const eventId = Number(args?.eventId);
                    if (event && Number.isFinite(eventId)) {
                        unregisterListener(event, eventId);
                    }
                    return {
                        result: null,
                        state: nextStateBase,
                    };
                }
                case 'plugin:event|emit':
                case 'plugin:event|emit_to': {
                    const event = String(args?.event ?? '').trim();
                    if (event) {
                        emitEvent(event, args?.payload ?? null);
                    }
                    return {
                        result: null,
                        state: nextStateBase,
                    };
                }
                case 'desktop_get_window_chrome_policy':
                    return {
                        result: {
                            strategy: resolveChromeStrategy(nextStateBase),
                        },
                        state: nextStateBase,
                    };
                case 'desktop_fetch_update':
                    return {
                        result: nextStateBase.updateAvailable,
                        state: nextStateBase,
                    };
                case 'desktop_install_update': {
                    const installedUpdate = nextStateBase.updateAvailable
                        ? {
                            ...nextStateBase.updateAvailable,
                            installed: true,
                        }
                        : null;
                    return {
                        result: installedUpdate != null,
                        state: {
                            ...nextStateBase,
                            updateAvailable: installedUpdate,
                        },
                    };
                }
                case 'desktop_set_tray_state':
                    return {
                        result: null,
                        state: {
                            ...nextStateBase,
                            trayState: args ?? null,
                        },
                    };
                case 'desktop_get_autostart_enabled':
                    return {
                        result: nextStateBase.autostartEnabled,
                        state: nextStateBase,
                    };
                case 'desktop_set_autostart_enabled': {
                    const enabled = Boolean(args?.enabled);
                    return {
                        result: enabled,
                        state: {
                            ...nextStateBase,
                            autostartEnabled: enabled,
                        },
                    };
                }
                case 'plugin:window|minimize':
                case 'plugin:window|toggle_maximize':
                case 'plugin:window|close':
                case 'plugin:window|start_dragging':
                case 'plugin:window|is_maximized':
                    return applyWindowCommand(nextStateBase, command, 'plugin');
                case 'desktop_minimize_window':
                case 'desktop_toggle_window_maximize':
                case 'desktop_close_window':
                case 'desktop_start_window_dragging':
                case 'desktop_get_window_state':
                    return applyWindowCommand(nextStateBase, command, 'bridge');
                case 'desktop_window_minimize':
                case 'desktop_window_toggle_maximize':
                case 'desktop_window_close':
                case 'desktop_window_start_dragging':
                case 'desktop_window_get_state':
                    return applyWindowCommand(nextStateBase, command, 'legacy');
                default:
                    return {
                        result: null,
                        state: nextStateBase,
                    };
            }
        };

        const transformCallback = (
            callback: ((data: unknown) => unknown) | undefined,
            once = false,
        ): number => {
            const callbackId = nextCallbackId;
            nextCallbackId += 1;
            callbacks.set(callbackId, (data) => {
                if (once) {
                    callbacks.delete(callbackId);
                }
                return callback?.(data);
            });
            return callbackId;
        };

        const unregisterCallback = (id: number) => {
            callbacks.delete(id);
        };

        const runCallback = (id: number, data: unknown) => {
            callbacks.get(id)?.(data);
        };

        win.__HAPPIER_FAKE_TAURI_DESKTOP__ = serializedState;
        win.__HAPPIER_FAKE_TAURI_EVENT_LISTENERS__ = listenersByEvent;
        win.__TAURI_INTERNALS__ = {
            callbacks,
            invoke: async (command: string, args?: Record<string, unknown>) => {
                const result = applyCommand(
                    win.__HAPPIER_FAKE_TAURI_DESKTOP__ ?? serializedState,
                    command,
                    args,
                );
                win.__HAPPIER_FAKE_TAURI_DESKTOP__ = result.state;
                for (const emittedEvent of result.emittedEvents ?? []) {
                    emitEvent(emittedEvent.event, emittedEvent.payload);
                }
                return result.result;
            },
            metadata: {
                currentWindow: { label: serializedState.currentWindowLabel },
                currentWebview: {
                    label: serializedState.currentWindowLabel,
                    windowLabel: serializedState.currentWindowLabel,
                },
            },
            runCallback,
            transformCallback,
            unregisterCallback,
        };
        win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
            unregisterListener,
        };
        win.__TAURI__ = {
            core: {
                invoke: win.__TAURI_INTERNALS__.invoke,
            },
        };
    };

    await page.addInitScript(installBridge, initialState);
    if (page.url() !== 'about:blank') {
        await page.evaluate(installBridge, initialState);
    }
}

export async function readFakeTauriDesktopState(page: Page): Promise<FakeTauriDesktopState> {
    return page.evaluate(() => {
        const win = window as MutableFakeTauriDesktopWindow;
        if (!win.__HAPPIER_FAKE_TAURI_DESKTOP__) {
            throw new Error('Fake Tauri desktop bridge is not installed.');
        }
        return win.__HAPPIER_FAKE_TAURI_DESKTOP__;
    });
}

export async function invokeFakeTauriDesktopCommand(
    page: Page,
    command: string,
    args?: Record<string, unknown>,
): Promise<unknown> {
    return page.evaluate(
        async ({ resolvedArgs, resolvedCommand }) => {
            const win = window as MutableFakeTauriDesktopWindow;
            if (!win.__TAURI_INTERNALS__?.invoke) {
                throw new Error('Fake Tauri desktop bridge is not installed.');
            }
            return win.__TAURI_INTERNALS__.invoke(resolvedCommand, resolvedArgs ?? undefined);
        },
        {
            resolvedArgs: args ?? null,
            resolvedCommand: command,
        },
    );
}

export async function navigateSpa(page: Page, path: string): Promise<void> {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}
