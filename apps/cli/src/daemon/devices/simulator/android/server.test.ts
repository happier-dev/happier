import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import type { AndroidScrcpyControlSender } from './control';
import {
    createDefaultAndroidScrcpyServerTunnelSocketConnector,
    createDefaultAndroidScrcpyServerProcessStarter,
    ensureAndroidScrcpyServer,
    type AndroidScrcpyServerAdbRunner,
    type AndroidScrcpyServerProcessStarter,
} from './server';

const trustedArtifact = {
    path: '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
    version: '3.2',
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

const adb = {
    command: '/android/platform-tools/adb',
    source: 'android_sdk',
    version: '1.0.41',
} as const;

function devicesOutput(state = 'device'): string {
    return [
        'List of devices attached',
        `emulator-5554 ${state} product:sdk model:Pixel_9 device:emu64 transport_id:1`,
    ].join('\n');
}

function createSuccessfulRunner(): AndroidScrcpyServerAdbRunner {
    return async (input) => {
        if (input.args.join('\0') === 'devices\0-l') {
            return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };
}

function rawSocket(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
        },
    };
}

class FakeControlSocket extends EventEmitter {
    readonly writtenPackets: Uint8Array[] = [];
    readonly setNoDelay = vi.fn();
    destroyed = false;
    writableEnded = false;
    closed = false;

    write(packet: Uint8Array): boolean {
        this.writtenPackets.push(packet.slice());
        return true;
    }

    end(): void {
        this.writableEnded = true;
        this.closed = true;
        this.emit('close');
    }

    destroy(): void {
        this.destroyed = true;
        this.closed = true;
        this.emit('close');
    }
}

