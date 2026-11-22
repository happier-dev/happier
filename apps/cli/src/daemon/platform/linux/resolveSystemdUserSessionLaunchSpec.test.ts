import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSystemdUserSessionLaunchSpec } from './resolveSystemdUserSessionLaunchSpec';

describe('resolveSystemdUserSessionLaunchSpec', () => {
    afterEach(() => vi.restoreAllMocks());

    it('leaves launch to the caller when the jobs slice policy is unavailable', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        const execFile = vi.fn(async () => ({
            stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=infinity\n',
            stderr: '',
        }));

        await expect(resolveSystemdUserSessionLaunchSpec({
            args: ['codex'],
            environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test/session-bus' },
            systemdUserResourceGovernorExecFile: execFile,
        })).resolves.toBeNull();
    });

    it('preserves the pinned runner invocation and environment in the provisioned jobs scope', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        const execFile = vi.fn(async () => ({
            stdout: 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=1073741824\n',
            stderr: '',
        }));
        const entrypoint = '/runtime/.runner-snapshots/immutable/index.mjs';

        const spec = await resolveSystemdUserSessionLaunchSpec({
            args: ['codex', '--happy-terminal-mode', 'plain'],
            environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test/session-bus' },
            systemdUserResourceGovernorExecFile: execFile,
            launchOptions: {
                runtimeDecision: {
                    runtime: 'node',
                    argvPrefix: ['--no-warnings', entrypoint],
                    env: { HAPPIER_TEST_RUNNER_ENV: 'retained' },
                },
            },
        });

        expect(spec?.filePath).toBe('systemd-run');
        expect(spec?.args).toEqual(expect.arrayContaining([
            '--user', '--scope', '--slice=happier-jobs.slice',
            entrypoint, 'codex', '--happy-terminal-mode', 'plain',
        ]));
        expect(spec?.env).toEqual({ HAPPIER_TEST_RUNNER_ENV: 'retained' });
    });
});
