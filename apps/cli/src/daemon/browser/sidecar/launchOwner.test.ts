import { PassThrough } from 'node:stream';
import type { BrowserCommandV1 } from '@happier-dev/protocol';
import * as childProcess from 'node:child_process';
import { access, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';

import * as launchOwner from './launchOwner';

// Native spawn is an OS boundary; retain the actual controller beneath it.
vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
type StderrListener = (chunk: string | Uint8Array) => void;

function createFakeProcess() {
    const exitListeners: ExitListener[] = [];
    const errorListeners: ErrorListener[] = [];
    const stderrListeners: StderrListener[] = [];
    const kill = vi.fn(() => true);

    return {
        process: {
            pid: 84,
            stdio: [null, null, null, new PassThrough(), new PassThrough()],
            stderr: {
                on(event: 'data', listener: StderrListener) {
                    if (event === 'data') stderrListeners.push(listener);
                    return this;
                },
                off(event: 'data', listener: StderrListener) {
                    if (event !== 'data') return this;
                    const index = stderrListeners.indexOf(listener);
                    if (index >= 0) stderrListeners.splice(index, 1);
                    return this;
                },
            },
            once(event: 'exit' | 'error', listener: ExitListener | ErrorListener) {
                if (event === 'exit') exitListeners.push(listener as ExitListener);
                if (event === 'error') errorListeners.push(listener as ErrorListener);
                return this;
            },
            kill,
        },
        kill,
        emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
            for (const listener of exitListeners) listener(code, signal);
        },
        emitError(error: Error) {
            for (const listener of errorListeners) listener(error);
        },
        emitStderr(chunk: string | Uint8Array) {
            for (const listener of [...stderrListeners]) listener(chunk);
        },
    };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for test condition.');
}

function openViewCommand(): Extract<BrowserCommandV1, { kind: 'openView' }> {
    return {
        kind: 'openView',
        commandId: 'command_launch_owner_open',
        browserSessionId: 'browser_session_default',
        viewId: 'view_launch_owner',
        platform: 'web',
        focus: true,
        target: {
            kind: 'externalUrl',
            targetId: 'target_launch_owner',
            url: 'https://browser.example.test/launch-owner',
        },
    };
}

