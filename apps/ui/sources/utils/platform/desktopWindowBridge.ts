import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';

export const DESKTOP_WINDOW_CHROME_POLICY_COMMAND = 'desktop_get_window_chrome_policy';
export const DESKTOP_WINDOW_SET_NATIVE_TITLE_BAR_COMMAND = 'desktop_set_native_title_bar';
export const DESKTOP_WINDOW_STATE_COMMAND = 'desktop_get_window_state';
export const DESKTOP_WINDOW_MINIMIZE_COMMAND = 'desktop_minimize_window';
export const DESKTOP_WINDOW_TOGGLE_MAXIMIZE_COMMAND = 'desktop_toggle_window_maximize';
export const DESKTOP_WINDOW_CLOSE_COMMAND = 'desktop_close_window';
export const DESKTOP_WINDOW_START_DRAGGING_COMMAND = 'desktop_start_window_dragging';

export const DESKTOP_WINDOW_EVENTS = {
    state: 'desktopWindow://state',
} as const;

export type DesktopWindowChromeStrategy =
    | 'none'
    | 'native-macos-traffic-lights'
    | 'native-windows-frame'
    | 'custom-controls';

export interface DesktopWindowChromePolicy {
    strategy: DesktopWindowChromeStrategy;
    /** Absent on older desktop binaries and outside the Windows main window. */
    canSetNativeTitleBar?: boolean;
    nativeTitleBarPersistenceError?: boolean;
}

export interface DesktopWindowState {
    isMaximized: boolean;
}

const DISABLED_DESKTOP_WINDOW_CHROME_POLICY: DesktopWindowChromePolicy = {
    strategy: 'none',
};

const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
    isMaximized: false,
};

function normalizeDesktopWindowChromePolicy(value: unknown): DesktopWindowChromePolicy {
    const strategy = typeof (value as DesktopWindowChromePolicy | null)?.strategy === 'string'
        ? (value as DesktopWindowChromePolicy).strategy
        : 'none';

    if (
        strategy !== 'none'
        && strategy !== 'native-macos-traffic-lights'
        && strategy !== 'native-windows-frame'
        && strategy !== 'custom-controls'
    ) {
        return DISABLED_DESKTOP_WINDOW_CHROME_POLICY;
    }

    const payload = value as Partial<DesktopWindowChromePolicy>;
    return {
        strategy,
        ...(payload.canSetNativeTitleBar === true ? { canSetNativeTitleBar: true } : {}),
        ...(payload.nativeTitleBarPersistenceError === true ? { nativeTitleBarPersistenceError: true } : {}),
    };
}

const chromePolicyListeners = new Set<(policy: DesktopWindowChromePolicy) => void>();

export function subscribeDesktopWindowChromePolicy(listener: (policy: DesktopWindowChromePolicy) => void): () => void {
    chromePolicyListeners.add(listener);
    return () => { chromePolicyListeners.delete(listener); };
}

export function desktopWindowChromeUsesAppDragRegions(policy: DesktopWindowChromePolicy): boolean {
    return policy.strategy === 'custom-controls' || policy.strategy === 'native-macos-traffic-lights';
}

export async function setDesktopNativeTitleBar(useNativeTitleBar: boolean): Promise<DesktopWindowChromePolicy> {
    const policy = normalizeDesktopWindowChromePolicy(await invokeTauri<unknown>(
        DESKTOP_WINDOW_SET_NATIVE_TITLE_BAR_COMMAND, { useNativeTitleBar },
    ));
    if (policy.canSetNativeTitleBar !== true) {
        throw new Error('Native title bar preference is unavailable');
    }
    // The main webview is the only writer. Publish the native owner's effective policy,
    // including a failed save, so settings, controls and drag regions agree immediately.
    for (const listener of chromePolicyListeners) listener(policy);
    return policy;
}

function normalizeDesktopWindowState(value: unknown): DesktopWindowState {
    return {
        isMaximized: (value as DesktopWindowState | null)?.isMaximized === true,
    };
}

function desktopWindowChromePolicySupportsControls(
    policy: DesktopWindowChromePolicy,
): boolean {
    return policy.strategy !== 'none';
}

async function resolveDesktopWindowChromePolicy(): Promise<DesktopWindowChromePolicy> {
    if (!isTauriDesktop()) {
        return DISABLED_DESKTOP_WINDOW_CHROME_POLICY;
    }

    try {
        return normalizeDesktopWindowChromePolicy(
            await invokeTauri<DesktopWindowChromePolicy>(DESKTOP_WINDOW_CHROME_POLICY_COMMAND),
        );
    } catch {
        return DISABLED_DESKTOP_WINDOW_CHROME_POLICY;
    }
}

async function invokeDesktopWindowCommand(command: string): Promise<boolean> {
    const policy = await resolveDesktopWindowChromePolicy();
    if (!desktopWindowChromePolicySupportsControls(policy)) {
        return false;
    }

    try {
        return (await invokeTauri<boolean>(command)) === true;
    } catch {
        return false;
    }
}

async function getDesktopWindowStateForPolicy(
    policy: DesktopWindowChromePolicy,
): Promise<DesktopWindowState> {
    if (!desktopWindowChromePolicySupportsControls(policy)) {
        return DEFAULT_DESKTOP_WINDOW_STATE;
    }

    try {
        return normalizeDesktopWindowState(
            await invokeTauri<DesktopWindowState>(DESKTOP_WINDOW_STATE_COMMAND),
        );
    } catch {
        return DEFAULT_DESKTOP_WINDOW_STATE;
    }
}

export async function getDesktopWindowChromePolicy(): Promise<DesktopWindowChromePolicy> {
    return resolveDesktopWindowChromePolicy();
}

export async function minimizeDesktopWindow(): Promise<void> {
    await invokeDesktopWindowCommand(DESKTOP_WINDOW_MINIMIZE_COMMAND);
}

export async function toggleDesktopWindowMaximize(): Promise<void> {
    await invokeDesktopWindowCommand(DESKTOP_WINDOW_TOGGLE_MAXIMIZE_COMMAND);
}

export async function closeDesktopWindow(): Promise<void> {
    await invokeDesktopWindowCommand(DESKTOP_WINDOW_CLOSE_COMMAND);
}

export async function startDesktopWindowDragging(): Promise<void> {
    await invokeDesktopWindowCommand(DESKTOP_WINDOW_START_DRAGGING_COMMAND);
}

export async function getDesktopWindowState(): Promise<DesktopWindowState> {
    return getDesktopWindowStateForPolicy(await resolveDesktopWindowChromePolicy());
}

export async function listenDesktopWindowState(
    handler: (state: DesktopWindowState) => void,
): Promise<() => Promise<void>> {
    const policy = await resolveDesktopWindowChromePolicy();
    const initialState = await getDesktopWindowStateForPolicy(policy);
    handler(initialState);

    if (!desktopWindowChromePolicySupportsControls(policy)) {
        return async () => {};
    }

    try {
        const unlisten = await listenTauriEvent<DesktopWindowState>(
            DESKTOP_WINDOW_EVENTS.state,
            (payload) => {
                handler(normalizeDesktopWindowState(payload));
            },
        );

        return async () => {
            try {
                await unlisten();
            } catch {
                // Shutdown and test fakes can invalidate event handles before cleanup runs.
            }
        };
    } catch {
        return async () => {};
    }
}
