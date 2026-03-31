import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { commandRegistry } from '@/cli/commandRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { addServerProfile } from '@/server/serverProfiles';

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-relay-access-fake-ssh-'));
    const binDir = join(rootDir, 'bin');
    const sshPath = join(binDir, 'ssh');
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

function createFakeTailscale(scenario: Readonly<{
    statusJson?: unknown;
    serveStatusText?: string;
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-relay-access-fake-tailscale-'));
    const binDir = join(rootDir, 'bin');
    const tailscalePath = join(binDir, 'tailscale');
    const logPath = join(rootDir, 'invocations.log');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(
        tailscalePath,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + '\\n');

if (argv[0] === 'status' && argv[1] === '--json') {
  process.stdout.write(${JSON.stringify(JSON.stringify(scenario.statusJson ?? {}))} + '\\n');
  process.exit(0);
}

if (argv[0] === 'serve' && argv[1] === 'status') {
  process.stdout.write(${JSON.stringify(String(scenario.serveStatusText ?? ''))});
  process.exit(0);
}

process.stderr.write('unsupported tailscale invocation: ' + argv.join(' ') + '\\n');
process.exit(2);
`,
        'utf8',
    );
    chmodSync(tailscalePath, 0o755);

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

describe('happier relay access --json', () => {
    let home = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeEach(async () => {
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-access-');
        envScope.patch({
            HAPPIER_HOME_DIR: home,
        });
        reloadConfiguration();
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        if (home) {
            await removeTempDir(home);
        }
        process.exitCode = undefined;
    });

    it('reports disabled status when no relay access config is present', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'status', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'status', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_status');
            expect(parsed.data?.configured).toBe(false);
            expect(parsed.data?.providerId).toBe(null);
            expect(parsed.data?.state).toBe('disabled');
            expect(parsed.data?.shareUrl).toBe(null);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('configures the LAN access provider and persists it under ~/.happier/relay/access/local.json', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.example.test', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.example.test', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.configured).toBe(true);
            expect(parsed.data?.providerId).toBe('lan');
            expect(parsed.data?.state).toBe('enabled');
            expect(parsed.data?.shareUrl).toBe('https://relay.lan.example.test');
            expect(parsed.data?.config).toEqual({ providerId: 'lan', url: 'https://relay.lan.example.test' });

            const persistedPath = join(home, 'relay', 'access', 'local.json');
            const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'));
            expect(persisted).toEqual({ providerId: 'lan', url: 'https://relay.lan.example.test' });
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('disables relay access by removing the persisted config file', async () => {
        const persistedPath = join(home, 'relay', 'access', 'local.json');
        mkdirSync(join(home, 'relay', 'access'), { recursive: true });
        writeFileSync(persistedPath, JSON.stringify({ providerId: 'lan', url: 'https://relay.lan.example.test' }), 'utf8');

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'disable', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'disable', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_disable');
            expect(parsed.data?.configured).toBe(false);
            expect(parsed.data?.state).toBe('disabled');
            expect(process.exitCode).toBe(0);

            expect(() => readFileSync(persistedPath, 'utf8')).toThrow();
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('returns invalid_arguments for unknown relay access providers', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'configure', '--provider', 'not-a-provider', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'not-a-provider', '--json'],
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

    it('configures tailscaleServe locally and reports needs_auth when the tailscale client is not logged in', async () => {
        const fakeTailscale = createFakeTailscale({
            statusJson: {
                BackendState: 'NeedsLogin',
                AuthURL: 'https://login.tailscale.com/a/example',
                Self: {},
                CurrentTailnet: {},
                TailscaleIPs: [],
            },
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeTailscale.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'configure', '--provider', 'tailscaleServe', '--upstream-url', 'http://127.0.0.1:3005', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'tailscaleServe', '--upstream-url', 'http://127.0.0.1:3005', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.providerId).toBe('tailscaleServe');
            expect(parsed.data?.state).toBe('needs_auth');
            expect(parsed.data?.shareUrl).toBe(null);

            const invocations = fakeTailscale.readInvocations();
            expect(invocations).toEqual([
                ['serve', '--bg', 'http://127.0.0.1:3005'],
                ['status', '--json'],
            ]);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeTailscale.cleanup();
        }
    });

    it('infers the upstream url from the active local relay profile when none is passed explicitly', async () => {
        await addServerProfile({
            name: 'selfhost',
            serverUrl: 'https://stack.example.test',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'https://app.example.test',
            use: true,
        });

        const fakeTailscale = createFakeTailscale({
            statusJson: {
                BackendState: 'NeedsLogin',
                AuthURL: 'https://login.tailscale.com/a/example',
                Self: {},
                CurrentTailnet: {},
                TailscaleIPs: [],
            },
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeTailscale.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'configure', '--provider', 'tailscaleServe', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'tailscaleServe', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.providerId).toBe('tailscaleServe');
            expect(parsed.data?.state).toBe('needs_auth');
            expect(parsed.data?.shareUrl).toBe(null);

            const invocations = fakeTailscale.readInvocations();
            expect(invocations).toEqual([
                ['serve', '--bg', 'http://127.0.0.1:3005'],
                ['status', '--json'],
            ]);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeTailscale.cleanup();
        }
    });

    it('redacts cloudflare named-tunnel secrets in JSON output', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: [
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test',
                    '--token',
                    'super-secret-token',
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'happier',
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test',
                    '--token',
                    'super-secret-token',
                    '--json',
                ],
                terminalRuntime: null,
            });

            const text = output.logs.join('\n').trim();
            expect(text).not.toContain('super-secret-token');
            const parsed = JSON.parse(text);
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.providerId).toBe('cloudflareNamed');
            expect(parsed.data?.config?.token).toBeUndefined();
            expect(parsed.data?.shareUrl).toBe('https://relay.example.test');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('rejects newline-separated hostname and token values', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: [
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test\ninvalid',
                    '--token',
                    'super-secret-token',
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'happier',
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test\ninvalid',
                    '--token',
                    'super-secret-token',
                    '--json',
                ],
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

    it('rejects newline-separated token values', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: [
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test',
                    '--token',
                    'super-secret-token\ninvalid',
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'happier',
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'cloudflareNamed',
                    '--hostname',
                    'relay.example.test',
                    '--token',
                    'super-secret-token\ninvalid',
                    '--json',
                ],
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

    it('supports reading relay access config over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'status', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'status', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_status');
            expect(parsed.data?.configured).toBe(true);
            expect(parsed.data?.providerId).toBe('lan');
            expect(parsed.data?.state).toBe('enabled');
            expect(parsed.data?.shareUrl).toBe('https://relay.remote.lan.test');

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0]?.includes('dev@example.test')).toBe(true);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('supports --ssh-config-file when reading relay access config over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-config-file', '/tmp/ssh.config', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-config-file', '/tmp/ssh.config', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            const args = invocations[0] ?? [];
            expect(args.includes('-F')).toBe(true);
            expect(args.includes('/tmp/ssh.config')).toBe(true);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('supports configuring relay access over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [{ status: 0, stdout: '' }],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'access',
                        'configure',
                        '--ssh',
                        'dev@example.test',
                        '--provider',
                        'lan',
                        '--url',
                        'https://relay.remote.lan.test',
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'access',
                        'configure',
                        '--ssh',
                        'dev@example.test',
                        '--provider',
                        'lan',
                        '--url',
                        'https://relay.remote.lan.test',
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.providerId).toBe('lan');
            expect(parsed.data?.state).toBe('enabled');
            expect(parsed.data?.shareUrl).toBe('https://relay.remote.lan.test');

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            const args = invocations[0] ?? [];
            expect(args.includes('dev@example.test')).toBe(true);
            expect(args.join(' ')).toContain('relay/access/local.json');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('rejects unknown configure arguments', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: [
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'lan',
                    '--url',
                    'https://relay.remote.lan.test',
                    '--unexpected',
                    'value',
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'happier',
                    'relay',
                    'access',
                    'configure',
                    '--provider',
                    'lan',
                    '--url',
                    'https://relay.remote.lan.test',
                    '--unexpected',
                    'value',
                    '--json',
                ],
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
});
