import { EventEmitter } from 'node:events';
import type { App } from 'electron';

import { DesktopEventBus } from '../ipc/eventBus';
import { createLoginItemWriter } from '../loginItem';
import { DesktopQuitLifecycle } from '../quitLifecycle';
import { createCommandRegistry } from './registry';
import type { CommandContext } from './types';

type FakeSender = Readonly<{
    sent: { channel: string; message: unknown }[];
    isDestroyed: () => boolean;
    send: (channel: string, message: unknown) => void;
}>;

function createFakeSender(): FakeSender {
    const sent: { channel: string; message: unknown }[] = [];
    return {
        sent,
        isDestroyed: () => false,
        send: (channel, message) => {
            sent.push({ channel, message });
        },
    };
}

export function createHarness(options: Readonly<{
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    development?: boolean;
    rejectLoginItemWrite?: boolean;
    appVersion?: string;
}> = {}) {
    const eventBus = new DesktopEventBus();
    const shown: number[] = [];
    let autostartEnabled = false;
    const loginItemWrites: Array<Readonly<{ openAtLogin: boolean }>> = [];
    const secureValues = new Map<string, string>();
    const irohStarts: unknown[] = [];
    const irohStops: string[] = [];
    const irohStatusReads: string[] = [];
    const systemTaskCalls: Array<readonly [string, ...unknown[]]> = [];
    const desktopFileCalls: Array<readonly [string, ...unknown[]]> = [];
    const app = new EventEmitter();
    let quitCalls = 0;
    const quitLifecycle = new DesktopQuitLifecycle({
        // Electron is the process boundary; keep the real quit owner and event bridge beneath it.
        app: Object.assign(app, { quit: () => { quitCalls += 1; } }) as unknown as Pick<App, 'on' | 'quit'>,
        eventBus,
        ensureMainWindow: async () => {},
        showMainWindow: () => { shown.push(1); },
        shutdownForProcessExit: async () => {},
    });
    const registry = createCommandRegistry({
        eventBus,
        getAppVersion: () => options.appVersion ?? '0.3.electron-wrapper',
        quitLifecycle,
        showMainWindow: () => {
            shown.push(1);
            return true;
        },
        setWindowMode: () => {},
        autostart: createLoginItemWriter({
            platform: options.platform ?? 'darwin',
            isPackaged: options.isPackaged ?? true,
            development: options.development ?? false,
            api: {
                getLoginItemSettings: () => ({ openAtLogin: autostartEnabled }),
                setLoginItemSettings: (settings) => {
                    loginItemWrites.push(settings);
                    if (!options.rejectLoginItemWrite) autostartEnabled = settings.openAtLogin;
                },
            },
        }),
        secureStorage: {
            read: async (key) => secureValues.get(key) ?? null,
            write: async (key, value) => {
                secureValues.set(key, value);
            },
            remove: async (key) => {
                secureValues.delete(key);
            },
        },
        irohTunnel: {
            getAvailability: async () => ({ available: true }),
            ensureHomeTunnel: async (request) => {
                irohStarts.push(request);
                return { leaseId: 'iroh-lease-1' };
            },
            releaseHomeTunnel: async (leaseId) => {
                irohStops.push(leaseId);
            },
            getTunnelStatus: async (leaseId) => {
                irohStatusReads.push(leaseId);
                return { active: false, connectionActive: false, observedPath: 'relay' };
            },
            getApplicationEndpoint: async () => ({ endpointId: 'a'.repeat(64) }),
            startMachineTunnel: async (request) => {
                irohStarts.push(request);
                return { leaseId: 'machine-raw-lease-1', localPort: 48122 };
            },
            startMachineHttpTunnel: async () => ({ leaseId: 'machine-lease-1', localOrigin: 'http://127.0.0.1:48123' }),
            stopMachineTunnel: async (leaseId) => {
                irohStops.push(leaseId);
            },
            waitMachineTunnelClosed: async () => undefined,
        },
        systemTasks: {
            start: async (specJson) => {
                systemTaskCalls.push(['start', specJson]);
                return { taskId: 'system_task_1' };
            },
            cancel: async (taskId) => {
                systemTaskCalls.push(['cancel', taskId]);
            },
            snapshot: (taskId) => {
                systemTaskCalls.push(['snapshot', taskId]);
                return { events: [], result: null };
            },
            respondToPrompt: async (taskId, answerJson) => {
                systemTaskCalls.push(['respond', taskId, answerJson]);
            },
        },
        desktopFiles: {
            pickPersonalHomeBackupArchive: async () => {
                desktopFileCalls.push(['pick']);
                return '/tmp/input.tar';
            },
            savePersonalHomeBackupArchive: async () => {
                desktopFileCalls.push(['save']);
                return '/tmp/output.tar';
            },
            openSystemTaskLogPath: async (path) => {
                desktopFileCalls.push(['open-log', path]);
            },
            revealSystemTaskOutputPath: (path) => {
                desktopFileCalls.push(['reveal', path]);
            },
        },
        platform: 'darwin',
    });
    const sender = createFakeSender();
    const context = {
        window: null,
        sender: sender as unknown as CommandContext['sender'],
        emitEvent: (name: string, payload: unknown) => eventBus.emit(name, payload),
        sendCallback: (callbackId: number, payload: unknown) => {
            sender.send('happier-desktop:callback', { callbackId, payload, once: false });
        },
    } satisfies CommandContext;
    return {
        eventBus,
        registry,
        sender,
        context,
        shown,
        secureValues,
        irohStarts,
        irohStops,
        irohStatusReads,
        systemTaskCalls,
        desktopFileCalls,
        readAutostartEnabled: () => autostartEnabled,
        loginItemWrites,
        app,
        readQuitCalls: () => quitCalls,
    };
}
