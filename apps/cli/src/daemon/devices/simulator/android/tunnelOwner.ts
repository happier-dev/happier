import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import {
    ensureAndroidScrcpyServer,
    type AndroidScrcpyServerEncoderParamsV1,
    type AndroidScrcpyServerHandle,
    type AndroidScrcpyServerHandleResult,
    type AndroidScrcpyServerProcessStarter,
    type AndroidScrcpyServerTunnelSocketConnector,
} from './server';
import {
    resolveAndroidSimulatorInputDisplaySize,
    type AndroidSimulatorInputDisplaySize,
    type AndroidSimulatorInputDisplaySizeResolution,
} from './input';
import type { AndroidScrcpyControlSender } from './control';
import type { AndroidAdbToolingResolution, AndroidToolRunner } from './tooling';
import type { AndroidScrcpyServerArtifactResolution } from './artifact';

export type AndroidScrcpyTunnelControl = Readonly<{
    sendScrcpyControl: AndroidScrcpyControlSender;
    displaySize: AndroidSimulatorInputDisplaySize;
}>;

export type AndroidScrcpyTunnelEnsureInput = Readonly<{
    serial: string;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
}>;

export type AndroidScrcpyTunnelRestartInput = Readonly<{
    serial: string;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
}>;

export type AndroidScrcpyTunnelOwner = Readonly<{
    ensureServer(input: AndroidScrcpyTunnelEnsureInput): Promise<AndroidScrcpyServerHandleResult>;
    /**
     * Tear down the cached server for `serial` and re-launch scrcpy with new encoder params,
     * atomically refreshing the cached handle + control sender so the input path (which reads the
     * control sender via `getControl`) stays in sync after an encoder reconfiguration restart.
     */
    restartServer(input: AndroidScrcpyTunnelRestartInput): Promise<AndroidScrcpyServerHandleResult>;
    getControl(input: Readonly<{ serial: string }>): AndroidScrcpyTunnelControl | null;
    stop(): Promise<void>;
}>;

export type AndroidScrcpyTunnelOwnerInput = Readonly<{
    allocateLocalPort?: () => Promise<number> | number;
    resolveDisplaySize?: (
        input: Readonly<{ serial: string }>,
    ) => Promise<AndroidSimulatorInputDisplaySizeResolution> | AndroidSimulatorInputDisplaySizeResolution;
    ensureServer?: typeof ensureAndroidScrcpyServer;
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution> | AndroidAdbToolingResolution;
    resolveScrcpyServerArtifact?: () => Promise<AndroidScrcpyServerArtifactResolution> | AndroidScrcpyServerArtifactResolution;
    runAdb?: AndroidToolRunner;
    startServer?: AndroidScrcpyServerProcessStarter;
    connectTcpSocket?: AndroidScrcpyServerTunnelSocketConnector;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

type ActiveTunnel = Readonly<{
    handle: AndroidScrcpyServerHandle;
    control: AndroidScrcpyTunnelControl;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
}>;

async function allocateEphemeralLoopbackPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    if (!address || typeof address === 'string') {
        throw new Error('android_scrcpy_tunnel_port_unavailable');
    }
    return (address as AddressInfo).port;
}

function failureFromDisplaySize(
    resolved: Exclude<AndroidSimulatorInputDisplaySizeResolution, { ok: true }>,
): AndroidScrcpyServerHandleResult {
    return {
        ok: false,
        reasonCode: 'android_emulator_bridge_unavailable',
        diagnostics: resolved.diagnostics.length > 0
            ? resolved.diagnostics
            : [{ code: resolved.reasonCode }],
    };
}

function wrapHandle(input: Readonly<{
    serial: string;
    handle: AndroidScrcpyServerHandle;
    control: AndroidScrcpyTunnelControl;
    encoder?: AndroidScrcpyServerEncoderParamsV1;
    activeBySerial: Map<string, ActiveTunnel>;
}>): AndroidScrcpyServerHandle {
    let wrapped: AndroidScrcpyServerHandle;
    wrapped = {
        ...input.handle,
        stop: async () => {
            try {
                return await input.handle.stop();
            } finally {
                const active = input.activeBySerial.get(input.serial);
                if (active?.handle === wrapped) {
                    input.activeBySerial.delete(input.serial);
                }
            }
        },
    };
    input.activeBySerial.set(input.serial, {
        handle: wrapped,
        control: input.control,
        ...(input.encoder ? { encoder: input.encoder } : {}),
    });
    return wrapped;
}

