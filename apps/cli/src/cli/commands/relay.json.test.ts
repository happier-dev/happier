import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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

const isRelayHostInstall = argv.some((part) => String(part).includes(' relay host install '));
const stdout = Number(next.status ?? 0) === 0 && isRelayHostInstall && !String(next.stdout ?? '').trim()
  ? JSON.stringify({
      v: 1,
      ok: true,
      kind: 'relay_host_install',
      data: { relayUrl: 'http://127.0.0.1:3005', mode: 'user' },
    }) + '\\n'
  : next.stdout;
if (stdout) process.stdout.write(String(stdout));
if (next.stderr) process.stderr.write(String(next.stderr));
process.exit(Number(next.status ?? 0));
`,
        'utf8',
    );
    chmodSync(sshPath, 0o755);
    writeFileSync(
        scpPath,
        `#!/usr/bin/env node
const { appendFileSync, cpSync } = require('node:fs');
const { basename, join } = require('node:path');

const logPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
const captureDir = process.env.HAPPIER_FAKE_SCP_CAPTURE_DIR;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(['scp', ...argv]) + '\\n');
if (captureDir) {
  const sourcePath = argv.length >= 2 ? argv[argv.length - 2] : '';
  if (sourcePath) {
    cpSync(sourcePath, join(captureDir, basename(sourcePath)), { recursive: true });
  }
}
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
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT',
        'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID',
        'HAPPIER_WEBAPP_URL',
    ]);

    beforeEach(async () => {
        envScope = createEnvKeyScope([
            'HAPPIER_HOME_DIR',
            'HAPPIER_PUBLIC_SERVER_URL',
            'HAPPIER_PUBLIC_RELEASE_CHANNEL',
            'HAPPIER_SERVER_URL',
            'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT',
            'HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID',
            'HAPPIER_WEBAPP_URL',
        ]);
        home = await createTempDir('happier-relay-json-');
        envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_PUBLIC_SERVER_URL: undefined,
            HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
            HAPPIER_SERVER_URL: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            HAPPIER_WEBAPP_URL: undefined,
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
                { status: 0, stdout: '/home/dev\n' },
                { status: 0, stdout: `${JSON.stringify({ version: '1.2.3' })}\n` },
                { status: 0, stdout: 'UnitFileState=enabled\nActiveState=active\nSubState=running\nLoadState=loaded\n' },
                { status: 0, stdout: 'yes\n' },
                { status: 0, stdout: '' },
                { status: 0, stdout: 'HAPPIER_RELAY_HEALTH_OK\n' },
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

    it('returns invalid_arguments for relay host status when the ssh target starts with an OpenSSH option', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'host', 'status', '--ssh', '-Fmalicious', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'host', 'status', '--ssh', '-Fmalicious', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.error?.code).toBe('invalid_arguments');
            expect(String(parsed.error?.message ?? '')).toContain('target must not start with "-"');
            expect(process.exitCode).toBe(1);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('reports relayUrl as null when relay host status over ssh is not installed', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n` },
                { status: 0, stdout: '/home/dev\n' },
                { status: 0, stdout: '' },
                { status: 0, stdout: 'UnitFileState=disabled\nActiveState=inactive\nSubState=dead\nLoadState=not-found\n' },
                { status: 0, stdout: 'no\n' },
                { status: 0, stdout: '' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
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
            expect(parsed.data?.installed).toBe(false);
            expect(parsed.data?.relayUrl).toBeNull();
            expect(parsed.data?.version).toBeNull();
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

    it('seeds the trusted SSH host key into the app-managed known_hosts file before relay host install over ssh', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-known-hosts-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-known-hosts-1',
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
        const knownHostsRoot = mkdtempSync(join(tmpdir(), 'happier-relay-host-known-hosts-'));
        const knownHostsPath = join(knownHostsRoot, 'known_hosts');
        const trustedHostKey = 'example.test ssh-ed25519 AAAANEW';

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'host',
                        'install',
                        '--ssh',
                        'dev@example.test',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--trusted-host-key',
                        trustedHostKey,
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'host',
                        'install',
                        '--ssh',
                        'dev@example.test',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--trusted-host-key',
                        trustedHostKey,
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(readFileSync(knownHostsPath, 'utf8')).toContain(trustedHostKey);
            const invocations = fakeSsh.readInvocations().map((invocation) => invocation.join(' '));
            expect(invocations.some((invocation) => invocation.includes(`UserKnownHostsFile=${knownHostsPath}`))).toBe(true);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            rmSync(knownHostsRoot, { recursive: true, force: true });
            envScope.patch({
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(payloadRoot);
        }
    });

    it('defaults relay host install to the current CLI release lane when --channel is omitted', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-preview-default-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-preview-default-1',
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
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'hprev', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');

            const invocations = fakeSsh.readInvocations().map((invocation) => invocation.join(' '));
            expect(invocations.some((invocation) => invocation.includes('relay host install') && invocation.includes('preview'))).toBe(true);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            envScope.patch({
                HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(payloadRoot);
        }
    });

    it('does not require GitHub when relay host install provides --server-binary', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await commandRegistry.relay({
                args: ['relay', 'host', 'install', '--server-binary', '/tmp/does-not-exist', '--env', 'PORT=43117', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--server-binary', '/tmp/does-not-exist', '--env', 'PORT=43117', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.kind).toBe('relay_host');
            expect(parsed.error?.code).toBe('unknown_error');
            expect(String(parsed.error?.message ?? '')).toContain('relay binary not found');
            expect(process.exitCode).toBe(2);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('reconciles the active server profile to the installed local relay after relay host install', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-local-profile-');
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);

        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
        });

        const relayUrl = 'http://127.0.0.1:3005';
        vi.resetModules();
        vi.doMock('@happier-dev/cli-common/relayHost', () => ({
            createRelayHostEngine: () => ({
                readStatus: async () => ({
                    installed: true,
                    version: '0.2.4',
                    service: { active: true, enabled: true },
                    baseUrl: relayUrl,
                    healthy: true,
                }),
                installOrUpdate: async () => ({
                    relayUrl,
                    mode: 'user',
                }),
                control: async () => undefined,
            }),
        }));

        const { commandRegistry: freshCommandRegistry } = await import('@/cli/commandRegistry');

        const installOutput = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await freshCommandRegistry.relay({
                args: ['relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--json'],
                rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--json'],
                terminalRuntime: null,
            });

            const installParsed = JSON.parse(installOutput.logs.join('\n').trim());
            expect(installParsed.ok).toBe(true);
            expect(installParsed.kind).toBe('relay_host_install');
            expect(installParsed.data?.relayUrl).toBe(relayUrl);
            expect(process.exitCode).toBe(0);
        } finally {
            installOutput.restore();
            process.exitCode = prevExitCode;
        }

        const currentOutput = captureConsoleLogAndMuteStdout();
        const currentPrevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await freshCommandRegistry.server({
                args: ['server', 'current', '--json'],
                rawArgv: ['node', 'happier', 'server', 'current', '--json'],
                terminalRuntime: null,
            });

            const currentParsed = JSON.parse(currentOutput.logs.join('\n').trim());
            expect(currentParsed.ok).toBe(true);
            expect(currentParsed.kind).toBe('server_current');
            expect(currentParsed.data?.active?.serverUrl).toBe(relayUrl);
            expect(currentParsed.data?.active?.id).not.toBe('cloud');
            expect(process.exitCode).toBe(0);
        } finally {
            currentOutput.restore();
            process.exitCode = currentPrevExitCode;
            vi.unmock('@happier-dev/cli-common/relayHost');
            vi.resetModules();
        }
        await removeTempDir(payloadRoot);
    });

    it('preserves the active server profile when relay host install uses --preserve-active-server', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-preserve-active-profile-');
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);

        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
        });

        const relayUrl = 'http://127.0.0.1:3005';
        vi.resetModules();
        const { getActiveServerProfile, listServerProfiles } = await import('@/server/serverProfiles');
        const activeBeforeInstall = await getActiveServerProfile();
        vi.doMock('@happier-dev/cli-common/relayHost', () => ({
            createRelayHostEngine: () => ({
                readStatus: async () => ({
                    installed: true,
                    version: '0.2.4',
                    service: { active: true, enabled: true },
                    baseUrl: relayUrl,
                    healthy: true,
                }),
                installOrUpdate: async () => ({
                    relayUrl,
                    mode: 'user',
                }),
                control: async () => undefined,
            }),
        }));

        const { commandRegistry: freshCommandRegistry } = await import('@/cli/commandRegistry');

        const installOutput = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await freshCommandRegistry.relay({
                args: ['relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--preserve-active-server', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--preserve-active-server', '--json'],
                terminalRuntime: null,
            });

            const installParsed = JSON.parse(installOutput.logs.join('\n').trim());
            expect(installParsed.ok).toBe(true);
            expect(installParsed.kind).toBe('relay_host_install');
            expect(installParsed.data?.relayUrl).toBe(relayUrl);
            expect(process.exitCode).toBe(0);
        } finally {
            installOutput.restore();
            process.exitCode = prevExitCode;
        }

        const activeAfterInstall = await getActiveServerProfile();
        expect(activeAfterInstall.id).toBe(activeBeforeInstall.id);
        expect(activeAfterInstall.serverUrl).toBe(activeBeforeInstall.serverUrl);

        const profiles = await listServerProfiles();
        expect(profiles.some((profile) => profile.id !== activeBeforeInstall.id && profile.serverUrl === relayUrl)).toBe(true);

        vi.unmock('@happier-dev/cli-common/relayHost');
        vi.resetModules();
        await removeTempDir(payloadRoot);
    });

    it('preserves the authenticated public relay profile when local relay install runs through a tunnel', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-local-profile-tunnel-');
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);

        const localRelayUrl = 'http://127.0.0.1:3005';
        const publicRelayUrl = 'http://127.0.0.1:43005';
        envScope.patch({
            HAPPIER_PUBLIC_SERVER_URL: publicRelayUrl,
            HAPPIER_SERVER_URL: localRelayUrl,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            HAPPIER_WEBAPP_URL: publicRelayUrl,
        });

        vi.resetModules();
        const { addServerProfile } = await import('@/server/serverProfiles');
        await addServerProfile({
            name: 'local relay',
            serverUrl: localRelayUrl,
            webappUrl: localRelayUrl,
            use: false,
        });
        const publicProfile = await addServerProfile({
            name: 'preview tunnel',
            serverUrl: localRelayUrl,
            webappUrl: publicRelayUrl,
            use: true,
        });

        vi.resetModules();
        vi.doMock('@happier-dev/cli-common/relayHost', () => ({
            createRelayHostEngine: () => ({
                readStatus: async () => ({
                    installed: true,
                    version: '0.2.4',
                    service: { active: true, enabled: true },
                    baseUrl: localRelayUrl,
                    healthy: true,
                }),
                installOrUpdate: async () => ({
                    relayUrl: localRelayUrl,
                    mode: 'user',
                }),
                control: async () => undefined,
            }),
        }));

        const { commandRegistry: freshCommandRegistry } = await import('@/cli/commandRegistry');

        const installOutput = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await freshCommandRegistry.relay({
                args: ['relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--json'],
                rawArgv: ['node', 'hprev', 'relay', 'host', 'install', '--server-binary', join(payloadRoot, 'happier-server'), '--json'],
                terminalRuntime: null,
            });

            const installParsed = JSON.parse(installOutput.logs.join('\n').trim());
            expect(installParsed.ok).toBe(true);
            expect(installParsed.kind).toBe('relay_host_install');
            expect(process.exitCode).toBe(0);
        } finally {
            installOutput.restore();
            process.exitCode = prevExitCode;
            vi.unmock('@happier-dev/cli-common/relayHost');
        }

        const { getActiveServerProfile } = await import('@/server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(active.id).toBe(publicProfile.id);
        expect(active.serverUrl).toBe(publicRelayUrl);
        expect(active.localServerUrl).toBe(localRelayUrl);
        expect(active.webappUrl).toBe(publicRelayUrl);

        vi.resetModules();
        await removeTempDir(payloadRoot);
    });

    it('rejects the legacy --self-host-server-binary flag over ssh', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-legacy-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-legacy-1',
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
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--self-host-server-binary', '/tmp/relay', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--self-host-server-binary', '/tmp/relay', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.kind).toBe('relay_host');
            expect(parsed.error?.code).toBe('invalid_arguments');
            expect(process.exitCode).toBe(1);
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

    it('rejects --trusted-host-key for relay host install over ssh when --known-hosts-path is missing', async () => {
        const payloadRoot = await createTempDir('happier-first-party-payload-trusted-key-reject-');
        writeFileSync(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier'), 0o755);
        writeFileSync(join(payloadRoot, 'happier-server'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(payloadRoot, 'happier-server'), 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: payloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-trusted-key-reject-1',
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
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'host',
                        'install',
                        '--ssh',
                        'dev@example.test',
                        '--trusted-host-key',
                        'example.test ssh-ed25519 AAAANEW',
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'host',
                        'install',
                        '--ssh',
                        'dev@example.test',
                        '--trusted-host-key',
                        'example.test ssh-ed25519 AAAANEW',
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(parsed.kind).toBe('relay_host');
            expect(parsed.error?.code).toBe('invalid_arguments');
            expect(String(parsed.error?.message ?? '')).toContain('--known-hosts-path');
            expect(fakeSsh.readInvocations()).toHaveLength(0);
            expect(process.exitCode).toBe(1);
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

    it('uploads a local server-binary override payload when relay host install runs over ssh', async () => {
        const cliPayloadRoot = await createTempDir('happier-first-party-payload-cli-');
        const serverPayloadRoot = await createTempDir('happier-first-party-payload-server-');
        const serverBinaryPath = join(serverPayloadRoot, 'happier-server');
        writeFileSync(join(cliPayloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(cliPayloadRoot, 'happier'), 0o755);
        writeFileSync(serverBinaryPath, '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(serverBinaryPath, 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: cliPayloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-ssh-server-override-1',
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
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--server-binary', serverBinaryPath, '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--server-binary', serverBinaryPath, '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            const scpInvocations = fakeSsh.readInvocations().filter((invocation) => invocation[0] === 'scp');
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(parsed.data?.relayUrl).toBe('http://127.0.0.1:3005');
            expect(scpInvocations).toHaveLength(2);
            expect(scpInvocations.some((invocation) => invocation.some((part) => part.includes(`happier-server-${basename(serverPayloadRoot)}-`)))).toBe(true);
            expect(scpInvocations.some((invocation) => invocation.some((part) => part.includes('happier-server-test-ssh-server-override-1-')))).toBe(false);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            envScope.patch({
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(cliPayloadRoot);
            await removeTempDir(serverPayloadRoot);
        }
    });

    it('treats a --server-binary path inside bin/ as part of the parent payload root when relay host install runs over ssh', async () => {
        const cliPayloadRoot = await createTempDir('happier-first-party-payload-cli-');
        const serverPayloadRoot = await createTempDir('happier-first-party-payload-server-');
        const serverBinDir = join(serverPayloadRoot, 'bin');
        const serverBinaryPath = join(serverBinDir, 'happier-server');
        mkdirSync(serverBinDir, { recursive: true });
        writeFileSync(join(cliPayloadRoot, 'happier'), '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(join(cliPayloadRoot, 'happier'), 0o755);
        writeFileSync(serverBinaryPath, '#!/usr/bin/env bash\necho stub\n', 'utf8');
        chmodSync(serverBinaryPath, 0o755);
        envScope.patch({
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: cliPayloadRoot,
            HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: 'test-ssh-server-override-1',
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
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--server-binary', serverBinaryPath, '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--server-binary', serverBinaryPath, '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            const scpInvocations = fakeSsh.readInvocations().filter((invocation) => invocation[0] === 'scp');
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(scpInvocations).toHaveLength(2);
            expect(scpInvocations.some((invocation) => invocation.some((part) => part.includes(`happier-server-${basename(serverPayloadRoot)}-`)))).toBe(true);
            expect(scpInvocations.some((invocation) => invocation.some((part) => part.includes(`happier-server-${basename(serverBinDir)}-`)))).toBe(false);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            envScope.patch({
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_ROOT: undefined,
                HAPPIER_TEST_FIRST_PARTY_PAYLOAD_VERSION_ID: undefined,
            });
            await removeTempDir(cliPayloadRoot);
            await removeTempDir(serverPayloadRoot);
        }
    });

    it('prints a JSON envelope for relay host uninstall over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n` },
                { status: 0, stdout: '/home/remote-user\n' },
                { status: 0, stdout: '', stderr: '' },
                { status: 0, stdout: '', stderr: '' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'uninstall', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'uninstall', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_uninstall');
            expect(parsed.data?.ok).toBe(true);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });
});