describe('browser sidecar launch owner', () => {
    it.each(['reply-then-exit', 'reply-then-close', 'reject'] as const)(
        'settles retained disposal from engine events: %s', async (mode) => {
            const fake = createFakeProcess();
            const writable = fake.process.stdio[3]!;
            const readable = fake.process.stdio[4]!;
            let closeSent!: () => void;
            const sent = new Promise<void>(resolve => { closeSent = resolve; });
            // OS pipe peer stands in for the engine; controller, adapter and CDP transport stay real.
            writable.on('data', chunk => {
                const request = JSON.parse(chunk.toString().replace(/\0$/, '')) as { id: number; method: string };
                if (request.method === 'Browser.close') closeSent();
                readable.write(JSON.stringify({ id: request.id,
                    ...(request.method === 'Browser.close' && mode === 'reject'
                        ? { error: { code: -32000, message: 'fixture_refused' } } : { result: {} }),
                }) + '\0');
            });
            fake.kill.mockImplementation(() => { queueMicrotask(() => fake.emitExit(0, 'SIGTERM')); return true; });
            const factory = launchOwner.createBrowserSidecarLaunchOwnerControlAdapterFactory({
                browserSessionId: 'browser_session_end', sidecarId: 'sidecar_end',
                profile: { profileId: 'profile_end', storageMode: 'user',
                    owner: { kind: 'user', id: 'end_fixture' }, cleanupOnSessionClose: false },
                profileDirectory: '/unused-retained-fixture',
                binaryResolution: { ok: true, source: 'managedBrowserPackage', executablePath: '/fixture/engine',
                    discoveryKind: 'managedRuntime', diagnostics: [] },
                spawnProcess: () => fake.process,
            });
            const result = await factory({ machineId: 'machine_end' });
            if (!result.ok) throw new Error('Pipe fixture unavailable');
            let disposed = false;
            const disposal = Promise.resolve(result.dispose?.()).then(() => { disposed = true; });
            await sent;
            await new Promise<void>(resolve => setImmediate(resolve));
            if (mode !== 'reject') {
                expect(disposed).toBe(false);
                expect(fake.kill).not.toHaveBeenCalled();
                if (mode === 'reply-then-exit') fake.emitExit(0);
                else readable.destroy();
            }
            await disposal;
            expect(fake.kill).toHaveBeenCalledTimes(mode === 'reply-then-exit' ? 0 : 1);
        },
    );

    // Explicit installed engine only, isolated temporary profiles, no acquisition or user data.
    // The OS spawn boundary adds no-sandbox solely for workers without a usable sandbox.
    it.skipIf(!process.env.HAPPIER_BROWSER_TEST_EXECUTABLE).each([
        'retained', 'ephemeral', 'already-exited', 'transport-closed',
    ] as const)('disposes a real engine through the owner: %s', async (mode) => {
        const executable = process.env.HAPPIER_BROWSER_TEST_EXECUTABLE!;
        const directory = await mkdtemp(join(tmpdir(), 'browser-owner-end-'));
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const children: childProcess.ChildProcess[] = [];
        const exits: Promise<void>[] = [];
        const launch = async () => {
            const factory = launchOwner.createBrowserSidecarLaunchOwnerControlAdapterFactory({
                browserSessionId: 'browser_session_end', sidecarId: 'sidecar_end',
                profile: { profileId: 'profile_end', storageMode: mode === 'ephemeral' ? 'ephemeral' : 'user',
                    owner: { kind: 'user', id: 'end_fixture' }, cleanupOnSessionClose: mode === 'ephemeral' },
                profileDirectory: directory,
                binaryResolution: { ok: true, source: 'managedBrowserPackage', executablePath: executable,
                    discoveryKind: 'managedRuntime', diagnostics: [] },
                spawnProcess: (file, args) => {
                    const child = actual.spawn(file, [...args, '--no-sandbox'], {
                        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
                    });
                    children.push(child);
                    exits.push(new Promise(resolve => child.once('exit', () => resolve())));
                    console.info(JSON.stringify({ event: 'engine_started', mode, pid: child.pid }));
                    return child;
                },
            });
            const result = await factory({ machineId: 'machine_end' });
            if (!result.ok || !result.contextCapture || !result.dispose) throw new Error('Engine fixture unavailable');
            const transport = result.contextCapture.transport;
            const dispatchBrowserCommand = transport.dispatchBrowserCommand;
            if (!dispatchBrowserCommand) throw new Error('Engine command transport unavailable');
            return { dispose: result.dispose, transport, dispatchBrowserCommand };
        };
        try {
            const { dispose, transport, dispatchBrowserCommand } = await launch();
            await dispatchBrowserCommand({ method: 'Storage.setCookies', params: { cookies: [{
                name: 'owner_end', value: 'synthetic-state', domain: 'end.example.test', path: '/',
                expires: Math.floor(Date.now() / 1000) + 3600,
            }] } });
            if (mode === 'already-exited') {
                await dispatchBrowserCommand({ method: 'Browser.close' });
                await exits[0];
            }
            if (mode === 'transport-closed') {
                children[0].stdio[3]?.destroy();
                children[0].stdio[4]?.destroy();
                await transport.closed;
            }
            await dispose();
            expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
            if (mode === 'ephemeral') {
                await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
            } else if (mode === 'retained') {
                const lockLeft = await lstat(join(directory, 'SingletonLock')).then(() => true, () => false);
                expect(lockLeft).toBe(false);
                const reopened = await launch();
                try {
                    const stored = await reopened.dispatchBrowserCommand({ method: 'Storage.getCookies' }) as { cookies: { name: string; value: string }[] };
                    expect(stored.cookies.some(cookie => cookie.name === 'owner_end' && cookie.value === 'synthetic-state')).toBe(true);
                } finally {
                    await reopened.dispose();
                }
            } else {
                await expect(access(directory)).resolves.toBeUndefined();
            }
        } finally {
            for (const child of children) {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            }
            await Promise.all(exits);
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== 'linux')('inherits CDP descriptors through the default Linux spawn and a systemd-run exec fixture', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-browser-inherited-pipe-'));
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const spawn = vi.mocked(childProcess.spawn).mockImplementation(actual.spawn);
        let dispose: (() => void | Promise<void>) | undefined;
        try {
            vi.stubEnv('PATH', directory);
            vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test/browser-pipe-bus');
            await writeFile(join(directory, 'systemctl'), '#!/bin/sh\nprintf "LoadState=loaded\\nCPUWeight=50\\nIOWeight=50\\nMemoryHigh=1073741824\\n"\n', { mode: 0o700 });
            // This exec fixture preserves real inherited descriptors; it does not run systemd or create a cgroup.
            await writeFile(join(directory, 'systemd-run'), '#!/bin/sh\nif [ "$1" = "--help" ]; then printf -- "--expand-environment=\\n"; exit; fi\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
            const executablePath = join(directory, 'cdp-child.cjs');
            await writeFile(executablePath, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('--remote-debugging-pipe') || process.argv.some(arg => arg.startsWith('--remote-debugging-port'))) process.exit(1);
const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
let pending = '';
input.on('data', chunk => {
    pending += chunk.toString('utf8');
    for (;;) {
        const end = pending.indexOf('\\0');
        if (end < 0) return;
        const command = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        const result = command.method === 'Browser.getVersion' ? { product: 'InheritedPipeFixture' }
            : command.method === 'Target.createTarget' ? { targetId: 'child-target' }
            : command.method === 'Target.attachToTarget' ? { sessionId: 'child-session' } : {};
        output.write(JSON.stringify({ id: command.id, result }) + '\\0');
    }
});
input.on('end', () => output.end());
`, { mode: 0o700 });
            const factory = launchOwner.createBrowserSidecarLaunchOwnerControlAdapterFactory({
                browserSessionId: 'browser_session_default', sidecarId: 'sidecar_inherited_pipe',
                profile: { profileId: 'profile_inherited_pipe', storageMode: 'ephemeral',
                    owner: { kind: 'session', id: 'browser_session_default' }, cleanupOnSessionClose: true },
                profileDirectory: directory,
                binaryResolution: { ok: true, source: 'managedBrowserPackage', executablePath,
                    discoveryKind: 'managedRuntime', diagnostics: [] },
                cleanupProfileDirectory: async () => {},
                deadlineMs: Date.now() + 10_000,
            });
            const result = await factory({ machineId: 'machine_inherited_pipe' });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) return;
            dispose = result.dispose;
            expect(spawn.mock.calls[0]?.[0]).toBe(join(directory, 'systemd-run'));
            await expect(result.adapter.dispatchCommand(openViewCommand())).resolves.toMatchObject({ status: 'dispatched' });
            expect(result.contextCapture?.resolvePageHandle(openViewCommand()))
                .toEqual({ targetId: 'child-target', sessionId: 'child-session' });
            await dispose?.();
            dispose = undefined;
            const child = spawn.mock.results[0]?.value;
            expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
            expect(child?.stdio[3]?.destroyed).toBe(true);
            expect(child?.stdio[4]?.destroyed).toBe(true);
        } finally {
            await dispose?.();
            const child = spawn.mock.results[0]?.value;
            if (child && child.exitCode === null && child.signalCode === null) {
                const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
                child.kill('SIGTERM');
                await exited;
            }
            spawn.mockReset();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('launches its Linux singleton through the canonical owned scope', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-browser-scope-fixture-'));
        const platform = process.platform;
        const fake = createFakeProcess();
        // ChildProcess is a genuine OS boundary; controller and scope composition stay real.
        const spawn = vi.mocked(childProcess.spawn).mockReturnValue(fake.process as unknown as childProcess.ChildProcess);
        try {
            Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
            vi.stubEnv('PATH', directory);
            vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test/browser-bus');
            await writeFile(join(directory, 'systemctl'), '#!/bin/sh\nprintf "LoadState=loaded\\nCPUWeight=50\\nIOWeight=50\\nMemoryHigh=1073741824\\n"\n', { mode: 0o700 });
            await writeFile(join(directory, 'systemd-run'), '#!/bin/sh\nprintf -- "--expand-environment=\\n"\n', { mode: 0o700 });
            const factory = launchOwner.createBrowserSidecarLaunchOwnerControlAdapterFactory({
                browserSessionId: 'browser_session_scope', sidecarId: 'sidecar_scope',
                profile: { profileId: 'profile_scope', storageMode: 'ephemeral',
                    owner: { kind: 'session', id: 'browser_session_scope' }, cleanupOnSessionClose: true },
                profileDirectory: directory,
                binaryResolution: { ok: true, source: 'managedBrowserPackage', executablePath: '/managed/chrome',
                    discoveryKind: 'managedRuntime', diagnostics: [] },
                cleanupProfileDirectory: async () => {},
            });
            const result = factory({ machineId: 'machine_scope' });
            await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
            expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
            const unit = spawn.mock.calls[0]?.[1]?.find(argument => argument.startsWith('--unit='))?.slice('--unit='.length);
            fake.emitExit(1);
            await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'cdp_unavailable' });
            expect(parseHappierLinuxScopeName(unit ?? '')?.owner).toEqual({ kind: 'browser_sidecar' });
        } finally {
            spawn.mockReset();
            vi.unstubAllEnvs();
            Object.defineProperty(process, 'platform', { configurable: true, value: platform });
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('fails closed without spawning when the launch plan is unavailable', async () => {
        const mod = launchOwner;

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const spawnProcess = vi.fn(() => createFakeProcess().process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_disabled',
            profile: {
                profileId: 'profile_launch_disabled',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_disabled',
            binaryResolution: {
                ok: false,
                source: 'managedBrowserPackage',
                errorCode: 'managed_package_missing',
                disabledReason: 'Managed browser is missing.',
                diagnostics: [],
            },
            spawnProcess,
            cleanupProfileDirectory,
            nowMs: () => 7_500,
        });

        const result = await factory({ machineId: 'machine_launch_owner' });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'managed_package_missing',
            disabledReason: 'Managed browser is missing.',
        });
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(cleanupProfileDirectory).not.toHaveBeenCalled();
    });

    it('fails closed without spawning system Chrome candidates until a binary-safe system owner is proven', async () => {
        const mod = launchOwner;

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const spawnProcess = vi.fn(() => createFakeProcess().process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_system',
            profile: {
                profileId: 'profile_launch_system',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_system',
            binaryResolution: {
                ok: true,
                source: 'systemChrome',
                executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                discoveryKind: 'systemRegistry',
                diagnostics: [],
            },
            spawnProcess,
            cleanupProfileDirectory,
            nowMs: () => 7_750,
        });

        const result = await factory({ machineId: 'machine_launch_owner' });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'system_browser_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('Google Chrome');
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(cleanupProfileDirectory).not.toHaveBeenCalled();
    });

    it('launches the sidecar over inherited descriptors, connects CDP, and cleans up on dispose', async () => {
        const mod = launchOwner;

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const fake = createFakeProcess();
        const spawnProcess = vi.fn(() => fake.process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const disposeTransport = vi.fn();
        const transport = {
            openPage: vi.fn(async () => ({
                targetId: 'target_private',
                sessionId: 'session_private',
            })),
            dispatchPageCommand: vi.fn(async () => ({})),
            dispatchBrowserCommand: vi.fn(async () => ({})),
        };
        const connectTransport = vi.fn(async () => ({ transport, dispose: disposeTransport }));
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_owner',
            profile: {
                profileId: 'profile_launch_owner',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_owner',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
            spawnProcess,
            connectTransport,
            cleanupProfileDirectory,
            deadlineMs: Date.now() + 100,
            nowMs: () => 8_000,
        });

        const resultPromise = Promise.resolve(factory({ machineId: 'machine_launch_owner' }));
        await waitForCondition(() => spawnProcess.mock.calls.length === 1);

        const result = await resultPromise;

        expect(spawnProcess).toHaveBeenCalledWith('/managed/chrome', expect.arrayContaining([
            '--headless=new',
            '--user-data-dir=/tmp/happier/browser/profile_launch_owner',
            '--remote-debugging-pipe',
        ]));
        expect(connectTransport).toHaveBeenCalledWith({ writable: fake.process.stdio[3], readable: fake.process.stdio[4] }, expect.any(Object));
        expect(result).toMatchObject({
            ok: true,
            adapter: { adapterKind: 'chromiumSidecar' },
        });
        expect(JSON.stringify(result)).not.toContain('private-token');
        if (!result.ok) return;
        expect(result.contextCapture?.resolveNativeObservation?.(openViewCommand())).toBeUndefined();

        await expect(result.adapter.dispatchCommand(openViewCommand())).resolves.toMatchObject({
            v: 1,
            commandId: 'command_launch_owner_open',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(transport.openPage).toHaveBeenCalledWith({
            url: 'https://browser.example.test/launch-owner',
            focus: true,
        });
        expect(result.contextCapture?.resolvePageHandle(openViewCommand())).toEqual({
            targetId: 'target_private', sessionId: 'session_private',
        });
        expect(result.contextCapture?.resolveNativeObservation?.(openViewCommand())).toBe('not_observable');
        expect(result.contextCapture?.resolveNativeObservation?.({ ...openViewCommand(), viewId: 'unowned' })).toBeUndefined();

        const disposal = result.dispose?.();
        await waitForCondition(() => fake.kill.mock.calls.length === 1);
        expect(cleanupProfileDirectory).not.toHaveBeenCalled();
        fake.emitExit(0, 'SIGTERM');
        await disposal;
        expect(disposeTransport).toHaveBeenCalledOnce();
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_launch_owner');
        expect(result.contextCapture?.resolveNativeObservation?.(openViewCommand())).toBeUndefined();
    });

    it('stops the sidecar and cleans the profile when adapter disposal fails', async () => {
        const mod = launchOwner;

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const fake = createFakeProcess();
        const cleanupProfileDirectory = vi.fn(async () => {});
        const disposeTransport = vi.fn(async () => {
            throw new Error('CDP dispose failed for ws://127.0.0.1:9444/devtools/browser/private-token');
        });
        const transport = {
            openPage: vi.fn(async () => ({
                targetId: 'target_private',
                sessionId: 'session_private',
            })),
            dispatchPageCommand: vi.fn(async () => ({})),
            dispatchBrowserCommand: vi.fn(async () => ({})),
        };
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_owner_dispose_failure',
            profile: {
                profileId: 'profile_launch_owner_dispose_failure',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_owner_dispose_failure',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
            spawnProcess: () => fake.process,
            connectTransport: vi.fn(async () => ({ transport, dispose: disposeTransport })),
            cleanupProfileDirectory,
            deadlineMs: Date.now() + 100,
            nowMs: () => 8_250,
        });

        const resultPromise = Promise.resolve(factory({ machineId: 'machine_launch_owner' }));
        await waitForCondition(() => fake.process.stderr !== undefined);
        const result = await resultPromise;

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        const disposal = result.dispose?.();
        const assertion = expect(disposal).rejects.toThrow('CDP dispose failed');
        await waitForCondition(() => fake.kill.mock.calls.length === 1);
        fake.emitExit(0, 'SIGTERM');
        await assertion;
        expect(disposeTransport).toHaveBeenCalledOnce();
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_launch_owner_dispose_failure');
    });

    it('fails closed, stops the process, and does not leak stderr when CDP never replies', async () => {
        const mod = launchOwner;

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const fake = createFakeProcess();
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_timeout',
            profile: {
                profileId: 'profile_launch_timeout',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_timeout',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
            spawnProcess: () => fake.process,
            cleanupProfileDirectory,
            deadlineMs: Date.now() + 1,
            nowMs: () => 8_500,
        });

        fake.emitStderr('DevTools listening on ws://198.51.100.10:9222/devtools/browser/secret-token\n');
        const resultPromise = Promise.resolve(factory({ machineId: 'machine_launch_owner' }));
        await waitForCondition(() => fake.kill.mock.calls.length === 1);
        expect(cleanupProfileDirectory).not.toHaveBeenCalled();
        fake.emitExit(0, 'SIGTERM');
        const result = await resultPromise;

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'cdp_unavailable',
        });
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_launch_timeout');
        expect(JSON.stringify(result)).not.toContain('ws://');
        expect(JSON.stringify(result)).not.toContain('secret-token');
    });
});
