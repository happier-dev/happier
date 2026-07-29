import { describe, expect, it, vi } from 'vitest';

import type {
    IosSimulatorHelperProcessExit,
    IosSimulatorHelperProcessStartInput,
    IosSimulatorHelperSpawn,
} from './helper';

const modulePath = './helper';

function availableHealth(version = '1.2.3') {
    return {
        v: 1,
        platform: 'ios',
        status: 'available',
        usesPrivateFrameworks: true,
        helperDistribution: 'prebuilt-signed',
        requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        supportedCodecs: ['image.mjpeg'],
        supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'hardware_button'],
        helperVersion: version,
    };
}

describe('iOS simulator helper lifecycle', () => {
    it('resolves a verified artifact, probes strict health, and starts the helper only after it is ready', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        const order: string[] = [];
        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => {
                order.push('resolve');
                return {
                    ok: true,
                    path: '/runtime/assets/ios/simulator-helper/happier-ios-simulator-helper',
                    version: '1.2.3',
                    digest: 'sha256:trusted',
                };
            },
            probeHelperHealth: async ({ helperPath }: Readonly<{ helperPath: string }>) => {
                order.push(`probe:${helperPath}`);
                return availableHealth();
            },
            startHelper: async ({ helperPath, args }: IosSimulatorHelperProcessStartInput) => {
                order.push(`start:${helperPath}:${args.join(' ')}`);
                return {
                    pid: 1234,
                    stop: async () => {},
                };
            },
        });

        await expect(lifecycle.start()).resolves.toMatchObject({
            ready: true,
            helper: {
                path: '/runtime/assets/ios/simulator-helper/happier-ios-simulator-helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            },
            health: {
                status: 'available',
                helperVersion: '1.2.3',
            },
            process: {
                pid: 1234,
            },
        });
        await expect(lifecycle.health()).resolves.toMatchObject({
            status: 'available',
            helperVersion: '1.2.3',
        });
        expect(order).toEqual([
            'resolve',
            'probe:/runtime/assets/ios/simulator-helper/happier-ios-simulator-helper',
            'start:/runtime/assets/ios/simulator-helper/happier-ios-simulator-helper:--daemon-json',
        ]);
    });

    it.each([
        'helper_artifact_missing',
        'helper_artifact_unsigned',
        'helper_artifact_digest_mismatch',
        'helper_version_mismatch',
    ] as const)('fails closed for %s without probing or starting the helper', async (reasonCode) => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        const probeHelperHealth = vi.fn();
        const startHelper = vi.fn();
        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => ({
                ok: false,
                reasonCode,
                diagnostics: [{ code: reasonCode }],
            }),
            probeHelperHealth,
            startHelper,
        });

        await expect(lifecycle.start()).resolves.toMatchObject({
            ready: false,
            health: {
                status: 'unavailable',
                reasonCode,
                diagnostics: [expect.objectContaining({ code: reasonCode })],
            },
        });
        await expect(lifecycle.health()).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode,
        });
        expect(probeHelperHealth).not.toHaveBeenCalled();
        expect(startHelper).not.toHaveBeenCalled();
    });

    it('fails closed when strict helper health is unavailable and does not start the helper process', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        const startHelper = vi.fn();
        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            }),
            probeHelperHealth: async () => ({
                v: 1,
                platform: 'ios',
                status: 'unavailable',
                reasonCode: 'private_framework_symbol_mismatch',
                diagnostics: [{ missingSymbol: 'IndigoHIDMessageForMouseNSEvent' }],
            }),
            startHelper,
        });

        await expect(lifecycle.start()).resolves.toMatchObject({
            ready: false,
            helper: {
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            },
            health: {
                status: 'unavailable',
                reasonCode: 'private_framework_symbol_mismatch',
            },
        });
        expect(startHelper).not.toHaveBeenCalled();
    });

    it('stops a started helper exactly once across repeated cleanup calls', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        const stop = vi.fn(async () => {});
        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            }),
            probeHelperHealth: async () => availableHealth(),
            startHelper: async () => ({
                pid: 9876,
                stop,
            }),
        });

        await expect(lifecycle.start()).resolves.toMatchObject({ ready: true });
        await expect(lifecycle.stop()).resolves.toBeUndefined();
        await expect(lifecycle.stop()).resolves.toBeUndefined();
        expect(stop).toHaveBeenCalledOnce();
    });

    it('fails closed when the helper process cannot be started after a healthy probe', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            }),
            probeHelperHealth: async () => availableHealth(),
            startHelper: async () => {
                throw new Error('spawn failed');
            },
        });

        await expect(lifecycle.start()).resolves.toMatchObject({
            ready: false,
            helper: {
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            },
            health: {
                status: 'unavailable',
                reasonCode: 'ios_private_helper_unavailable',
                diagnostics: [expect.objectContaining({ code: 'helper_process_start_failed' })],
            },
        });
    });

    it('marks health unavailable when the supervised helper process exits', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperLifecycle).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperLifecycle) return;

        let resolveExit: (exit: IosSimulatorHelperProcessExit) => void = () => {};
        const exited = new Promise<IosSimulatorHelperProcessExit>((resolve) => {
            resolveExit = resolve;
        });
        const lifecycle = mod.createIosSimulatorHelperLifecycle({
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/runtime/helper',
                version: '1.2.3',
                digest: 'sha256:trusted',
            }),
            probeHelperHealth: async () => availableHealth(),
            startHelper: async () => ({
                pid: 9876,
                exited,
                stop: async () => {},
            }),
        });

        await expect(lifecycle.start()).resolves.toMatchObject({ ready: true });
        resolveExit({ exitCode: 9, signal: null });
        await Promise.resolve();

        await expect(lifecycle.health()).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_private_helper_unavailable',
            diagnostics: [expect.objectContaining({
                code: 'helper_process_exited',
                exitCode: 9,
                signal: null,
            })],
        });
    });

    it('starts helper binaries through an injectable spawn boundary without shell strings', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperProcessStarter).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperProcessStarter) return;

        const child = {
            pid: 4321,
            killed: false,
            kill: vi.fn(() => true),
            once: vi.fn(),
        };
        const spawn = vi.fn<IosSimulatorHelperSpawn>(() => child);
        const startHelper = mod.createIosSimulatorHelperProcessStarter({ spawn });

        const process = await startHelper({
            helperPath: '/runtime/helper',
            args: ['--daemon-json'],
        });
        await expect(process.stop()).resolves.toBeUndefined();

        expect(spawn).toHaveBeenCalledWith('/runtime/helper', ['--daemon-json'], expect.objectContaining({
            shell: false,
            windowsHide: true,
        }));
        expect(spawn.mock.calls[0]?.[0]).toBe('/runtime/helper');
        expect(spawn.mock.calls[0]?.[0]).not.toMatch(/(?:^|\/)(?:node|npm|npx|pnpm|yarn|bunx)$/);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('rejects Node and package-manager process paths before calling the spawn boundary', async () => {
        const mod = await import(modulePath).catch(() => null);

        expect(mod?.createIosSimulatorHelperProcessStarter).toBeTypeOf('function');
        if (!mod?.createIosSimulatorHelperProcessStarter) return;

        const spawn = vi.fn<IosSimulatorHelperSpawn>(() => {
            throw new Error('spawn should not be called');
        });
        const startHelper = mod.createIosSimulatorHelperProcessStarter({ spawn });

        await expect(async () => await startHelper({
            helperPath: '/usr/local/bin/node',
            args: ['--daemon-json'],
        })).rejects.toMatchObject({
            code: 'FORBIDDEN_HELPER_RUNTIME',
        });
        expect(spawn).not.toHaveBeenCalled();
    });
});