export function createAndroidScrcpyTunnelOwner(
    input: AndroidScrcpyTunnelOwnerInput = {},
): AndroidScrcpyTunnelOwner {
    const activeBySerial = new Map<string, ActiveTunnel>();
    const pendingBySerial = new Map<string, Promise<AndroidScrcpyServerHandleResult>>();
    const ensureServer = input.ensureServer ?? ensureAndroidScrcpyServer;
    const resolveAdbTooling = input.resolveAdbTooling;
    const resolveScrcpyServerArtifact = input.resolveScrcpyServerArtifact;

    const launchServer = async (
        serial: string,
        encoder: AndroidScrcpyServerEncoderParamsV1 | undefined,
    ): Promise<AndroidScrcpyServerHandleResult> => {
        const displaySize = await (
            input.resolveDisplaySize?.({ serial })
            ?? resolveAndroidSimulatorInputDisplaySize({
                serial,
                ...(resolveAdbTooling ? { resolveAdbTooling: async () => await resolveAdbTooling() } : {}),
                ...(input.runAdb ? { runAdb: input.runAdb } : {}),
                ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
            })
        );
        if (!displaySize.ok) {
            return failureFromDisplaySize(displaySize);
        }

        const localPort = await (input.allocateLocalPort?.() ?? allocateEphemeralLoopbackPort());
        const result = await ensureServer({
            serial,
            ...(resolveAdbTooling ? { resolveAdbTooling: async () => await resolveAdbTooling() } : {}),
            ...(resolveScrcpyServerArtifact ? { resolveScrcpyServerArtifact: async () => await resolveScrcpyServerArtifact() } : {}),
            ...(input.runAdb ? { runAdb: input.runAdb } : {}),
            ...(input.startServer ? { startServer: input.startServer } : {}),
            tunnel: {
                localPort,
                ...(input.connectTcpSocket ? { connectTcpSocket: input.connectTcpSocket } : {}),
            },
            controlSocket: {
                screenSize: displaySize.displaySize,
            },
            ...(encoder ? { encoder } : {}),
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!result.ok) return result;
        if (!result.handle.sendScrcpyControl) {
            await result.handle.stop();
            return {
                ok: false,
                reasonCode: 'android_emulator_bridge_unavailable',
                diagnostics: [{ code: 'scrcpy_control_socket_sender_unavailable' }],
            };
        }

        return {
            ok: true,
            handle: wrapHandle({
                serial,
                handle: result.handle,
                control: {
                    sendScrcpyControl: result.handle.sendScrcpyControl,
                    displaySize: displaySize.displaySize,
                },
                ...(encoder ? { encoder } : {}),
                activeBySerial,
            }),
        };
    };

    return {
        ensureServer: async ({ serial, encoder }) => {
            const active = activeBySerial.get(serial);
            if (active) {
                return { ok: true, handle: active.handle };
            }
            const pending = pendingBySerial.get(serial);
            if (pending) return await pending;

            const startPromise = launchServer(serial, encoder);
            pendingBySerial.set(serial, startPromise);
            try {
                return await startPromise;
            } finally {
                if (pendingBySerial.get(serial) === startPromise) {
                    pendingBySerial.delete(serial);
                }
            }
        },
        restartServer: async ({ serial, encoder }) => {
            // Serialize against an in-flight ensure/restart for this serial so the cached handle
            // is never half-swapped between the video and input readers.
            const pending = pendingBySerial.get(serial);
            if (pending) await pending.catch(() => undefined);

            const restartPromise = (async (): Promise<AndroidScrcpyServerHandleResult> => {
                const previous = activeBySerial.get(serial);
                if (previous) {
                    activeBySerial.delete(serial);
                    await previous.handle.stop().catch(() => undefined);
                }
                return await launchServer(serial, encoder);
            })();
            pendingBySerial.set(serial, restartPromise);
            try {
                return await restartPromise;
            } finally {
                if (pendingBySerial.get(serial) === restartPromise) {
                    pendingBySerial.delete(serial);
                }
            }
        },
        getControl: ({ serial }) => activeBySerial.get(serial)?.control ?? null,
        stop: async () => {
            const active = [...activeBySerial.values()];
            const pending = [...pendingBySerial.values()];
            activeBySerial.clear();
            pendingBySerial.clear();
            const pendingResults = await Promise.all(pending.map(async (pendingStart) => {
                return await pendingStart.catch(() => null);
            }));
            const handles = new Set<AndroidScrcpyServerHandle>(active.map((entry) => entry.handle));
            for (const result of pendingResults) {
                if (result?.ok) handles.add(result.handle);
            }
            await Promise.all([...handles].map(async (handle) => {
                await handle.stop().catch(() => undefined);
            }));
        },
    };
}
