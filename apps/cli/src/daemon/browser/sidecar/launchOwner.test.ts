import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

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
    it('fails closed without spawning when the launch plan is unavailable', async () => {
        const mod = await import('./launchOwner');

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const spawnProcess = vi.fn(() => createFakeProcess().process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_disabled',
            featureEnabled: false,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
            profile: {
                profileId: 'profile_launch_disabled',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'browser_session_default' },
                cleanupOnSessionClose: true,
            },
            profileDirectory: '/tmp/happier/browser/profile_launch_disabled',
            binaryResolution: {
                ok: true,
                source: 'managedBrowserPackage',
                executablePath: '/managed/chrome',
                discoveryKind: 'managedRuntime',
                diagnostics: [],
            },
            spawnProcess,
            cleanupProfileDirectory,
            nowMs: () => 7_500,
        });

        const result = await factory({ machineId: 'machine_launch_owner' });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'feature_disabled',
            disabledReason: 'browser.sidecar feature disabled',
        });
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(cleanupProfileDirectory).not.toHaveBeenCalled();
    });

    it('fails closed without spawning system Chrome candidates until a binary-safe system owner is proven', async () => {
        const mod = await import('./launchOwner');

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const spawnProcess = vi.fn(() => createFakeProcess().process);
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_system',
            featureEnabled: true,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
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

    it('launches the sidecar, discovers the private endpoint, connects CDP, and cleans up on dispose', async () => {
        const mod = await import('./launchOwner');

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
            featureEnabled: true,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
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
            endpointTimeoutMs: 100,
            nowMs: () => 8_000,
        });

        const resultPromise = Promise.resolve(factory({ machineId: 'machine_launch_owner' }));
        await waitForCondition(() => spawnProcess.mock.calls.length === 1);

        fake.emitStderr('DevTools listening on ws://127.0.0.1:9444/devtools/browser/private-token\n');
        const result = await resultPromise;

        expect(spawnProcess).toHaveBeenCalledWith('/managed/chrome', expect.arrayContaining([
            '--user-data-dir=/tmp/happier/browser/profile_launch_owner',
            '--remote-debugging-port=0',
        ]));
        expect(connectTransport).toHaveBeenCalledWith(expect.objectContaining({
            url: 'ws://127.0.0.1:9444/devtools/browser/private-token',
        }));
        expect(result).toMatchObject({
            ok: true,
            adapter: { adapterKind: 'chromiumSidecar' },
        });
        expect(JSON.stringify(result)).not.toContain('private-token');
        if (!result.ok) return;

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

        await result.dispose?.();
        expect(disposeTransport).toHaveBeenCalledOnce();
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_launch_owner');
    });

    it('stops the sidecar and cleans the profile when adapter disposal fails', async () => {
        const mod = await import('./launchOwner');

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
            featureEnabled: true,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
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
            endpointTimeoutMs: 100,
            nowMs: () => 8_250,
        });

        const resultPromise = Promise.resolve(factory({ machineId: 'machine_launch_owner' }));
        await waitForCondition(() => fake.process.stderr !== undefined);
        fake.emitStderr('DevTools listening on ws://127.0.0.1:9444/devtools/browser/private-token\n');
        const result = await resultPromise;

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        await expect(result.dispose?.()).rejects.toThrow('CDP dispose failed');
        expect(disposeTransport).toHaveBeenCalledOnce();
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanupProfileDirectory).toHaveBeenCalledWith('/tmp/happier/browser/profile_launch_owner_dispose_failure');
    });

    it('fails closed, stops the process, and does not leak stderr when the endpoint never appears', async () => {
        const mod = await import('./launchOwner');

        expect(mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarLaunchOwnerControlAdapterFactory) return;

        const fake = createFakeProcess();
        const cleanupProfileDirectory = vi.fn(async () => {});
        const factory = mod.createBrowserSidecarLaunchOwnerControlAdapterFactory({
            browserSessionId: 'browser_session_default',
            sidecarId: 'sidecar_launch_timeout',
            featureEnabled: true,
            browserUseAllowed: true,
            allowPersistentProfiles: false,
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
            endpointTimeoutMs: 1,
            nowMs: () => 8_500,
        });

        fake.emitStderr('DevTools listening on ws://198.51.100.10:9222/devtools/browser/secret-token\n');
        const result = await factory({ machineId: 'machine_launch_owner' });

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
