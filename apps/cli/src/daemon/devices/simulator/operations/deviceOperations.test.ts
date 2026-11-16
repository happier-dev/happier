import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import type { SimulatorOperationRunner } from '../process';
import { createSimulatorDeviceOperations } from './deviceOperations';

const result = (stdout = '', exitCode = 0) => ({ stdout: Buffer.from(stdout), stderr: '', exitCode });

describe('simulator device operations', () => {
    it('lists shutdown iOS devices independently of capture availability and preserves runtime identity', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async () => result(JSON.stringify({ devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                { udid: 'off-id', name: 'Stopped phone', state: 'Shutdown', isAvailable: true },
                { udid: 'on-id', name: 'Running phone', state: 'Booted', isAvailable: true },
            ],
        } })));
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', run, resolveAdb: async () => ({ ok: false, reasonCode: 'adb_unavailable', diagnostics: [] }) });
        const devices = await operations.list();
        expect(devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: 'off-id', state: 'stopped', capture: expect.objectContaining({ status: 'unavailable' }) }),
            expect.objectContaining({ deviceId: 'on-id', runtimeId: 'on-id', state: 'running' }),
        ]));
    });

    it('merges dormant AVDs without duplicating the running AVD and returns booted serial', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async ({ args }) => {
            if (args[0] === 'devices') return result('List of devices attached\nemulator-5666 device model:Pixel_8\n');
            if (args[0] === '-list-avds') return result('Pixel_8\nPixel_9\n');
            if (args.includes('name')) return result(args.includes('emulator-5680') ? 'Pixel_9\nOK\n' : 'Pixel_8\nOK\n');
            return result();
        });
        const operations = createSimulatorDeviceOperations({ platform: 'linux', run, resolveAdb: async () => ({ ok: true, command: '/sdk/platform-tools/adb', source: 'android_sdk' }), resolveEmulator: async () => '/sdk/emulator/emulator', spawnEmulator: (_command, args) => {
            const port = Number(args[args.indexOf('-report-console') + 1]?.split(':')[1]);
            const socket = connect(port, '127.0.0.1', () => socket.end('5680'));
            return Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
        } });
        const devices = await operations.list();
        expect(devices).toHaveLength(2);
        expect(devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: 'emulator-5666', avdName: 'Pixel_8', state: 'running' }),
            expect.objectContaining({ deviceId: 'avd:Pixel_9', avdName: 'Pixel_9', state: 'stopped' }),
        ]));
        expect(await operations.execute({ platform: 'android', deviceId: 'avd:Pixel_9', operation: 'boot' })).toMatchObject({ ok: true, device: { deviceId: 'emulator-5680', runtimeId: 'emulator-5680', avdName: 'Pixel_9', state: 'running' } });
    });

    it('takes a real binary screenshot and preserves a native app failure cause', async () => {
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]);
        const run = vi.fn<SimulatorOperationRunner>(async ({ args }) => {
            if (args.includes('screenshot')) {
                await writeFile(args[args.length - 1]!, png);
                return result();
            }
            return { ...result('', 14), stderr: 'Application is not installed' };
        });
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', run });
        expect(await operations.execute({ platform: 'ios', deviceId: 'udid', operation: 'screenshot', sessionId: 'session' })).toEqual({ ok: true, png });
        expect(await operations.execute({ platform: 'ios', deviceId: 'udid', operation: 'app_launch', appId: 'com.example.app' })).toMatchObject({ ok: false, errorCode: 'simulator_tool_failed', step: 'app_launch', exitCode: 14, cause: 'Application is not installed' });
    });

    it('uses platform-backed commands and keeps deep-link content literal through the Android shell', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async () => result());
        const operations = createSimulatorDeviceOperations({ platform: 'linux', run, resolveAdb: async () => ({ ok: true, command: '/sdk/adb', source: 'path' }) });
        await operations.execute({ platform: 'android', deviceId: 'emulator-1', operation: 'open_url', url: "example://open?a=1&b='$(id)'" });
        expect(run.mock.calls[0]?.[0].args).toEqual(['-s', 'emulator-1', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'example://open?a=1&b='\"'\"'$(id)'\"'\"''"]);
        expect(await operations.execute({ platform: 'ios', deviceId: 'udid', operation: 'hardware', button: 'back' })).toMatchObject({ ok: false, errorCode: 'simulator_operation_unavailable' });
    });

    it('sends iOS push JSON on stdin and sets scoped app permissions', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async () => result());
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', run });
        const payload = { aps: { alert: 'Hello' } };
        expect(await operations.execute({ operation: 'push', platform: 'ios', deviceId: 'udid', appId: 'com.example', payload })).toEqual({ ok: true });
        expect(run.mock.calls[0]?.[0]).toMatchObject({ command: 'xcrun', args: ['simctl', 'push', 'udid', 'com.example', '-'], stdin: JSON.stringify(payload) });
        await operations.execute({ operation: 'permission_set', platform: 'ios', deviceId: 'udid', appId: 'com.example', permission: 'photos', value: 'reset' });
        expect(run.mock.calls[1]?.[0].args).toEqual(['simctl', 'privacy', 'udid', 'reset', 'photos', 'com.example']);
    });

    it('waits for iOS boot completion and keeps power-off separate from viewer lifecycle', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async () => result());
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', run });
        expect(await operations.execute({ operation: 'boot', platform: 'ios', deviceId: 'udid' })).toMatchObject({ ok: true, device: { deviceId: 'udid', runtimeId: 'udid', state: 'running' } });
        expect(run.mock.calls.map(([input]) => input.args)).toEqual([['simctl', 'boot', 'udid'], ['simctl', 'bootstatus', 'udid', '-b']]);
        await operations.execute({ operation: 'power_off', platform: 'ios', deviceId: 'udid' });
        expect(run.mock.calls.at(-1)?.[0].args).toEqual(['simctl', 'shutdown', 'udid']);
    });

    it('does not treat empty or text output as a successful image', async () => {
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', run: async ({ args }) => {
            await writeFile(args[args.length - 1]!, 'not an image');
            return result();
        } });
        expect(await operations.execute({ operation: 'screenshot', platform: 'ios', deviceId: 'udid', sessionId: 'session' })).toMatchObject({ ok: false, errorCode: 'simulator_screenshot_invalid', step: 'screenshot' });
    });

    it('resets only the requested Android permission to prompt rather than changing every app', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async () => result());
        const operations = createSimulatorDeviceOperations({ platform: 'linux', run, resolveAdb: async () => ({ ok: true, command: 'adb', source: 'path' }) });
        expect(await operations.execute({ operation: 'permission_set', platform: 'android', deviceId: 'emulator-1', appId: 'com.example', permission: 'android.permission.CAMERA', value: 'reset' })).toEqual({ ok: true });
        expect(run.mock.calls.map(([input]) => input.args)).toEqual([
            ['-s', 'emulator-1', 'shell', 'pm', 'revoke', 'com.example', 'android.permission.CAMERA'],
            ['-s', 'emulator-1', 'shell', 'pm', 'clear-permission-flags', 'com.example', 'android.permission.CAMERA', 'user-set', 'user-fixed'],
        ]);
    });

    it('returns a bootable AVD identity after Android power-off and retains native identity failures before killing', async () => {
        const run = vi.fn<SimulatorOperationRunner>(async ({ args }) => args.includes('name') ? result('Phone_AVD\nOK\n') : result());
        const operations = createSimulatorDeviceOperations({ platform: 'linux', run,
            resolveAdb: async () => ({ ok: true, command: 'adb', source: 'path' }) });
        expect(await operations.execute({ operation: 'power_off', platform: 'android', deviceId: 'emulator-5680' })).toMatchObject({
            ok: true, device: { deviceId: 'avd:Phone_AVD', avdName: 'Phone_AVD', state: 'stopped', supportedDeviceOperations: ['boot'] },
        });
        expect(run.mock.calls.map(([input]) => input.args)).toEqual([
            ['-s', 'emulator-5680', 'emu', 'avd', 'name'], ['-s', 'emulator-5680', 'emu', 'kill'],
        ]);
        run.mockClear();
        run.mockResolvedValue({ ...result('', 1), stderr: 'Emulator identity unavailable' });
        expect(await operations.execute({ operation: 'power_off', platform: 'android', deviceId: 'emulator-5680' })).toMatchObject({
            ok: false, errorCode: 'simulator_tool_failed', step: 'power_off.identity', exitCode: 1, cause: 'Emulator identity unavailable',
        });
        expect(run.mock.calls.map(([input]) => input.args)).toEqual([['-s', 'emulator-5680', 'emu', 'avd', 'name']]);
    });
});
