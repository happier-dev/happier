import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const logcatProcess = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
};
const spawnMock = vi.fn((
    _command: string,
    _args: string[],
    _options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => logcatProcess);

vi.mock('node:child_process', () => ({
    spawnSync: vi.fn(() => ({ status: 0, stdout: 'package:/data/app/base.apk' })),
    spawn: spawnMock,
}));

describe('mobileMaestroRunner sync performance log capture', () => {
    it('captures Android logcat into the run manifest for sync-perf parser discovery', async () => {
        logcatProcess.stdout = new PassThrough();
        logcatProcess.stderr = new PassThrough();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => logcatProcess.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async () => {
            logcatProcess.stdout.write('05-04 13:00:00.000 1 1 I ReactNativeJS: [sync-perf] {"events":[]}\n');
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                },
            },
            {
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        expect(spawnMock).toHaveBeenCalledWith(
            expect.stringMatching(/adb$/),
            expect.arrayContaining(['logcat', '-v', 'threadtime']),
            expect.objectContaining({ cwd: process.cwd() }),
        );

        const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
            artifacts?: {
                androidLogcat?: string;
                syncPerformanceLogs?: string[];
            };
        };
        expect(manifest.artifacts?.androidLogcat).toBe('android-logcat.log');
        expect(manifest.artifacts?.syncPerformanceLogs).toContain('android-logcat.log');
        expect(existsSync(`${result.runDir}/android-logcat.log`)).toBe(true);
        expect(readFileSync(`${result.runDir}/android-logcat.log`, 'utf8')).toContain('[sync-perf]');
        expect(logcatProcess.kill).toHaveBeenCalled();
    });

    it('waits for Android logcat close before finalizing the log artifact', async () => {
        logcatProcess.stdout = new PassThrough();
        logcatProcess.stderr = new PassThrough();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => {
                logcatProcess.emit('exit', 0);
                setTimeout(() => {
                    logcatProcess.stdout.write('05-04 13:00:01.000 1 1 I ReactNativeJS: [sync-perf] {"events":["after-exit"]}\n');
                    logcatProcess.emit('close', 0);
                }, 0);
            });
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        expect(readFileSync(`${result.runDir}/android-logcat.log`, 'utf8')).toContain('after-exit');
    });

    it('does not pass restore material to Android logcat capture', async () => {
        logcatProcess.stdout = new PassThrough();
        logcatProcess.stderr = new PassThrough();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => logcatProcess.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F13.populatedRelayRestoreAndOpenSessionPerformance.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                    HAPPIER_E2E_RESTORE_KEY: 'RESTORE-KEY-THAT-MUST-NOT-REACH-LOGCAT',
                },
            },
            {
                runMaestro: vi.fn(async () => ({ exitCode: 0 })),
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        expect(spawnOptions?.env?.HAPPIER_E2E_RESTORE_KEY).toBeUndefined();
    });

    it('captures iOS simulator logs into the run manifest for sync-perf parser discovery', async () => {
        logcatProcess.stdout = new PassThrough();
        logcatProcess.stderr = new PassThrough();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => logcatProcess.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async () => {
            logcatProcess.stdout.write('ReactNativeJS: [sync-perf] {"events":["ios"]}\n');
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'ios',
                    '--flows',
                    'suites/mobile-e2e/flows/F12.populatedRelaySessionPerformanceSmoke.yaml',
                    '--appId',
                    'dev.happier.app.publicdev',
                    '--serverUrl',
                    'http://127.0.0.1:52753',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_DEVICE_ID: 'E4245944-431E-418B-9797-B1AE85DAFDF6',
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                },
            },
            {
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
            },
        );

        expect(spawnMock).toHaveBeenCalledWith(
            expect.stringMatching(/xcrun$/),
            expect.arrayContaining([
                'simctl',
                'spawn',
                'E4245944-431E-418B-9797-B1AE85DAFDF6',
                'log',
                'stream',
            ]),
            expect.objectContaining({ cwd: process.cwd() }),
        );

        const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
            artifacts?: {
                iosSimulatorLog?: string;
                syncPerformanceLogs?: string[];
            };
        };
        expect(manifest.artifacts?.iosSimulatorLog).toBe('ios-simulator.log');
        expect(manifest.artifacts?.syncPerformanceLogs).toContain('ios-simulator.log');
        expect(readFileSync(`${result.runDir}/ios-simulator.log`, 'utf8')).toContain('[sync-perf]');
    });

    it('redacts generated terminal-connect deep links from runtime log artifacts', async () => {
        logcatProcess.stdout = new PassThrough();
        logcatProcess.stderr = new PassThrough();
        logcatProcess.kill = vi.fn(() => {
            queueMicrotask(() => logcatProcess.emit('close', 0));
            return true;
        });
        spawnMock.mockClear();

        const { runMobileMaestro } = await import('./mobileMaestroRunner');

        const runMaestro = vi.fn(async (params: { env: NodeJS.ProcessEnv }) => {
            const deepLink = String(params.env.HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK ?? '');
            if (deepLink) {
                logcatProcess.stdout.write(`ReactNativeJS: opening ${deepLink}\n`);
            }
            return { exitCode: 0 };
        });

        const result = await runMobileMaestro(
            {
                argv: [
                    'node',
                    'script',
                    '--platform',
                    'android',
                    '--flows',
                    'suites/mobile-e2e/flows/F4.connectedMachineComposerSmoke.yaml',
                    '--appId',
                    'dev.happier.app.internaldev',
                    '--skip-app-install-check',
                ],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
                    HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'cli-terminal-daemon',
                },
            },
            {
                startServerLight: vi.fn(async () => ({
                    baseUrl: 'http://127.0.0.1:43210',
                    port: 43210,
                    stop: vi.fn(async () => {}),
                })),
                startCliTerminalConnect: vi.fn(async () => ({
                    connectUrl: 'https://example.test/terminal/connect#key=test-key&server=http%3A%2F%2F127.0.0.1%3A43210',
                    waitForSuccess: vi.fn(async () => {}),
                    stop: vi.fn(async () => {}),
                })),
                startTestDaemon: vi.fn(async () => ({
                    stop: vi.fn(async () => {}),
                })),
                runMaestro,
                adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
                primeAppLaunch: vi.fn(async () => {}),
            },
        );

        const logText = readFileSync(`${result.runDir}/android-logcat.log`, 'utf8');
        expect(logText).not.toContain('test-key');
        expect(logText).toContain('[redacted:HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK]');
    });
});