describe('ensureAndroidScrcpyServer', () => {
    it('treats immediate forwarded socket close as unavailable instead of a live tunnel socket', async () => {
        const server = createServer((socket) => {
            socket.destroy();
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        try {
            expect(address).toBeTruthy();
            if (!address || typeof address === 'string') return;

            const connect = createDefaultAndroidScrcpyServerTunnelSocketConnector({
                connectTimeoutMs: 500,
            });
            await expect(connect({
                host: '127.0.0.1',
                port: address.port,
                purpose: 'video',
            })).resolves.toMatchObject({
                ok: false,
                reasonCode: 'scrcpy_tunnel_socket_closed',
                diagnostics: [expect.objectContaining({
                    code: 'scrcpy_tunnel_socket_closed',
                    purpose: 'video',
                })],
            });
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    });

    it('cancels the stability probe instead of returning a live tunnel socket after abort', async () => {
        const controller = new AbortController();
        const acceptedSockets: Socket[] = [];
        const server = createServer((socket) => {
            acceptedSockets.push(socket);
            controller.abort();
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        try {
            expect(address).toBeTruthy();
            if (!address || typeof address === 'string') return;

            const connect = createDefaultAndroidScrcpyServerTunnelSocketConnector({
                connectTimeoutMs: 500,
                stabilityProbeMs: 100,
            });
            await expect(connect({
                host: '127.0.0.1',
                port: address.port,
                purpose: 'video',
                signal: controller.signal,
            })).resolves.toMatchObject({
                ok: false,
                reasonCode: 'scrcpy_tunnel_socket_unavailable',
                diagnostics: [expect.objectContaining({
                    code: 'scrcpy_tunnel_socket_connect_aborted',
                    purpose: 'video',
                })],
            });
        } finally {
            for (const socket of acceptedSockets) socket.destroy();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    });

    it('exposes raw stdout from the default process starter without draining video bytes', async () => {
        const starter = createDefaultAndroidScrcpyServerProcessStarter({ startupProbeMs: 50 });
        const started = await starter({
            command: process.execPath,
            args: ['-e', 'process.stdout.write(Buffer.from([0, 0, 1, 0x67])); setTimeout(() => {}, 5000);'],
        });

        expect(started).toMatchObject({
            ok: true,
            process: {
                rawVideoStream: expect.any(Object),
            },
        });
        if (!started.ok || !started.process?.rawVideoStream) return;

        const iterator = started.process.rawVideoStream[Symbol.asyncIterator]();
        const next = await iterator.next();
        expect([...next.value]).toEqual([0, 0, 1, 0x67]);
        await iterator.return?.();
        await started.process.stop?.();
    });

    it('verifies the pinned scrcpy-server artifact before mutating the device', async () => {
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async () => ({
            exitCode: 0,
            stdout: '',
            stderr: '',
        }));
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>();

        await expect(ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({
                ok: false,
                reasonCode: 'scrcpy_server_digest_mismatch',
                diagnostics: [{ code: 'digest_mismatch' }],
            }),
            runAdb,
            startServer,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_digest_mismatch',
            diagnostics: [expect.objectContaining({ code: 'digest_mismatch' })],
        });

        expect(runAdb).not.toHaveBeenCalled();
        expect(startServer).not.toHaveBeenCalled();
    });

    it('keeps non-emulator serials disabled before adb or artifact work', async () => {
        const resolveAdbTooling = vi.fn(async () => ({ ok: true as const, ...adb }));
        const resolveScrcpyServerArtifact = vi.fn(async () => ({ ok: true as const, ...trustedArtifact, source: 'dev_fixture' as const }));

        await expect(ensureAndroidScrcpyServer({
            serial: 'R58M1234567',
            resolveAdbTooling,
            resolveScrcpyServerArtifact,
            runAdb: createSuccessfulRunner(),
            startServer: async () => ({ ok: true, process: { stop: async () => {} } }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'physical_device_not_supported_v1',
            diagnostics: [expect.objectContaining({
                code: 'physical_device_not_supported_v1',
                serial: 'R58M1234567',
            })],
        });

        expect(resolveAdbTooling).not.toHaveBeenCalled();
        expect(resolveScrcpyServerArtifact).not.toHaveBeenCalled();
    });

    it('pushes the verified artifact to a version and digest scoped path and starts app_process without shell strings', async () => {
        const events: string[] = [];
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            events.push(`adb:${input.args.join(' ')}`);
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async (input) => {
            events.push(`start:${input.args.join(' ')}`);
            return { ok: true, process: { stop: async () => {} } };
        });

        const result = await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => {
                events.push('artifact');
                return { ok: true, ...trustedArtifact, source: 'dev_fixture' };
            },
            runAdb,
            startServer,
        });

        expect(result).toMatchObject({
            ok: true,
            handle: {
                state: {
                    serial: 'emulator-5554',
                    artifact: {
                        path: trustedArtifact.path,
                        version: '3.2',
                        digest: trustedArtifact.digest,
                    },
                    remotePath: '/data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
                    transportStatus: 'running',
                },
            },
        });
        expect(events[0]).toBe('artifact');
        expect(runAdb).toHaveBeenCalledWith(expect.objectContaining({
            command: adb.command,
            args: ['devices', '-l'],
        }));
        expect(runAdb).toHaveBeenCalledWith(expect.objectContaining({
            command: adb.command,
            args: [
                '-s',
                'emulator-5554',
                'shell',
                'mkdir',
                '-p',
                '/data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ],
        }));
        expect(runAdb).toHaveBeenCalledWith(expect.objectContaining({
            command: adb.command,
            args: [
                '-s',
                'emulator-5554',
                'push',
                trustedArtifact.path,
                '/data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
            ],
        }));
        expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
            command: adb.command,
            args: [
                '-s',
                'emulator-5554',
                'shell',
                'CLASSPATH=/data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
                'app_process',
                '/',
                'com.genymobile.scrcpy.Server',
                '3.2',
                'log_level=info',
                'audio=false',
                'control=false',
                'cleanup=false',
                'raw_stream=true',
            ],
        }));
        for (const call of [...runAdb.mock.calls, ...startServer.mock.calls]) {
            expect(Array.isArray(call[0].args)).toBe(true);
            expect(call[0].args).not.toContain('shell CLASSPATH');
        }
    });

    it('appends encoder launch args (video_bit_rate / max_fps / max_size / audio) when an encoder profile is supplied', async () => {
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: async () => {} },
        }));

        const result = await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
            encoder: {
                videoBitRateBps: 4_000_000,
                maxFps: 30,
                maxSize: 1280,
                audio: true,
            },
        });

        expect(result).toMatchObject({ ok: true });
        const startArgs = startServer.mock.calls[0]?.[0].args ?? [];
        expect(startArgs).toContain('video_bit_rate=4000000');
        expect(startArgs).toContain('max_fps=30');
        expect(startArgs).toContain('max_size=1280');
        expect(startArgs).toContain('audio=true');
        expect(startArgs).toContain('raw_stream=true');
    });

    it('omits encoder args and keeps audio disabled when no encoder profile is supplied', async () => {
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: async () => {} },
        }));

        await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
        });

        const startArgs = startServer.mock.calls[0]?.[0].args ?? [];
        expect(startArgs).toContain('audio=false');
        expect(startArgs.some((arg) => arg.startsWith('video_bit_rate='))).toBe(false);
        expect(startArgs.some((arg) => arg.startsWith('max_fps='))).toBe(false);
        expect(startArgs.some((arg) => arg.startsWith('max_size='))).toBe(false);
    });

    it('owns a stock scrcpy adb-forward tunnel for video and control sockets in the server lifecycle', async () => {
        const events: string[] = [];
        const videoSocket = Object.assign(rawSocket([]), {
            closed: false,
            end() {
                this.closed = true;
            },
        });
        const controlSocket = new FakeControlSocket();
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            events.push(`adb:${input.args.join(' ')}`);
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async (input) => {
            events.push(`start:${input.args.join(' ')}`);
            return { ok: true, process: { stop: vi.fn(async () => {}) } };
        });
        const connectTcpSocket = vi.fn(async (input: { purpose: 'video' | 'control' }) => ({
            ok: true as const,
            socket: input.purpose === 'video' ? videoSocket : controlSocket,
            diagnostics: [{ code: `connected_${input.purpose}` }],
        }));

        const result = await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
            tunnel: {
                localPort: 27183,
                connectTcpSocket,
            },
            controlSocket: {
                screenSize: { widthPx: 1080, heightPx: 1920 },
            },
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        expect(events).toEqual(expect.arrayContaining([
            'adb:-s emulator-5554 forward tcp:27183 localabstract:scrcpy',
            expect.stringContaining('start:-s emulator-5554 shell CLASSPATH='),
        ]));
        expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
            args: expect.arrayContaining([
                'tunnel_forward=true',
                'audio=false',
                'control=true',
                'cleanup=false',
                'raw_stream=true',
            ]),
        }));
        expect(connectTcpSocket.mock.calls.map((call) => call[0])).toEqual([
            { host: '127.0.0.1', port: 27183, purpose: 'video' },
            { host: '127.0.0.1', port: 27183, purpose: 'control' },
        ]);
        expect(result.handle.rawVideoStream).toBe(videoSocket);
        expect(result.handle.sendScrcpyControl).toBeTypeOf('function');

        await expect(result.handle.sendScrcpyControl?.({
            v: 1,
            streamId: 'stream-1',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event-1',
            kind: 'pinch',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 0.2,
            endDistance: 0.5,
        })).resolves.toMatchObject({ ok: true });
        expect(controlSocket.writtenPackets).toHaveLength(6);

        await result.handle.stop();
        expect(videoSocket.closed).toBe(true);
        expect(controlSocket.closed).toBe(true);
        expect(runAdb).toHaveBeenCalledWith(expect.objectContaining({
            args: ['-s', 'emulator-5554', 'forward', '--remove', 'tcp:27183'],
        }));
    });

    it('retries transient forwarded socket closes while the scrcpy localabstract server is starting', async () => {
        const videoSocket = Object.assign(rawSocket([]), {
            closed: false,
            end() {
                this.closed = true;
            },
        });
        const controlSocket = new FakeControlSocket();
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: vi.fn(async () => {}) },
        }));
        const videoAttempts: string[] = [];
        const connectTcpSocket = vi.fn(async (input: { purpose: 'video' | 'control' }) => {
            if (input.purpose === 'video') {
                videoAttempts.push(input.purpose);
                if (videoAttempts.length === 1) {
                    return {
                        ok: false as const,
                        reasonCode: 'scrcpy_tunnel_socket_closed',
                        diagnostics: [{ code: 'scrcpy_tunnel_socket_closed', purpose: input.purpose }],
                    };
                }
            }
            return {
                ok: true as const,
                socket: input.purpose === 'video' ? videoSocket : controlSocket,
                diagnostics: [{ code: `connected_${input.purpose}` }],
            };
        });

        const result = await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
            tunnel: {
                localPort: 27183,
                connectTcpSocket,
            },
            controlSocket: {
                screenSize: { widthPx: 1080, heightPx: 1920 },
            },
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        expect(connectTcpSocket.mock.calls.map((call) => call[0].purpose)).toEqual([
            'video',
            'video',
            'control',
        ]);
        expect(result.handle.rawVideoStream).toBe(videoSocket);
        expect(result.handle.sendScrcpyControl).toBeTypeOf('function');

        await result.handle.stop();
    });

    it('cleans up the tunnel and remote artifact after an aborted tunnel connect', async () => {
        const controller = new AbortController();
        const cleanupCalls: string[] = [];
        const abortedCleanupCalls: string[] = [];
        const stopProcess = vi.fn(async () => {});
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            const command = input.args.join(' ');
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            const isCleanup = input.args.includes('--remove') || input.args.includes('rm') || input.args.includes('rmdir');
            if (isCleanup) {
                cleanupCalls.push(command);
                if (input.signal?.aborted) {
                    abortedCleanupCalls.push(command);
                    return { exitCode: null, stdout: '', stderr: '', aborted: true };
                }
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: stopProcess },
        }));
        const connectTcpSocket = vi.fn(async () => {
            controller.abort();
            return {
                ok: false as const,
                reasonCode: 'scrcpy_tunnel_socket_unavailable',
                diagnostics: [{ code: 'scrcpy_tunnel_socket_connect_aborted' }],
            };
        });

        await expect(ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
            signal: controller.signal,
            tunnel: {
                localPort: 27183,
                connectTcpSocket,
            },
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_tunnel_socket_connect_aborted',
            })],
        });

        expect(stopProcess).toHaveBeenCalledTimes(1);
        expect(abortedCleanupCalls).toEqual([]);
        expect(cleanupCalls).toEqual([
            '-s emulator-5554 forward --remove tcp:27183',
            '-s emulator-5554 shell rm -f /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier',
        ]);
    });

    it.each([
        ['unauthorized', 'android_device_unauthorized'],
        ['offline', 'android_device_offline'],
    ] as const)('fails closed when the emulator is %s', async (state, reasonCode) => {
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(state), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>();

        await expect(ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode,
            diagnostics: [expect.objectContaining({
                serial: 'emulator-5554',
                state,
            })],
        });

        expect(runAdb).toHaveBeenCalledTimes(1);
        expect(startServer).not.toHaveBeenCalled();
    });

    it('fails closed with typed diagnostics when pushing the server fails', async () => {
        await expect(ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb: async (input) => {
                if (input.args.join('\0') === 'devices\0-l') {
                    return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
                }
                if (input.args.includes('push')) {
                    return { exitCode: 1, stdout: '', stderr: 'failed to copy' };
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            },
            startServer: async () => {
                throw new Error('start should not run after push failure');
            },
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'scrcpy_server_push_failed',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_server_push_failed',
                operation: 'adb_push_scrcpy_server',
                exitCode: 1,
            })],
        });
    });

    it('fails closed with typed diagnostics when app_process startup fails', async () => {
        await expect(ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb: createSuccessfulRunner(),
            startServer: async () => ({
                ok: false,
                exitCode: 1,
                stdout: '',
                stderr: 'app_process failed',
            }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_server_start_failed',
                exitCode: 1,
            })],
        });
    });

    it('stops idempotently while attempting process and remote artifact cleanup once', async () => {
        const stopProcess = vi.fn(async () => {
            throw new Error('already exited');
        });
        const cleanupCalls: string[] = [];
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            if (input.args.includes('rm') || input.args.includes('rmdir')) {
                cleanupCalls.push(input.args.join(' '));
                return {
                    exitCode: input.args.includes('rm') ? 1 : 0,
                    stdout: '',
                    stderr: input.args.includes('rm') ? 'not found' : '',
                };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });

        const result = await ensureAndroidScrcpyServer({
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true, ...trustedArtifact, source: 'dev_fixture' }),
            runAdb,
            startServer: async () => ({ ok: true, process: { stop: stopProcess } }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const first = await result.handle.stop();
        const second = await result.handle.stop();

        expect(first).toMatchObject({
            status: 'stopped',
            diagnostics: [
                expect.objectContaining({ code: 'scrcpy_server_process_stop_failed' }),
                expect.objectContaining({ code: 'scrcpy_server_cleanup_failed', operation: 'adb_remove_scrcpy_server' }),
            ],
        });
        expect(second).toEqual(first);
        expect(result.handle.readState().transportStatus).toBe('stopped');
        expect(stopProcess).toHaveBeenCalledTimes(1);
        expect(cleanupCalls).toEqual([
            '-s emulator-5554 shell rm -f /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier',
        ]);
    });

    it('exposes a live scrcpy control sender from a ready lifecycle-owned socket and closes it on stop', async () => {
        const socket = new FakeControlSocket();
        const stopProcess = vi.fn(async () => {});
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: stopProcess },
        }));
        const serverInput = {
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true as const, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true as const, ...trustedArtifact, source: 'dev_fixture' as const }),
            runAdb: createSuccessfulRunner(),
            startServer,
            controlSocket: {
                screenSize: { widthPx: 1080, heightPx: 1920 },
                connect: async () => ({ ok: true as const, socket }),
            },
        };

        const result = await ensureAndroidScrcpyServer(serverInput);

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        const handleWithControl = result.handle as typeof result.handle & {
            sendScrcpyControl?: AndroidScrcpyControlSender;
        };
        expect(handleWithControl.sendScrcpyControl).toBeTypeOf('function');
        await expect(handleWithControl.sendScrcpyControl?.({
            v: 1,
            streamId: 'stream-1',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event-1',
            kind: 'pinch',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 0.2,
            endDistance: 0.5,
        })).resolves.toMatchObject({ ok: true });

        expect(socket.writtenPackets).toHaveLength(6);
        expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
            args: expect.arrayContaining(['control=true']),
        }));
        expect(startServer.mock.calls[0]?.[0].args).not.toContain('control=false');

        await result.handle.stop();
        await result.handle.stop();

        expect(socket.closed).toBe(true);
        expect(stopProcess).toHaveBeenCalledTimes(1);
    });

    it('fails closed and stops the process when the requested live control socket is unavailable', async () => {
        const cleanupCalls: string[] = [];
        const runAdb = vi.fn<AndroidScrcpyServerAdbRunner>(async (input) => {
            if (input.args.join('\0') === 'devices\0-l') {
                return { exitCode: 0, stdout: devicesOutput(), stderr: '' };
            }
            if (input.args.includes('rm') || input.args.includes('rmdir')) {
                cleanupCalls.push(input.args.join(' '));
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
        const stopProcess = vi.fn(async () => {});
        const startServer = vi.fn<AndroidScrcpyServerProcessStarter>(async () => ({
            ok: true,
            process: { stop: stopProcess },
        }));
        const serverInput = {
            serial: 'emulator-5554',
            resolveAdbTooling: async () => ({ ok: true as const, ...adb }),
            resolveScrcpyServerArtifact: async () => ({ ok: true as const, ...trustedArtifact, source: 'dev_fixture' as const }),
            runAdb,
            startServer,
            controlSocket: {
                screenSize: { widthPx: 1080, heightPx: 1920 },
                connect: async () => ({
                    ok: false as const,
                    reasonCode: 'scrcpy_control_socket_unavailable',
                    diagnostics: [{ code: 'adb_forward_socket_missing' }],
                }),
            },
        };

        await expect(ensureAndroidScrcpyServer(serverInput)).resolves.toMatchObject({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            diagnostics: [expect.objectContaining({
                code: 'adb_forward_socket_missing',
            })],
        });

        expect(stopProcess).toHaveBeenCalledTimes(1);
        expect(cleanupCalls).toEqual([
            '-s emulator-5554 shell rm -f /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/scrcpy-server.jar',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server/3.2',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier/scrcpy-server',
            '-s emulator-5554 shell rmdir /data/local/tmp/happier',
        ]);
    });
});
