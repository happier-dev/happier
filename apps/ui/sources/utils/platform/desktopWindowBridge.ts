import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';

export const DESKTOP_WINDOW_CHROME_POLICY_COMMAND = 'desktop_get_window_chrome_policy';
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
    | 'custom-controls';

export interface DesktopWindowChromePolicy {
    strategy: DesktopWindowChromeStrategy;
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
        && strategy !== 'custom-controls'
    ) {
        return DISABLED_DESKTOP_WINDOW_CHROME_POLICY;
    }

    return { strategy };
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
