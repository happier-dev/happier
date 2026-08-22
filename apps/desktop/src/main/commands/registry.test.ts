import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNotImplementedError, NOT_IMPLEMENTED_ERROR_PREFIX } from '../../shared/bridge';
import { DesktopEventBus } from '../ipc/eventBus';
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

function createHarness() {
    const eventBus = new DesktopEventBus();
    const shown: number[] = [];
    let autostartEnabled = false;
    const registry = createCommandRegistry({
        eventBus,
        showMainWindow: () => {
            shown.push(1);
            return true;
        },
        setWindowMode: () => {},
        autostart: {
            isEnabled: () => autostartEnabled,
            setEnabled: (enabled) => {
                autostartEnabled = enabled;
                return autostartEnabled;
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
    return { eventBus, registry, sender, context, shown };
}

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

test('autostart reads back the value it was asked to set', async () => {
    const { registry, context } = createHarness();

    assert.deepEqual(await runCommand(registry, 'desktop_get_autostart_enabled', {}, context), {
        kind: 'implemented',
        value: false,
    });
    assert.deepEqual(await runCommand(registry, 'desktop_set_autostart_enabled', { enabled: true }, context), {
        kind: 'implemented',
        value: true,
    });
    assert.deepEqual(await runCommand(registry, 'desktop_get_autostart_enabled', {}, context), {
        kind: 'implemented',
        value: true,
    });
});
