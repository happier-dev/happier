import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { commandRegistry } from '@/cli/commandRegistry';

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-relay-cli-fake-ssh-'));
    const binDir = join(rootDir, 'bin');
    const sshPath = join(binDir, 'ssh');
    const scpPath = join(binDir, 'scp');
    const statePath = join(rootDir, 'scenario.json');
    const logPath = join(rootDir, 'invocations.log');

    writeFileSync(statePath, JSON.stringify({ outputs: scenario.outputs ?? [] }), 'utf8');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(
        sshPath,
        `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_SSH_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const outputs = Array.isArray(state.outputs) ? state.outputs : [];
const next = outputs.length > 0 ? outputs.shift() : { status: 0, stdout: '', stderr: '' };
state.outputs = outputs;
writeFileSync(statePath, JSON.stringify(state), 'utf8');

if (next.stdout) process.stdout.write(String(next.stdout));
if (next.stderr) process.stderr.write(String(next.stderr));
process.exit(Number(next.status ?? 0));
`,
        'utf8',
    );
    chmodSync(sshPath, 0o755);
    writeFileSync(
        scpPath,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const logPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
appendFileSync(logPath, JSON.stringify(['scp', ...process.argv.slice(2)]) + '\\n');
process.exit(0);
`,
        'utf8',
    );
    chmodSync(scpPath, 0o755);

    return {
        binDir,
        cleanup() {
            rmSync(rootDir, { recursive: true, force: true });
        },
        readInvocations() {
            const raw = readFileSync(logPath, 'utf8').trim();
            return raw ? raw.split('\n').map((line) => JSON.parse(line) as string[]) : [];
        },
    };
}

function withPatchedPath<T>(binDir: string, run: () => Promise<T>): Promise<T> {
    const previousPath = process.env.PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_SSH_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.HAPPIER_FAKE_SSH_STATE_PATH = join(binDir, '..', 'scenario.json');
    process.env.HAPPIER_FAKE_SSH_LOG_PATH = join(binDir, '..', 'invocations.log');
    return run().finally(() => {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
        if (previousStatePath === undefined) {
            delete process.env.HAPPIER_FAKE_SSH_STATE_PATH;
        } else {
            process.env.HAPPIER_FAKE_SSH_STATE_PATH = previousStatePath;
        }
        if (previousLogPath === undefined) {
            delete process.env.HAPPIER_FAKE_SSH_LOG_PATH;
        } else {
            process.env.HAPPIER_FAKE_SSH_LOG_PATH = previousLogPath;
        }
    });
}

describe('happier relay --json', () => {
    let home = '';
    let envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT',
        'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID',
    ]);

    beforeEach(async () => {
        envScope = createEnvKeyScope([
            'HAPPIER_HOME_DIR',
            'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT',
            'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID',
        ]);
        home = await createTempDir('happier-relay-json-');
        envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
        });
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
                args: ['relay', 'set', 'https://api.example.test', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'set', 'https://api.example.test', '--json'],
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
                args: ['relay', 'set', 'https://api.example.test', '--use', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'set', 'https://api.example.test', '--use', '--json'],
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
                args: ['relay', 'set', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'set', '--json'],
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
                args: ['relay', 'set', 'notaurl', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'set', 'notaurl', '--json'],
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
                    'set',
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
                    'set',
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
            expect(parsed.kind).toBe('relay_set');
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

    it('prints a JSON envelope for relay host status over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n` },
                { status: 0, stdout: `${JSON.stringify({ version: '1.2.3' })}\n` },
                { status: 0, stdout: 'enabled\nactive\nrunning\n' },
                { status: 0, stdout: 'yes\n' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'status', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'status', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_status');
            expect(parsed.data?.installed).toBe(true);
            expect(parsed.data?.version).toBe('1.2.3');
            expect(parsed.data?.service?.active).toBe(true);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('prints a JSON envelope for relay host install over ssh', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-1',
        });

        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n` },
                { status: 0, stdout: 'yes\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(parsed.data?.mode).toBe('user');
            expect(parsed.data?.relayUrl).toBe('http://127.0.0.1:3005');
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            envScope.patch({
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(payloadRoot);
        }
    });

    it('accepts --env overrides for relay host install over ssh', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-env-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-env-1',
        });

        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n` },
                { status: 0, stdout: 'yes\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
                { status: 0, stdout: '\n' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--env', 'HAPPIER_DB_PROVIDER=sqlite', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--env', 'HAPPIER_DB_PROVIDER=sqlite', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(parsed.data?.relayUrl).toBe('http://127.0.0.1:3005');
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            envScope.patch({
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(payloadRoot);
        }
    });
});
