import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { spawnSleepyDetachedProcess, withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { spawnDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createHappierJsonExecutorFromTextRunner } from '@happier-dev/cli-common/systemTasks';
import { formatSshCommandFailure, readGuestCliFailureOutput, readSshCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { sshCommandFailure } from '@/capabilities/systemTasks/ssh/sshCommandFailure';
import { buildWindowsScheduledTaskLauncherAction } from '@happier-dev/cli-common/service';
import { createWindowsServiceLauncherPeFixture } from '../../../../../scripts/testing/windowsServiceLauncherPeFixture.mjs';
import type { DaemonServiceFailureFacts } from './failure';
// Collect the real CLI graph before per-case lifetimes. Cases still re-import it
// after installing their OS boundaries and refreshing the configured test home.
import './cli';

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
});

it.each([
    { scenario: 'late-owner', platform: 'linux' },
    { scenario: 'late-owner-slow-probe', platform: 'linux' },
    { scenario: 'late-owner-slow-probe', platform: 'darwin' },
    { scenario: 'late-owner-slow-probe', platform: 'win32' },
    { scenario: 'late-owner-slow-probe', platform: 'linux', action: 'install' },
    { scenario: 'late-owner-slow-probe', platform: 'darwin', action: 'install' },
    { scenario: 'bootstrap-ready', platform: 'darwin', action: 'install' },
    { scenario: 'invalid-relay-config', platform: 'linux' },
    { scenario: 'invalid-relay-config', platform: 'linux', action: 'restart' },
    { scenario: 'command-deadline', platform: 'linux', action: 'stop' },
    { scenario: 'command-deadline', platform: 'darwin', action: 'stop' },
    { scenario: 'command-deadline', platform: 'win32', action: 'stop' },
    { scenario: 'command-deadline', platform: 'linux', action: 'uninstall' },
    { scenario: 'command-deadline', platform: 'darwin', action: 'uninstall' },
    { scenario: 'command-deadline', platform: 'win32', action: 'uninstall' },
    { scenario: 'starting-process-owner', platform: 'linux' },
    { scenario: 'transient-inactive-owner', platform: 'linux' },
    { scenario: 'stale-exit-owner', platform: 'linux' },
    { scenario: 'late-owner', platform: 'darwin' },
    { scenario: 'bootstrap-ready', platform: 'darwin' },
    { scenario: 'bootstrap-never-ready', platform: 'darwin' },
    { scenario: 'command-failed', platform: 'linux' },
    { scenario: 'not-installed', platform: 'linux' },
    { scenario: 'foreign-home', platform: 'linux' },
    { scenario: 'late-owner', platform: 'win32' },
    { scenario: 'queued-owner', platform: 'win32' },
    { scenario: 'queued-owner', platform: 'darwin' },
    { scenario: 'kickstart-exit', platform: 'darwin' },
    { scenario: 'never-owner', platform: 'linux' },
    { scenario: 'never-owner', platform: 'linux', action: 'install' },
    { scenario: 'wrong-owner', platform: 'linux' },
    { scenario: 'wrong-owner', platform: 'darwin' },
    { scenario: 'wrong-owner', platform: 'win32' },
    { scenario: 'exited-service', platform: 'linux' },
    { scenario: 'exited-service', platform: 'darwin' },
    { scenario: 'exited-service', platform: 'win32' },
    { scenario: 'crash-loop', platform: 'linux' },
    { scenario: 'crash-loop', platform: 'darwin' },
] as const)(
    'uses the remaining enrollment lifetime for $platform service ownership ($scenario/$action)', async testCase => {
        const { scenario, platform } = testCase;
        const action = ('action' in testCase ? testCase.action : undefined) ?? 'start';
        const waitTimeoutMs = scenario === 'command-deadline' ? 75 : scenario === 'late-owner-slow-probe' ? 147_000 : 480_000;
        await withConfiguredDaemonTestHome({ prefix: 'happier-service-enrollment-lifetime-', env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: platform,
            HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath,
            HAPPIER_DAEMON_SERVICE_ENTRY_PATH: join(process.cwd(), 'src/index.ts'),
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: undefined,
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_ACTIVE_GRACE_TIMEOUT_MS: undefined,
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '100',
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '1000',
            HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: scenario === 'starting-process-owner' ? '1' : undefined,
            HAPPIER_IROH_RELAY_POLICY: scenario === 'invalid-relay-config' ? 'invalid-policy' : undefined,
            PATH: process.env.PATH,
        } }, async ({ homeDir }) => {
            // Real command lookup reaches executable fixture files. Only execution
            // crosses the mocked process boundary, including on other host OSes.
            const commandsDir = join(homeDir, 'commands');
            mkdirSync(commandsDir, { recursive: true });
            for (const command of ['systemctl', 'launchctl', 'powershell.exe', 'schtasks']) {
                for (const filename of command.endsWith('.exe') ? [command] : [command, `${command}.exe`]) {
                    const path = join(commandsDir, filename);
                    writeFileSync(path, 'fixture');
                    chmodSync(path, 0o755);
                }
            }
            process.env.PATH = `${commandsDir}${delimiter}${process.env.PATH ?? ''}`;
            const owner = spawnDaemonLifecycleOwner();
            let startingOwner: ReturnType<typeof spawnSleepyDetachedProcess> | undefined;
            const incidentSequence = ['starting-process-owner', 'transient-inactive-owner', 'stale-exit-owner'].includes(scenario);
            const readyAtMs = incidentSequence ? 114_000 : 145_000;
            let elapsedMs = 0;
            let serviceStarted = false;
            let publishedOwner = false;
            let slowProbeCharged = false;
            const nativeBudgets: Array<{ timeout: number | undefined; remaining: number }> = [];
            let publishOwner = () => {};
            let retireOwner = () => {};
            let launchdBootstrap = false;
            let windowsTaskToRun = '';
            try {
                vi.resetModules();
                if (scenario === 'starting-process-owner') {
                    // Restrict the genuine procfs directory boundary to this fixture's
                    // processes. Keep census reads, classification and ownership real.
                    vi.doMock('node:fs/promises', async (importOriginal) => {
                        const actual = await importOriginal<typeof import('node:fs/promises')>();
                        return { ...actual, readdir: (...args: unknown[]) => String(args[0]) === '/proc'
                            ? Promise.resolve([process.pid, owner.pid, ...(startingOwner ? [startingOwner.pid] : [])].map(String))
                            : Reflect.apply(actual.readdir, actual, args) };
                    });
                }
                // Only the service manager/process boundary is replaced. Service planning,
                // credential persistence and daemon ownership evaluation remain real.
                vi.doMock('node:child_process', async (importOriginal) => ({
                    ...await importOriginal<typeof import('node:child_process')>(),
                    spawnSync: (command: string, args: readonly string[] = [], options?: { timeout?: number }) => {
                        if ((scenario === 'late-owner-slow-probe' || scenario === 'command-deadline')
                            && ['systemctl', 'launchctl', 'powershell.exe', 'schtasks'].includes(command)) {
                            nativeBudgets.push({ timeout: options?.timeout, remaining: waitTimeoutMs - elapsedMs });
                        }
                        if (scenario === 'command-failed' && command === 'systemctl' && (args.includes('start') || args.includes('restart'))) {
                            return { status: 1, stderr: Buffer.from('private-command-output-secret') };
                        }
                        if (command === 'sleep') {
                            elapsedMs += Number(args[0]) * 1000;
                            return { status: 0 };
                        }
                        if (scenario.startsWith('bootstrap-') && command === 'launchctl') {
                            if (args[0] === 'bootstrap' && (scenario === 'bootstrap-never-ready' || elapsedMs < 2_000)) {
                                return { status: 1, stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
                            }
                            if (args[0] === 'print' && !serviceStarted) {
                                return { status: 113, stderr: Buffer.from('Could not find service') };
                            }
                        }
                        if (command === 'powershell.exe' && args.some(arg => arg.includes('.GetFolder("\\Happier")'))) {
                            return { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.from('') };
                        }
                        if ((command === 'systemctl' && (args.includes('start') || args.includes('restart')))
                            || (command === 'launchctl' && ['bootstrap', 'kickstart'].includes(args[0]!))
                            || (command === 'schtasks' && args[0] === '/Run')) {
                            serviceStarted = true;
                            if (scenario === 'starting-process-owner' && !startingOwner) {
                                // A real OS process is visible before it publishes daemon state.
                                startingOwner = spawnSleepyDetachedProcess(['@happier-dev/cli', join(process.cwd(), 'src/index.ts'), 'daemon', 'start-sync']);
                            }
                        }
                        if (command === 'launchctl' && args[0] === 'bootstrap') launchdBootstrap = true;
                        if (scenario === 'invalid-relay-config' && serviceStarted && !publishedOwner) {
                            // An implementation that swallows the configuration refusal can
                            // otherwise wait until timeout instead of exposing its bad success.
                            publishOwner();
                            publishedOwner = true;
                        }
                        if (['queued-owner', 'kickstart-exit'].includes(scenario) && command === 'launchctl' && args[0] === 'kickstart') retireOwner();
                        if (serviceStarted && !publishedOwner && elapsedMs >= readyAtMs && (incidentSequence || scenario.startsWith('late-owner') || scenario === 'queued-owner' || scenario === 'bootstrap-ready')) {
                            publishOwner();
                            publishedOwner = true;
                        }
                        if (scenario === 'late-owner-slow-probe' && publishedOwner && !slowProbeCharged && elapsedMs >= 146_000) {
                            // The existing structured systemd query can take two seconds.
                            elapsedMs += Math.min(2_000, options?.timeout ?? 2_000);
                            slowProbeCharged = true;
                        }
                        if (serviceStarted && !publishedOwner && elapsedMs >= 2_000 && scenario === 'wrong-owner') {
                            publishOwner();
                            publishedOwner = true;
                        }
                        // Let the pre-fix indefinite Linux wait eventually settle so RED
                        // observes its renewed budget, rather than a runner timeout.
                        const stopped = (['exited-service', 'crash-loop', 'kickstart-exit'].includes(scenario) && elapsedMs >= 2_000)
                            || (scenario === 'never-owner' && elapsedMs >= 481_000);
                        const starting = (scenario.startsWith('late-owner') || scenario === 'queued-owner') && !publishedOwner;
                        let stdout = stopped ? 'failed' : starting ? 'activating' : 'active';
                        if (command === 'systemctl' && args.includes('show')) {
                            stdout = `ActiveState=${stopped ? scenario === 'crash-loop' ? 'activating' : 'failed' : starting ? 'activating' : 'active'}\nSubState=${stopped ? 'auto-restart' : starting ? 'start' : 'running'}\nResult=${stopped ? 'exit-code' : 'success'}\nExecMainStatus=${stopped ? 1 : 0}\nNRestarts=${scenario === 'crash-loop' ? 7 : 0}\n`;
                            if (incidentSequence) {
                                // systemctl show property sequences: restart's inactive/dead
                                // transition, start-pre, then Type=simple active/running while
                                // the daemon is still importing. Exit properties can be from
                                // the preceding invocation; they do not prove current failure.
                                const inactive = scenario === 'transient-inactive-owner' && serviceStarted && elapsedMs < 1_000;
                                const activating = scenario === 'transient-inactive-owner' && elapsedMs >= 1_000 && elapsedMs < 2_000;
                                const priorExit = scenario === 'stale-exit-owner' || inactive;
                                stdout = `ActiveState=${inactive ? 'inactive' : activating ? 'activating' : 'active'}\nSubState=${inactive ? 'dead' : activating ? 'start-pre' : 'running'}\nResult=${priorExit ? 'exit-code' : 'success'}\nExecMainStatus=${priorExit ? 1 : 0}\nExecMainExitTimestamp=${priorExit ? 'Wed 2026-10-21 03:30:00 UTC' : ''}\nNRestarts=0\nMainPID=${inactive || activating ? 0 : startingOwner?.pid ?? owner.pid}\n`;
                            }
                        }
                        if (command === 'launchctl' && args[0] === 'print') stdout = stopped || (scenario === 'queued-owner' && serviceStarted && !publishedOwner)
                            ? `state = waiting\nruns = ${scenario === 'kickstart-exit' ? 2 : 1}\nlast exit code = 1\n` : 'state = running\nruns = 1\nlast exit code = 1\n';
                        if (command === 'powershell.exe') {
                            const queued = scenario === 'queued-owner' && !publishedOwner;
                            stdout = JSON.stringify({ exists: true, enabled: true,
                                active: !stopped && !queued, stateValue: queued ? elapsedMs < 1_000 ? 3 : 2 : stopped ? 3 : 4,
                                stateLabel: queued ? 'Queued' : stopped ? 'Ready' : 'Running',
                                lastRunTime: new Date(Date.now() - (queued ? 600_000 : 0)).toISOString(), lastTaskResult: stopped ? 1 : 0,
                                taskToRun: windowsTaskToRun });
                        }
                        return { status: args.includes('is-active') && (stopped || starting) ? 3 : 0,
                            stdout: Buffer.from(stdout), stderr: Buffer.from('') };
                    },
                }));
                const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
                    { writeCredentialsTokenOnly, writeDaemonState, clearDaemonStateForTestTeardown }, { configuration }, { planDaemonServiceInstall }] = await Promise.all([
                    import('./cli'), import('@/persistence'), import('@/configuration'), import('./plan'),
                ]);
                const runtime = resolveDaemonServiceCliRuntimeFromEnv();
                const paths = resolveDaemonServicePaths(runtime);
                if (platform === 'win32') {
                    mkdirSync(dirname(paths.launcherPath), { recursive: true });
                    writeFileSync(paths.launcherPath, createWindowsServiceLauncherPeFixture());
                    const action = buildWindowsScheduledTaskLauncherAction({ launcherPath: paths.launcherPath,
                        definitionPath: paths.installedPath, diagnosticLogPath: paths.launcherDiagnosticLogPath });
                    windowsTaskToRun = `${action.executable} ${action.arguments}`;
                }
                if (action !== 'install' && scenario !== 'not-installed') {
                    mkdirSync(dirname(paths.installedPath), { recursive: true });
                    writeFileSync(paths.installedPath, planDaemonServiceInstall({ ...runtime, mode: 'user', uid: runtime.uid ?? undefined,
                        ...(scenario === 'foreign-home' ? { happierHomeDir: join(runtime.happierHomeDir, 'private-other-home') } : {}),
                    }).files[0]!.content);
                }
                await writeCredentialsTokenOnly({ token: 'enrollment-lifetime-token' });
                publishOwner = () => writeDaemonState({ pid: startingOwner?.pid ?? owner.pid, httpPort: 43124, startedAt: Date.now(),
                    startedWithCliVersion: configuration.currentCliVersion, startupSource: 'background-service',
                    serviceLabel: scenario === 'wrong-owner' ? 'another-service' : paths.label });
                retireOwner = clearDaemonStateForTestTeardown;
                if (['queued-owner', 'kickstart-exit'].includes(scenario) && platform === 'darwin') publishOwner();

                const startedAt = Date.now();
                vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsedMs);
                vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
                const realSetTimeout = globalThis.setTimeout;
                // Accelerate the clock boundary without mocking the polling/ownership logic.
                vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
                    realSetTimeout(() => { elapsedMs += Number(delay ?? 0); callback(...args); }, 0));
                const priorExitCode = process.exitCode;
                const output = captureStdoutJsonOutput<{ ok: boolean }>();
                try {
                    // Keep the real process-output adapter so timeout failures retain the
                    // task's existing cli_command_failed type at the caller boundary.
                    const executor = createHappierJsonExecutorFromTextRunner(async args => {
                        try {
                            await runDaemonServiceCliCommand({ argv: args });
                            return { status: process.exitCode === 1 ? 1 : 0, stdout: JSON.stringify(output.json()), stderr: '' };
                        } catch (error) {
                            return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
                        }
                    });
                    const result = executor.runHappierJson([action, '--wait-timeout-ms', String(waitTimeoutMs), '--json']);
                    if (incidentSequence || scenario === 'late-owner' || scenario === 'queued-owner' || scenario === 'bootstrap-ready') {
                        await expect(result).resolves.toMatchObject({ ok: true });
                        expect(elapsedMs).toBeGreaterThanOrEqual(readyAtMs + 1_000);
                        expect(elapsedMs).toBeLessThan(480_000);
                    } else if (scenario === 'bootstrap-never-ready') {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed', message: expect.stringContaining('launchctl_io_error') });
                        expect(output.json()).toMatchObject({ ok: false, error: 'service_start_timeout', serviceStep: 'bootstrap', serviceStepStatus: 'deadline_elapsed', reason: 'launchctl_io_error',
                            command: { program: 'launchctl', action: 'bootstrap' }, process: { exitStatus: 1 } });
                        expect(elapsedMs).toBe(480_000);
                    } else if (scenario === 'command-deadline') {
                        await expect(result).resolves.toMatchObject({ ok: true });
                        expect(nativeBudgets.length).toBeGreaterThan(0);
                        expect(nativeBudgets.every(({ timeout, remaining }) =>
                            typeof timeout === 'number' && timeout > 0 && timeout <= remaining)).toBe(true);
                        expect(elapsedMs).toBeLessThanOrEqual(waitTimeoutMs);
                    } else if (scenario === 'invalid-relay-config') {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        expect(output.json()).toEqual({ ok: false, error: 'service_preflight_failed', serviceStep: 'preflight', serviceStepStatus: 'failed' });
                        expect(serviceStarted).toBe(false);
                    } else if (scenario === 'command-failed') {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        expect(output.json()).toEqual({ ok: false, error: 'service_command_failed', serviceStep: 'command', serviceStepStatus: 'failed',
                            command: { program: 'systemctl', action: 'restart' }, process: { exitStatus: 1 } });
                        expect(output.chunks.join('')).not.toContain('private-command-output-secret');
                    } else if (scenario === 'not-installed') {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        expect(output.json()).toMatchObject({ ok: false, error: 'not_installed', serviceStep: 'preflight', serviceStepStatus: 'failed' });
                        expect(elapsedMs).toBe(0);
                    } else if (scenario === 'foreign-home') {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        expect(output.json()).toEqual({ ok: false, error: 'foreign_home_service', serviceStep: 'preflight', serviceStepStatus: 'failed' });
                        expect(elapsedMs).toBe(0);
                    } else {
                        const reason = scenario === 'never-owner' || scenario === 'late-owner-slow-probe' ? 'deadline_elapsed'
                            : scenario === 'wrong-owner' ? 'owner_service_label_mismatch'
                            : platform === 'linux' ? scenario === 'crash-loop' ? 'systemd_auto_restart_failed' : 'systemd_failed'
                            : platform === 'darwin' ? 'launchd_exited' : 'scheduled_task_exited';
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        expect(output.json()).toEqual({ ok: false, error: 'service_ownership_failed', serviceStep: 'wait', serviceStepStatus: reason === 'deadline_elapsed' ? 'deadline_elapsed' : 'failed', reason });
                        if (scenario === 'late-owner-slow-probe') expect(elapsedMs).toBeGreaterThanOrEqual(147_000);
                        else if (scenario === 'never-owner') expect(elapsedMs).toBe(480_000);
                        else expect(elapsedMs).toBeLessThan(5_000);
                    }
                    if (scenario === 'late-owner-slow-probe') {
                        expect(nativeBudgets.length).toBeGreaterThan(0);
                        expect(nativeBudgets.every(({ timeout, remaining }) =>
                            typeof timeout === 'number' && timeout > 0 && timeout <= remaining)).toBe(true);
                        expect(elapsedMs).toBe(waitTimeoutMs);
                    }
                    if (!output.json().ok) {
                        const envelope = output.json<DaemonServiceFailureFacts>();
                        const facts = readGuestCliFailureOutput(output.chunks.join(''), '');
                        expect(facts).toEqual({ guestCliCode: envelope.error, serviceStep: envelope.serviceStep,
                            serviceStepStatus: envelope.serviceStepStatus, ...(envelope.reason ? { serviceReason: envelope.reason } : {}),
                            ...(envelope.command ? { command: envelope.command } : {}), ...(envelope.process ? { process: envelope.process } : {}) });
                        const phase = action === 'uninstall' ? 'daemon.service.uninstallAll' : `daemon.service.${action}` as const;
                        const message = formatSshCommandFailure('ssh_command_failed', { phase,
                            exitStatus: 1, stdoutPresent: true, stderrPresent: false, ...facts });
                        const failure = sshCommandFailure(output.chunks.join(''), {
                            status: 1, stdout: output.chunks.join(''), stderr: '',
                        }, phase);
                        expect(failure.message).toBe(message);
                        expect(readSshCommandFailure(failure.code, failure.message)).toEqual({ code: 'ssh_command_failed', message });
                        expect(message).not.toContain('private-command-output-secret');
                    }
                    if (scenario === 'never-owner' && action === 'install') {
                        // Reach the actual terminal presenter as well as the JSON adapter.
                        // A successful service-manager command must not hide missing ownership.
                        elapsedMs = 0;
                        const priorBootstrapExitCode = process.exitCode;
                        process.exitCode = undefined;
                        const priorArgv = process.argv;
                        const terminal = captureConsoleText();
                        try {
                            process.argv = [process.execPath, join(process.cwd(), 'src/index.ts'), 'service', 'install',
                                '--wait-timeout-ms', String(waitTimeoutMs)];
                            const { runCliBootstrap } = await import('@/cli/bootstrap');
                            await runCliBootstrap(new URL('../../index.ts', import.meta.url).href);
                            expect(process.exitCode).toBe(1);
                            expect(terminal.text()).toContain('expected background service did not become the active daemon');
                            expect(terminal.text()).toContain('reason: deadline_elapsed');
                            expect(terminal.text()).toMatch(/Run `[^`]+ service status`/u);
                            expect(terminal.text()).not.toContain('private-command-output-secret');
                        } finally {
                            process.argv = priorArgv;
                            process.exitCode = priorBootstrapExitCode;
                            terminal.restore();
                        }
                    }
                    if (['queued-owner', 'kickstart-exit'].includes(scenario) && platform === 'darwin') expect(launchdBootstrap).toBe(false);
                } finally { output.restore(); process.exitCode = priorExitCode; }
            } finally {
                vi.restoreAllMocks();
                if (startingOwner) expect(await startingOwner.kill()).toBe(true);
                expect(await owner.kill()).toBe(true);
            }
        });
    }, 30_000,
);

it.each([
    { argv: ['start', '--wait-timeout-ms', 'private-invalid-value', '--json'], error: 'service_invalid_arguments' },
    { argv: ['start', '--mode', 'system', '--json'], error: 'service_preflight_failed' },
])('reports content-free JSON for $error before service execution', async ({ argv, error }) => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-service-preflight-facts-', env: {
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
    } }, async () => {
        const { runDaemonServiceCliCommand } = await import('./cli');
        const priorExitCode = process.exitCode;
        const output = captureStdoutJsonOutput();
        try {
            await runDaemonServiceCliCommand({ argv });
            expect(process.exitCode).toBe(1);
            expect(output.json()).toEqual({ ok: false, error, serviceStep: 'preflight', serviceStepStatus: 'failed' });
            expect(output.chunks.join('')).not.toContain('private-');
        } finally { output.restore(); process.exitCode = priorExitCode; }
    });
});

it.skipIf(typeof process.getuid !== 'function')('reports start privilege failures as preflight before a plan runs', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-service-privilege-facts-', env: {
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
    } }, async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(501);
        const { runDaemonServiceCliCommand } = await import('./cli');
        const priorExitCode = process.exitCode;
        const output = captureStdoutJsonOutput();
        try {
            await runDaemonServiceCliCommand({ argv: ['start', '--mode', 'system', '--system-user', 'service-user', '--json'] });
            expect(process.exitCode).toBe(1);
            expect(output.json()).toEqual({ ok: false, error: 'service_preflight_failed', serviceStep: 'preflight', serviceStepStatus: 'failed' });
        } finally { output.restore(); process.exitCode = priorExitCode; }
    });
});
