import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '../../configuration';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '../../testkit/logger/captureOutput';

vi.mock('@happier-dev/cli-common/relayHost', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const mockedEngine = {
        readStatus: async () => ({
            installed: true,
            version: '0.2.4',
            service: { active: true, enabled: true },
            baseUrl: 'http://127.0.0.1:3005',
            healthy: true,
            warnings: ['Detected older preview relay state at /tmp/legacy-root with a different data secret.'],
        }),
        installOrUpdate: async () => ({
            relayUrl: 'http://127.0.0.1:3005',
            mode: 'user',
        }),
        control: async () => undefined,
    };
    return {
        ...actual,
        createRelayHostEngine: () => mockedEngine,
        createLocalRelayHostEngine: () => mockedEngine,
    };
});

describe('happier relay host status warnings', () => {
    let home = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeEach(async () => {
        vi.resetModules();
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-status-warning-home-');
        envScope.patch({
            HAPPIER_HOME_DIR: home,
        });
        reloadConfiguration();
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        await removeTempDir(home);
    });

    it('includes relay warnings in the local JSON status envelope', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;

        try {
            const { commandRegistry } = await import('../commandRegistry');

            await commandRegistry.relay({
                args: ['relay', 'host', 'status', '--json'],
                rawArgv: ['node', 'hprev', 'relay', 'host', 'status', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_status');
            expect(parsed.data?.warnings).toEqual([
                'Detected older preview relay state at /tmp/legacy-root with a different data secret.',
            ]);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });
});
