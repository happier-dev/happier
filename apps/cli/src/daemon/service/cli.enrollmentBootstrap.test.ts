import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHappierJsonExecutorFromTextRunner } from '@happier-dev/cli-common/systemTasks';
import { createRemoteNativeBootstrapMachineTaskKind } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { spawnDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import './cli';

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commandExistsInPath');
    vi.resetModules();
});

it('enrollment installs then starts only after bootstrap succeeds while the old launchd job drains', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-enrollment-bootstrap-', env: {
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath,
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: join(process.cwd(), 'src/index.ts'),
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '100',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '1000',
    } }, async () => {
        const owner = spawnDaemonLifecycleOwner();
        let elapsed = 0;
        let loaded = false;
        let draining = false;
        let starting = false;
        let published = false;
        let rejectedBootstrap = false;
        let publishOwner = () => {};
        const steps: string[] = [];
        const cliActions: string[] = [];
        const priorExitCode = process.exitCode;
        try {
            vi.resetModules();
            vi.doMock('./commandExistsInPath', () => ({ commandExistsInPath: () => true }));
            // Only launchd/process execution and the clock are replaced. The enrollment
            // executor, CLI, plans, persistence, and ownership evaluation remain real.
            vi.doMock('node:child_process', async importOriginal => ({
                ...await importOriginal<typeof import('node:child_process')>(),
                spawnSync: (command: string, args: readonly string[] = []) => {
                    if (command === 'sleep') {
                        elapsed += Number(args[0]) * 1000;
                        return { status: 0 };
                    }
                    if (command !== 'launchctl') return { status: 0 };
                    const step = args[0];
                    if (step === 'bootout') { draining = loaded; loaded = false; }
                    if (step === 'bootstrap') {
                        steps.push('bootstrap');
                        if (starting && draining) {
                            draining = false;
                            rejectedBootstrap = true;
                            // The native lookup can still expose the old job during teardown.
                            return { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
                        }
                        loaded = true;
                    }
                    if (step === 'kickstart') {
                        steps.push('kickstart');
                        if (!loaded) return { status: 113, stderr: 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' };
                        if (!published) { publishOwner(); published = true; }
                    }
                    if (step === 'print') return loaded || rejectedBootstrap
                        ? { status: 0, stdout: 'state = running\nruns = 1\n' }
                        : { status: 113, stderr: 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' };
                    return { status: 0 };
                },
            }));
            const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv } = await import('./cli');
            const { resolveDaemonServicePaths } = await import('./paths');
            const { writeCredentialsTokenOnly, writeDaemonState, clearDaemonStateForTestTeardown } = await import('@/persistence');
            const { configuration } = await import('@/configuration');
            const paths = resolveDaemonServicePaths(resolveDaemonServiceCliRuntimeFromEnv());
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            publishOwner = () => writeDaemonState({ pid: owner.pid, httpPort: 43124, startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion, startupSource: 'background-service', serviceLabel: paths.label });
            await writeCredentialsTokenOnly({ token: 'enrollment-bootstrap-test-token' });
            const now = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed);
            vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
            const realSetTimeout = globalThis.setTimeout;
            vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
                realSetTimeout(() => { elapsed += Number(delay ?? 0); callback(...args); }, 0));
            const executor = createHappierJsonExecutorFromTextRunner(async args => {
                if (args[0] !== 'service' || !['install', 'start'].includes(args[1]!)) {
                    // Remote Home/auth/status IO is outside the guest service owner.
                    const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed',
                        machineId: 'enrolled-machine', services: [], service: { installed: true },
                        daemon: { running: published, healthy: published }, auth: { needsAuth: false, machineId: 'enrolled-machine' } };
                    return { status: 0, stdout: JSON.stringify({ ...status, ok: true, data: status }), stderr: '' };
                }
                cliActions.push(args[1]!);
                starting = args[1] === 'start';
                if (starting) {
                    // A service can still be loaded after its daemon exits before
                    // the separate enrollment Start. Rebootstrap must not trust it.
                    clearDaemonStateForTestTeardown();
                    published = false;
                }
                const output = captureStdoutJsonOutput();
                try {
                    await runDaemonServiceCliCommand({ argv: [...args.slice(1), '--wait-timeout-ms', '10000'] });
                    return { status: process.exitCode === 1 ? 1 : 0, stdout: JSON.stringify(output.json()), stderr: '' };
                } finally { output.restore(); }
            });
            const task = createRemoteNativeBootstrapMachineTaskKind({
                configuration: { relay: { relayUrl: 'https://api.happier.dev' }, serviceMode: 'user' },
                executor, installRemoteCli: async () => {}, approveLocalAuthRequest: async () => {}, assertCurrent: async () => {},
            });
            const result = await task.run({ params: {}, emit: () => {}, prompt: async () => { throw new Error('Already authenticated'); } });
            expect(result.machineId).toBe('enrolled-machine');
            expect(cliActions).toEqual(['install', 'start']);
            expect(rejectedBootstrap).toBe(true);
            expect({ loaded, published }).toEqual({ loaded: true, published: true });
            expect(steps).toEqual(['bootstrap', 'kickstart', 'bootstrap', 'bootstrap', 'kickstart']);
        } finally {
            process.exitCode = priorExitCode;
            vi.restoreAllMocks();
            expect(await owner.kill()).toBe(true);
        }
    });
});
