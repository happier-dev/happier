import { formatNotImplementedError } from '../../shared/bridge';
import type { DesktopEventBus } from '../ipc/eventBus';
import { readStackBootCredentials } from './bootCredentials';
import { HttpPluginState, registerHttpPluginCommands } from './httpPlugin';
import { EVENT_PLUGIN_COMMANDS, isKnownTauriDesktopCommand } from './inventory';
import type { CommandArgs, CommandContext, CommandHandler, CommandRegistry } from './types';

/**
 * Only the commands the app actually reaches during boot are implemented here. Every other name in
 * `TAURI_DESKTOP_COMMANDS` rejects with the not-implemented sentinel so a caller can tell an
 * absent implementation from a failed operation, and so no surface can be misled by invented data.
 */

/**
 * The Tauri host normalizes every serialized mode — including the legacy `preAuth` value the
 * renderer can still send — onto `main`, so there is exactly one mode to record.
 */
export type WindowMode = 'main';

export type DesktopWindowChromeStrategy = 'none' | 'native-macos-traffic-lights' | 'custom-controls';

/** Mirrors `resolve_desktop_window_chrome_runtime_policy` for the main window. */
export function resolveWindowChromeStrategy(platform: NodeJS.Platform): DesktopWindowChromeStrategy {
    return platform === 'darwin' ? 'native-macos-traffic-lights' : 'custom-controls';
}

export function normalizeWindowMode(_requestedMode: unknown): WindowMode {
    return 'main';
}

function readNumber(args: CommandArgs, key: string): number | null {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(args: CommandArgs, key: string): string | null {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export type RegistryDependencies = Readonly<{
    eventBus: DesktopEventBus;
    /** Presents the main window, mirroring `desktop_show_main_window`. Returns whether it existed. */
    showMainWindow: () => boolean;
    /** Records the window mode the renderer asked for. */
    setWindowMode: (mode: WindowMode) => void;
    /** Reads and writes the OS login-item state. Injected so the registry stays Electron-free. */
    autostart: Readonly<{
        isEnabled: () => boolean;
        setEnabled: (enabled: boolean) => boolean;
    }>;
    platform?: NodeJS.Platform;
}>;

export function createCommandRegistry(dependencies: RegistryDependencies): CommandRegistry {
    const platform = dependencies.platform ?? process.platform;
    const registry = new Map<string, CommandHandler>();

    // Every http(s) request the app makes on desktop goes through this plugin, so it is part of
    // the boot path rather than an optional capability.
    registerHttpPluginCommands(registry, new HttpPluginState());

    registry.set(EVENT_PLUGIN_COMMANDS.listen, (args, context) => {
        const eventName = readString(args, 'event');
        const callbackId = readNumber(args, 'handler');
        if (eventName === null || callbackId === null) {
            throw new Error('plugin:event|listen requires an event name and a handler id');
        }
        return dependencies.eventBus.listen(eventName, callbackId, context.sender);
    });

    registry.set(EVENT_PLUGIN_COMMANDS.unlisten, (args) => {
        const eventId = readNumber(args, 'eventId');
        if (eventId !== null) {
            dependencies.eventBus.unlisten(eventId);
        }
        return null;
    });

    const emitHandler: CommandHandler = (args) => {
        const eventName = readString(args, 'event');
        if (eventName === null) {
            throw new Error('plugin:event|emit requires an event name');
        }
        dependencies.eventBus.emit(eventName, args.payload ?? null);
        return null;
    };
    registry.set(EVENT_PLUGIN_COMMANDS.emit, emitHandler);
    registry.set(EVENT_PLUGIN_COMMANDS.emitTo, emitHandler);

    registry.set('desktop_show_main_window', () => dependencies.showMainWindow());

    registry.set('desktop_set_window_mode', (args) => {
        dependencies.setWindowMode(normalizeWindowMode(args.mode));
        return null;
    });

    registry.set('desktop_read_stack_boot_credentials', () => readStackBootCredentials());

    registry.set('desktop_get_window_chrome_policy', () => ({
        strategy: resolveWindowChromeStrategy(platform),
    }));

    registry.set('desktop_get_window_state', (_args, context: CommandContext) => ({
        isMaximized: context.window?.isMaximized() === true,
    }));

    registry.set('desktop_minimize_window', (_args, context: CommandContext) => {
        if (!context.window) return false;
        context.window.minimize();
        return true;
    });

    registry.set('desktop_toggle_window_maximize', (_args, context: CommandContext) => {
        const window = context.window;
        if (!window) return false;
        if (window.isMaximized()) {
            window.unmaximize();
        } else {
            window.maximize();
        }
        return true;
    });

    registry.set('desktop_close_window', (_args, context: CommandContext) => {
        if (!context.window) return false;
        context.window.close();
        return true;
    });

    registry.set('desktop_get_autostart_enabled', () => dependencies.autostart.isEnabled());

    registry.set('desktop_set_autostart_enabled', (args) => dependencies.autostart.setEnabled(args.enabled === true));

    return registry;
}

export type CommandOutcome =
    | Readonly<{ kind: 'implemented'; value: unknown }>
    | Readonly<{ kind: 'not-implemented'; command: string; known: boolean }>;

/**
 * Resolves a command to its result, or reports that this target has no implementation for it.
 * Callers turn a `not-implemented` outcome into a rejection carrying the sentinel prefix.
 */
export async function runCommand(
    registry: CommandRegistry,
    command: string,
    args: CommandArgs,
    context: CommandContext,
): Promise<CommandOutcome> {
    const handler = registry.get(command);
    if (!handler) {
        return { kind: 'not-implemented', command, known: isKnownTauriDesktopCommand(command) };
    }
    return { kind: 'implemented', value: await handler(args, context) };
}

export function describeNotImplemented(outcome: Extract<CommandOutcome, { kind: 'not-implemented' }>): string {
    return formatNotImplementedError(outcome.command);
}
