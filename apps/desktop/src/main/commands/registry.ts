import { formatNotImplementedError } from '../../shared/bridge';
import type { DesktopEventBus } from '../ipc/eventBus';
import type { DesktopQuitLifecycle } from '../quitLifecycle';
import { readDesktopWindowState } from '../windowState';
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

function readStorageKey(args: CommandArgs): string | null {
    return typeof args.key === 'string' ? args.key : null;
}

export type RegistryDependencies = Readonly<{
    eventBus: DesktopEventBus;
    quitLifecycle: Pick<DesktopQuitLifecycle, 'finishShutdown' | 'rendererListening'>;
    /** Presents the main window, mirroring `desktop_show_main_window`. Returns whether it existed. */
    showMainWindow: () => boolean;
    /** Records the window mode the renderer asked for. */
    setWindowMode: (mode: WindowMode) => void;
    /** Writes the service-backed OS login item. Injected so the registry stays Electron-free. */
    autostart: Readonly<{
        setEnabled: (enabled: boolean) => void;
    }>;
    secureStorage: Readonly<{
        read: (key: string) => Promise<string | null>;
        write: (key: string, value: string) => Promise<void>;
        remove: (key: string) => Promise<void>;
    }>;
    /** Shared Iroh desktop Home-tunnel lifecycle; the endpoint identity stays host-owned. */
    irohTunnel: Readonly<{
        ensureHomeTunnel: (request: unknown) => Promise<unknown>;
        releaseHomeTunnel: (leaseId: string) => Promise<void>;
        getTunnelStatus: (tunnelId: string) => Promise<Record<string, unknown> | null>;
        getApplicationEndpoint: (request: unknown) => Promise<{ endpointId: string }>;
        getAvailability: () => Promise<{ available: boolean }>;
        startMachineTunnel: (request: unknown) => Promise<unknown>;
        startMachineHttpTunnel: (request: unknown) => Promise<unknown>;
        stopMachineTunnel: (leaseId: string) => Promise<void>;
    }>;
    systemTasks: Readonly<{
        start: (specJson: string) => Promise<{ taskId: string }>;
        cancel: (taskId: string) => Promise<void>;
        snapshot: (taskId: string) => unknown;
        respondToPrompt: (taskId: string, answerJson: string) => Promise<void>;
    }>;
    desktopFiles: Readonly<{
        pickPersonalHomeBackupArchive: () => Promise<string | null>;
        savePersonalHomeBackupArchive: () => Promise<string | null>;
        openSystemTaskLogPath: (path: string) => Promise<void>;
        revealSystemTaskOutputPath: (path: string) => void;
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
        const eventId = dependencies.eventBus.listen(eventName, callbackId, context.sender);
        dependencies.quitLifecycle.rendererListening(eventName);
        return eventId;
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

    registry.set('desktop_finish_shutdown', (args) => {
        if (args.outcome !== undefined && args.outcome !== 'menuBar') {
            throw new Error('desktop_finish_shutdown requires an omitted outcome or menuBar');
        }
        dependencies.quitLifecycle.finishShutdown(args.outcome);
        return null;
    });

    registry.set('desktop_set_window_mode', (args) => {
        dependencies.setWindowMode(normalizeWindowMode(args.mode));
        return null;
    });

    registry.set('desktop_read_stack_boot_credentials', () => readStackBootCredentials());

    registry.set('desktop_secure_storage_read', (args) => {
        const key = readStorageKey(args);
        if (key === null) throw new Error('desktop_secure_storage_read requires a key');
        return dependencies.secureStorage.read(key);
    });

    registry.set('desktop_secure_storage_write', async (args) => {
        const key = readStorageKey(args);
        if (key === null || typeof args.value !== 'string') {
            throw new Error('desktop_secure_storage_write requires a key and value');
        }
        await dependencies.secureStorage.write(key, args.value);
        return null;
    });

    registry.set('desktop_secure_storage_remove', async (args) => {
        const key = readStorageKey(args);
        if (key === null) throw new Error('desktop_secure_storage_remove requires a key');
        await dependencies.secureStorage.remove(key);
        return null;
    });

    registry.set('start_system_task', (args) => {
        const specJson = readString(args, 'specJson');
        if (specJson === null) throw new Error('start_system_task requires specJson');
        return dependencies.systemTasks.start(specJson);
    });

    registry.set('cancel_system_task', async (args) => {
        const taskId = readString(args, 'taskId');
        if (taskId === null) throw new Error('cancel_system_task requires a taskId');
        await dependencies.systemTasks.cancel(taskId);
        return null;
    });

    registry.set('get_system_task_snapshot', (args) => {
        const taskId = readString(args, 'taskId');
        if (taskId === null) throw new Error('get_system_task_snapshot requires a taskId');
        return dependencies.systemTasks.snapshot(taskId);
    });

    registry.set('respond_system_task_prompt', async (args) => {
        const taskId = readString(args, 'taskId');
        const answerJson = readString(args, 'answerJson');
        if (taskId === null || answerJson === null) {
            throw new Error('respond_system_task_prompt requires a taskId and answerJson');
        }
        await dependencies.systemTasks.respondToPrompt(taskId, answerJson);
        return null;
    });

    registry.set('desktop_pick_personal_home_backup_archive', () => (
        dependencies.desktopFiles.pickPersonalHomeBackupArchive()
    ));
    registry.set('desktop_save_personal_home_backup_archive', () => (
        dependencies.desktopFiles.savePersonalHomeBackupArchive()
    ));
    registry.set('system_tasks_open_log_path', async (args) => {
        const path = readString(args, 'path');
        if (path === null) throw new Error('system_tasks_open_log_path requires a path');
        await dependencies.desktopFiles.openSystemTaskLogPath(path);
        return null;
    });
    registry.set('system_tasks_reveal_output_path', (args) => {
        const path = readString(args, 'path');
        if (path === null) throw new Error('system_tasks_reveal_output_path requires a path');
        dependencies.desktopFiles.revealSystemTaskOutputPath(path);
        return null;
    });

    // Same command names and request/response shapes as the Tauri host: the
    // renderer's desktop lifecycle module targets one shared contract.
    registry.set('iroh_ensure_home_tunnel', async (args) => {
        if (!args.request || typeof args.request !== 'object') {
            throw new Error('iroh_ensure_home_tunnel requires a request');
        }
        return dependencies.irohTunnel.ensureHomeTunnel(args.request);
    });

    registry.set('iroh_release_home_tunnel', async (args) => {
        const leaseId = readString(args, 'leaseId');
        if (leaseId === null) throw new Error('iroh_release_home_tunnel requires a leaseId');
        await dependencies.irohTunnel.releaseHomeTunnel(leaseId);
        return null;
    });

    registry.set('iroh_get_tunnel_status', async (args) => {
        const leaseId = readString(args, 'leaseId');
        if (leaseId === null) {
            throw new Error('iroh_get_tunnel_status requires a leaseId');
        }
        return dependencies.irohTunnel.getTunnelStatus(leaseId);
    });
    registry.set('iroh_get_availability', () => dependencies.irohTunnel.getAvailability());
    registry.set('iroh_get_application_endpoint', (args) => {
        if (!args.request || typeof args.request !== 'object') throw new Error('iroh_get_application_endpoint requires a request');
        return dependencies.irohTunnel.getApplicationEndpoint(args.request);
    });
    registry.set('iroh_start_machine_tunnel', (args) => {
        if (!args.request || typeof args.request !== 'object') throw new Error('iroh_start_machine_tunnel requires a request');
        return dependencies.irohTunnel.startMachineTunnel(args.request);
    });
    registry.set('iroh_start_machine_http_tunnel', (args) => {
        if (!args.request || typeof args.request !== 'object') throw new Error('iroh_start_machine_http_tunnel requires a request');
        return dependencies.irohTunnel.startMachineHttpTunnel(args.request);
    });
    registry.set('iroh_stop_machine_tunnel', async (args) => {
        const leaseId = readString(args, 'leaseId');
        if (leaseId === null) throw new Error('iroh_stop_machine_tunnel requires a leaseId');
        await dependencies.irohTunnel.stopMachineTunnel(leaseId);
        return null;
    });

    registry.set('desktop_get_window_chrome_policy', () => ({
        strategy: resolveWindowChromeStrategy(platform),
    }));

    registry.set('desktop_get_window_state', (_args, context: CommandContext) => (
        readDesktopWindowState(context.window)
    ));

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

    // Electron currently consumes the shared login preference only; it has no native tray
    // renderer. The UI owns this setting through the background services, never an app toggle.
    registry.set('desktop_set_tray_state', (args) => {
        const state = args.state;
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            throw new Error('desktop_set_tray_state requires state');
        }
        const mode = (state as Readonly<Record<string, unknown>>).serviceAutostart;
        if (mode === 'at-login' || mode === 'on-demand') {
            dependencies.autostart.setEnabled(mode === 'at-login');
        }
        return null;
    });

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
