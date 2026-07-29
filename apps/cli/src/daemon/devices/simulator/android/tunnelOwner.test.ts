import { describe, expect, it, vi } from 'vitest';

import type {
    AndroidScrcpyServerHandle,
    AndroidScrcpyServerHandleResult,
} from './server';

function serverHandle(input: Readonly<{
    serial: string;
    stop: () => Promise<void>;
}>): AndroidScrcpyServerHandle {
    return {
        state: {
            serial: input.serial,
            artifact: {
                path: '/tmp/scrcpy-server.jar',
                version: '3.2',
                digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
            transportStatus: 'running',
        },
        rawVideoStream: (async function* () {})(),
        sendScrcpyControl: async () => ({ ok: true, diagnostics: [{ code: 'sent_via_owner' }] }),
        readState: () => ({
            serial: input.serial,
            artifact: {
                path: '/tmp/scrcpy-server.jar',
                version: '3.2',
                digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
            transportStatus: 'running',
        }),
        stop: async () => {
            await input.stop();
            return { status: 'stopped', diagnostics: [] };
        },
    };
}

describe('Android scrcpy tunnel owner', () => {
    it('starts one lifecycle-owned server with display metadata and exposes control only while that serial is active', async () => {
        const mod = await import('./tunnelOwner').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyTunnelOwner');
        if (!('createAndroidScrcpyTunnelOwner' in mod)) return;

        const stop = vi.fn(async () => {});
        const ensureServer = vi.fn(async (input: {
            serial: string;
            tunnel?: unknown;
            controlSocket?: { screenSize: { widthPx: number; heightPx: number } };
        }): Promise<AndroidScrcpyServerHandleResult> => ({
            ok: true,
            handle: serverHandle({ serial: input.serial, stop }),
        }));
        const owner = mod.createAndroidScrcpyTunnelOwner({
            allocateLocalPort: async () => 27183,
            resolveDisplaySize: async () => ({ ok: true, displaySize: { widthPx: 1080, heightPx: 1920 } }),
            ensureServer,
        });

        expect(owner.getControl({ serial: 'emulator-5554' })).toBeNull();

        const result = await owner.ensureServer({ serial: 'emulator-5554' });

        expect(result).toMatchObject({ ok: true });
        expect(ensureServer).toHaveBeenCalledWith({
            serial: 'emulator-5554',
            tunnel: { localPort: 27183 },
            controlSocket: {
                screenSize: { widthPx: 1080, heightPx: 1920 },
            },
        });
        expect(owner.getControl({ serial: 'emulator-5554' })).toMatchObject({
            displaySize: { widthPx: 1080, heightPx: 1920 },
            sendScrcpyControl: expect.any(Function),
        });
        expect(owner.getControl({ serial: 'emulator-5556' })).toBeNull();

        if (result.ok) await result.handle.stop();

        expect(stop).toHaveBeenCalledOnce();
        expect(owner.getControl({ serial: 'emulator-5554' })).toBeNull();
    });

    it('fails closed without advertising control when display-size metadata cannot be resolved', async () => {
        const mod = await import('./tunnelOwner').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyTunnelOwner');
        if (!('createAndroidScrcpyTunnelOwner' in mod)) return;

        const ensureServer = vi.fn();
        const owner = mod.createAndroidScrcpyTunnelOwner({
            allocateLocalPort: async () => 27183,
            resolveDisplaySize: async () => ({
                ok: false,
                reasonCode: 'android_simulator_display_size_unavailable',
                diagnostics: [{ code: 'android_simulator_display_size_query_failed' }],
            }),
            ensureServer,
        });

        await expect(owner.ensureServer({ serial: 'emulator-5554' })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics: [expect.objectContaining({
                code: 'android_simulator_display_size_query_failed',
            })],
        });
        expect(ensureServer).not.toHaveBeenCalled();
        expect(owner.getControl({ serial: 'emulator-5554' })).toBeNull();
    });

    it('restarts with new encoder params, tearing down the previous server and refreshing control atomically', async () => {
        const mod = await import('./tunnelOwner').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyTunnelOwner');
        if (!('createAndroidScrcpyTunnelOwner' in mod)) return;

        const stops: Array<ReturnType<typeof vi.fn>> = [];
        const encoders: Array<unknown> = [];
        const ensureServer = vi.fn(async (input: {
            serial: string;
            encoder?: unknown;
        }): Promise<AndroidScrcpyServerHandleResult> => {
            encoders.push(input.encoder ?? null);
            const stop = vi.fn(async () => {});
            stops.push(stop);
            return { ok: true, handle: serverHandle({ serial: input.serial, stop }) };
        });
        const owner = mod.createAndroidScrcpyTunnelOwner({
            allocateLocalPort: async () => 27183,
            resolveDisplaySize: async () => ({ ok: true, displaySize: { widthPx: 1080, heightPx: 1920 } }),
            ensureServer,
        });

        const first = await owner.ensureServer({
            serial: 'emulator-5554',
            encoder: { videoBitRateBps: 4_000_000 },
        });
        expect(first).toMatchObject({ ok: true });
        expect(encoders[0]).toMatchObject({ videoBitRateBps: 4_000_000 });
        expect(owner.getControl({ serial: 'emulator-5554' })).not.toBeNull();

        const restarted = await owner.restartServer({
            serial: 'emulator-5554',
            encoder: { videoBitRateBps: 2_000_000, maxFps: 30 },
        });
        expect(restarted).toMatchObject({ ok: true });
        // The previous server was stopped on restart.
        expect(stops[0]).toHaveBeenCalledTimes(1);
        // The new launch carried the new encoder params.
        expect(encoders[1]).toMatchObject({ videoBitRateBps: 2_000_000, maxFps: 30 });
        // ensureServer for the same serial now returns the NEW cached handle (no extra launch).
        const reEnsured = await owner.ensureServer({ serial: 'emulator-5554' });
        expect(ensureServer).toHaveBeenCalledTimes(2);
        if (restarted.ok && reEnsured.ok) {
            expect(reEnsured.handle).toBe(restarted.handle);
        }
        // Control is still advertised (refreshed) after the restart.
        expect(owner.getControl({ serial: 'emulator-5554' })).not.toBeNull();
    });

    it('coalesces concurrent starts for the same serial into one active lifecycle owner', async () => {
        const mod = await import('./tunnelOwner').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyTunnelOwner');
        if (!('createAndroidScrcpyTunnelOwner' in mod)) return;

        let releaseStart: () => void = () => {
            throw new Error('start gate resolver was not initialized');
        };
        const startGate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const stop = vi.fn(async () => {});
        const ensureServer = vi.fn(async (input: {
            serial: string;
        }): Promise<AndroidScrcpyServerHandleResult> => {
            await startGate;
            return {
                ok: true,
                handle: serverHandle({ serial: input.serial, stop }),
            };
        });
        const owner = mod.createAndroidScrcpyTunnelOwner({
            allocateLocalPort: async () => 27183,
            resolveDisplaySize: async () => ({ ok: true, displaySize: { widthPx: 1080, heightPx: 1920 } }),
            ensureServer,
        });

        const first = owner.ensureServer({ serial: 'emulator-5554' });
        const second = owner.ensureServer({ serial: 'emulator-5554' });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ensureServer).toHaveBeenCalledOnce();
        releaseStart();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toMatchObject({ ok: true });
        expect(secondResult).toMatchObject({ ok: true });
        if (!firstResult.ok || !secondResult.ok) return;
        expect(firstResult.handle).toBe(secondResult.handle);

        await firstResult.handle.stop();

        expect(stop).toHaveBeenCalledOnce();
        expect(owner.getControl({ serial: 'emulator-5554' })).toBeNull();
    });
});
