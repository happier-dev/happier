import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { App, BrowserWindow } from 'electron';

import { isNotImplementedError, NOT_IMPLEMENTED_ERROR_PREFIX } from '../../shared/bridge';
import { DesktopEventBus } from '../ipc/eventBus';
import { createLoginItemWriter } from '../loginItem';
import { DesktopQuitLifecycle } from '../quitLifecycle';
import { TAURI_DESKTOP_COMMANDS } from './inventory';
import { createCommandRegistry, describeNotImplemented, resolveWindowChromeStrategy, runCommand } from './registry';
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

function createHarness(options: Readonly<{
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    development?: boolean;
    rejectLoginItemWrite?: boolean;
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

test('secure storage commands share the Tauri schema and roundtrip through the injected OS boundary', async () => {
    const { registry, context, secureValues } = createHarness();
    const key = 'home:token';

    assert.deepEqual(await runCommand(registry, 'desktop_secure_storage_read', { key }, context), {
        kind: 'implemented',
        value: null,
    });
    assert.deepEqual(await runCommand(registry, 'desktop_secure_storage_write', { key, value: 'secret' }, context), {
        kind: 'implemented',
        value: null,
    });
    assert.equal(secureValues.get(key), 'secret');
    assert.deepEqual(await runCommand(registry, 'desktop_secure_storage_read', { key }, context), {
        kind: 'implemented',
        value: 'secret',
    });
    assert.deepEqual(await runCommand(registry, 'desktop_secure_storage_remove', { key }, context), {
        kind: 'implemented',
        value: null,
    });
});

test('the shared renderer can finish a desktop shutdown through the registered command', async () => {
    const { registry, context, app, readQuitCalls } = createHarness();
    app.emit('before-quit', { preventDefault: () => {} });
    assert.deepEqual(await runCommand(registry, 'desktop_finish_shutdown', {}, context), {
        kind: 'implemented',
        value: null,
    });
    assert.equal(readQuitCalls(), 1);
});

test('late quit-listener registration receives the pending handoff once and cancellation keeps the window', async () => {
    const { registry, context, app, sender, shown, readQuitCalls } = createHarness();
    app.emit('before-quit', { preventDefault: () => {} });
    await Promise.resolve();
    assert.deepEqual(sender.sent, []);
    await runCommand(registry, 'plugin:event|listen', { event: 'desktop_app_exit_requested', handler: 17 }, context);
    await runCommand(registry, 'plugin:event|listen', { event: 'desktop_app_exit_requested', handler: 18 }, context);
    assert.deepEqual(sender.sent, [{
        channel: 'happier-desktop:callback',
        message: {
            callbackId: 17,
            payload: { event: 'desktop_app_exit_requested', id: 17, payload: { stopServices: false, menuBarSupported: false } },
            once: false,
        },
    }]);
    await runCommand(registry, 'desktop_finish_shutdown', { outcome: 'menuBar' }, context);
    assert.equal(readQuitCalls(), 0);
    assert.deepEqual(shown, [1]);
    app.emit('before-quit', { preventDefault: () => {} });
    await runCommand(registry, 'desktop_finish_shutdown', {}, context);
    assert.equal(readQuitCalls(), 1);
});

test('an invalid shutdown outcome cannot authorize process exit', async () => {
    const { registry, context, app, readQuitCalls } = createHarness();
    app.emit('before-quit', { preventDefault: () => {} });
    await assert.rejects(runCommand(registry, 'desktop_finish_shutdown', { outcome: 'exit' }, context));
    assert.equal(readQuitCalls(), 0);
});

test('an unimplemented product command is reported as not-implemented, never as a value', async () => {
    const { registry, context } = createHarness();

    const outcome = await runCommand(registry, 'desktop_browser_open_view', {}, context);

    assert.equal(outcome.kind, 'not-implemented');
    assert.equal(outcome.kind === 'not-implemented' && outcome.known, true);
    assert.equal(
        outcome.kind === 'not-implemented' ? describeNotImplemented(outcome) : '',
        `${NOT_IMPLEMENTED_ERROR_PREFIX}: desktop_browser_open_view`,
    );
    assert.equal(isNotImplementedError(`${NOT_IMPLEMENTED_ERROR_PREFIX}: desktop_browser_open_view`), true);
});

test('finite machine tunnel command routes to the opaque raw listener contract', async () => {
    const { registry, context, irohStarts, irohStops } = createHarness();
    const request = {
        endpointId: 'a'.repeat(64),
        handshakeJson: JSON.stringify({ v: 1, flow: 'finite_transfer' }),
    };

    assert.deepEqual(await runCommand(registry, 'iroh_start_machine_tunnel', { request }, context), {
        kind: 'implemented',
        value: { leaseId: 'machine-raw-lease-1', localPort: 48122 },
    });
    assert.deepEqual(irohStarts, [request]);

    assert.deepEqual(await runCommand(registry, 'iroh_stop_machine_tunnel', { leaseId: 'machine-raw-lease-1' }, context), {
        kind: 'implemented',
        value: null,
    });
    assert.deepEqual(irohStops, ['machine-raw-lease-1']);
});

test('Personal Home desktop commands are implemented through the shared Electron host registry', async () => {
    const { registry, context, systemTaskCalls, desktopFileCalls } = createHarness();

    for (const [command, args] of [
        ['start_system_task', { specJson: '{"protocolVersion":1,"kind":"system.ping.v1","params":{}}' }],
        ['get_system_task_snapshot', { taskId: 'system_task_1' }],
        ['cancel_system_task', { taskId: 'system_task_1' }],
        ['respond_system_task_prompt', { taskId: 'system_task_1', answerJson: '{}' }],
        ['desktop_pick_personal_home_backup_archive', {}],
        ['desktop_save_personal_home_backup_archive', {}],
        ['system_tasks_open_log_path', { path: '/tmp/logs' }],
        ['system_tasks_reveal_output_path', { path: '/tmp/personal-home-backup.tar' }],
    ] as const) {
        const outcome = await runCommand(registry, command, args, context);
        assert.equal(outcome.kind, 'implemented', `${command} must not render an unusable Personal Home action`);
    }

    assert.deepEqual(systemTaskCalls, [
        ['start', '{"protocolVersion":1,"kind":"system.ping.v1","params":{}}'],
        ['snapshot', 'system_task_1'],
        ['cancel', 'system_task_1'],
        ['respond', 'system_task_1', '{}'],
    ]);
    assert.deepEqual(desktopFileCalls, [
        ['pick'],
        ['save'],
        ['open-log', '/tmp/logs'],
        ['reveal', '/tmp/personal-home-backup.tar'],
    ]);
});

test('a command the Tauri target does not register is flagged as unknown to it', async () => {
    const { registry, context } = createHarness();

    const outcome = await runCommand(registry, 'not_a_product_command', {}, context);

    assert.equal(outcome.kind === 'not-implemented' && outcome.known, false);
});

test('every implemented command is one the Tauri target registers', () => {
    const { registry } = createHarness();
    const productCommands = [...registry.keys()].filter((name) => !name.startsWith('plugin:'));

    for (const command of productCommands) {
        assert.ok(
            (TAURI_DESKTOP_COMMANDS as readonly string[]).includes(command),
            `${command} is implemented here but is not a command of the Tauri target`,
        );
    }
});

test('listen registers a host listener and emit delivers the full Tauri event object to it', async () => {
    const { registry, context, sender, eventBus } = createHarness();

    const listen = await runCommand(
        registry,
        'plugin:event|listen',
        { event: 'desktopWindow://state', target: { kind: 'Any' }, handler: 7 },
        context,
    );
    assert.deepEqual(listen, { kind: 'implemented', value: 7 });

    eventBus.emit('desktopWindow://state', { isMaximized: true });

    assert.deepEqual(sender.sent, [
        {
            channel: 'happier-desktop:callback',
            message: {
                callbackId: 7,
                payload: { event: 'desktopWindow://state', id: 7, payload: { isMaximized: true } },
                once: false,
            },
        },
    ]);
});

test('unlisten stops delivery for that listener only', async () => {
    const { registry, context, sender, eventBus } = createHarness();
    await runCommand(registry, 'plugin:event|listen', { event: 'e', handler: 1 }, context);
    await runCommand(registry, 'plugin:event|listen', { event: 'e', handler: 2 }, context);

    await runCommand(registry, 'plugin:event|unlisten', { event: 'e', eventId: 1 }, context);
    eventBus.emit('e', null);

    assert.equal(sender.sent.length, 1);
    assert.equal((sender.sent[0]?.message as { callbackId: number }).callbackId, 2);
});

test('macOS keeps native traffic lights while other platforms get custom controls', () => {
    assert.equal(resolveWindowChromeStrategy('darwin'), 'native-macos-traffic-lights');
    assert.equal(resolveWindowChromeStrategy('win32'), 'custom-controls');
    assert.equal(resolveWindowChromeStrategy('linux'), 'custom-controls');
});

test('the initial window state reports fullscreen alongside maximize state and handles an absent window', async () => {
    const { registry, context } = createHarness();
    // BrowserWindow is the native boundary; both getters represent the current OS state.
    const window = {
        isMaximized: () => false,
        isFullScreen: () => true,
    } as unknown as BrowserWindow;
    assert.deepEqual(await runCommand(registry, 'desktop_get_window_state', {}, { ...context, window }), {
        kind: 'implemented',
        value: { isMaximized: false, isFullscreen: true },
    });
    assert.deepEqual(await runCommand(registry, 'desktop_get_window_state', {}, context), {
        kind: 'implemented',
        value: { isMaximized: false, isFullscreen: false },
    });
});

test('login startup follows the shared service mode, never a second app preference', async () => {
    const { registry, context, readAutostartEnabled, loginItemWrites } = createHarness();
    assert.deepEqual(await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: 'at-login' } }, context), {
        kind: 'implemented', value: null,
    });
    assert.equal(readAutostartEnabled(), true);
    await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: null } }, context);
    await runCommand(registry, 'desktop_set_tray_state', { state: {} }, context);
    assert.equal(readAutostartEnabled(), true);
    await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: 'on-demand' } }, context);
    assert.equal(readAutostartEnabled(), false);
    assert.deepEqual(loginItemWrites, [{ openAtLogin: true }, { openAtLogin: false }]);
    for (const command of ['desktop_get_autostart_enabled', 'desktop_set_autostart_enabled']) {
        assert.deepEqual(await runCommand(registry, command, { enabled: true }, context), {
            kind: 'not-implemented', command, known: false,
        });
    }
});

