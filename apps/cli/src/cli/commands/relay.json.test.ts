import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { commandRegistry } from '@/cli/commandRegistry';

describe('happier relay --json', () => {
    let home = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeEach(async () => {
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-json-');
        envScope.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        if (home) {
            await removeTempDir(home);
        }
    });

    it('prints JSON and creates a relay profile', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'upsert-by-url', 'https://api.example.test', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'upsert-by-url', 'https://api.example.test', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(typeof parsed.data?.serverId).toBe('string');
            expect(parsed.data?.serverUrl).toBe('https://api.example.test');
            expect(parsed.data?.comparableKey).toBe('https://api.example.test');
            expect(parsed.data?.changed).toBe(true);
            expect(parsed.data?.used).toBe(false);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('supports --use and returns used=true when it changes the active relay', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'upsert-by-url', 'https://api.example.test', '--use', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'upsert-by-url', 'https://api.example.test', '--use', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.data?.used).toBe(true);
            expect(process.exitCode).toBe(0);

            const active = await getActiveServerProfile();
            expect(active.serverUrl).toBe('https://api.example.test');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('prints a resolved-target JSON envelope for the active relay profile', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'inspect-target', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'inspect-target', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_inspect_target');
            expect(parsed.data?.active?.serverUrl).toBe('https://api.happier.dev');
            expect(parsed.data?.active?.webappUrl).toBe('https://app.happier.dev');
            expect(parsed.data?.active?.comparableKey).toBe('https://api.happier.dev');
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('returns a stable error code for invalid arguments', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'upsert-by-url', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'upsert-by-url', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.error?.code).toBe('invalid_arguments');
            expect(process.exitCode).toBe(1);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('returns invalid_arguments for an invalid relay URL', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'upsert-by-url', 'notaurl', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'upsert-by-url', 'notaurl', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.error?.code).toBe('invalid_arguments');
            expect(process.exitCode).toBe(1);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('accepts explicit --server-url/--webapp-url/--local-server-url flags and persists them', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: [
                    'relay',
                    'upsert-by-url',
                    '--server-url',
                    'https://api.example.test',
                    '--webapp-url',
                    'https://app.example.test',
                    '--local-server-url',
                    'http://127.0.0.1:3005',
                    '--use',
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'happier',
                    'relay',
                    'upsert-by-url',
                    '--server-url',
                    'https://api.example.test',
                    '--webapp-url',
                    'https://app.example.test',
                    '--local-server-url',
                    'http://127.0.0.1:3005',
                    '--use',
                    '--json',
                ],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_upsert_by_url');
            expect(parsed.data?.serverUrl).toBe('https://api.example.test');

            const active = await getActiveServerProfile();
            expect(active.serverUrl).toBe('https://api.example.test');
            expect(active.webappUrl).toBe('https://app.example.test');
            expect(active.localServerUrl).toBe('http://127.0.0.1:3005');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });
});