test('development and unpackaged hosts never change the OS login item or report unsupported-platform notices', async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    for (const options of [{ development: true }, { isPackaged: false }, { development: true, platform: 'linux' as const }]) {
        const { registry, context, loginItemWrites, readAutostartEnabled } = createHarness(options);
        await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: 'at-login' } }, context);
        assert.deepEqual(loginItemWrites, []);
        assert.equal(readAutostartEnabled(), false);
    }
    assert.deepEqual(warnings, []);
});

test('Windows uses its existing normal launch rather than an unconsumed menu-bar argument', async () => {
    const { registry, context, loginItemWrites } = createHarness({ platform: 'win32' });
    await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: 'at-login' } }, context);
    assert.deepEqual(loginItemWrites, [{ openAtLogin: true }]);
});

test('repeated tray pushes write the OS login item once per successfully applied mode', async () => {
    const { registry, context, loginItemWrites, readAutostartEnabled } = createHarness();
    for (const serviceAutostart of ['at-login', 'at-login', null, 'at-login', 'on-demand', 'on-demand', null, 'on-demand', 'at-login']) {
        await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart } }, context);
    }
    assert.deepEqual(loginItemWrites, [{ openAtLogin: true }, { openAtLogin: false }, { openAtLogin: true }]);
    assert.equal(readAutostartEnabled(), true);
});

test('unsupported Linux login-item writes are a no-op with one named notice', async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const { registry, context, loginItemWrites } = createHarness({ platform: 'linux' });
    for (const serviceAutostart of ['at-login', 'at-login', 'on-demand', 'on-demand']) {
        assert.deepEqual(await runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart } }, context), {
            kind: 'implemented',
            value: null,
        });
    }
    assert.deepEqual(loginItemWrites, []);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /desktop_login_item_unsupported_platform: linux/);
});

test('a login-item write that does not take effect stays a failure and is not cached as applied', async () => {
    const { registry, context, readAutostartEnabled, loginItemWrites } = createHarness({ rejectLoginItemWrite: true });
    for (let push = 0; push < 2; push += 1) {
        await assert.rejects(
            runCommand(registry, 'desktop_set_tray_state', { state: { serviceAutostart: 'at-login' } }, context),
            /desktop_login_item_update_failed/,
        );
    }
    assert.deepEqual(loginItemWrites, [{ openAtLogin: true }, { openAtLogin: true }]);
    assert.equal(readAutostartEnabled(), false);
});

test('iroh commands share the exact Tauri names and route through the shared lifecycle service', async () => {
    const { registry, context, irohStarts, irohStops, irohStatusReads } = createHarness();

    const start = await runCommand(
        registry,
        'iroh_ensure_home_tunnel',
        { request: { homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' } },
        context,
    );
    assert.deepEqual(start, { kind: 'implemented', value: { leaseId: 'iroh-lease-1' } });
    assert.deepEqual(irohStarts, [{ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' }]);

    assert.deepEqual(await runCommand(registry, 'iroh_release_home_tunnel', { leaseId: 'iroh-lease-1' }, context), {
        kind: 'implemented',
        value: null,
    });
    assert.deepEqual(irohStops, ['iroh-lease-1']);

    assert.deepEqual(await runCommand(registry, 'iroh_get_tunnel_status', { leaseId: 'iroh-lease-1' }, context), {
        kind: 'implemented',
        value: { active: false, connectionActive: false, observedPath: 'relay' },
    });
    assert.deepEqual(irohStatusReads, ['iroh-lease-1']);
    assert.deepEqual(await runCommand(registry, 'iroh_get_availability', {}, context), {
        kind: 'implemented',
        value: { available: true },
    });

    await assert.rejects(
        runCommand(registry, 'iroh_ensure_home_tunnel', {}, context),
        /requires a request/u,
    );
    await assert.rejects(
        runCommand(registry, 'iroh_release_home_tunnel', {}, context),
        /requires a leaseId/u,
    );
    await assert.rejects(
        runCommand(registry, 'iroh_get_tunnel_status', {}, context),
        /requires a leaseId/u,
    );
});
