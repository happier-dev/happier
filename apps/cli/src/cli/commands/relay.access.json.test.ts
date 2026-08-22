import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { commandRegistry } from '@/cli/commandRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { addServerProfile, getActiveServerProfile } from '@/server/serverProfiles';

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string }>[];
    expectedPassword?: string;
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
    readEnvSnapshots: () => ReadonlyArray<Readonly<Record<string, string | null>>>;
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
const recordEnv = process.env.HAPPIER_FAKE_SSH_RECORD_ENV === '1';
appendFileSync(logPath, JSON.stringify({
  argv,
  env: recordEnv ? {
    HAPPIER_SSH_PASSWORD: process.env.HAPPIER_SSH_PASSWORD ?? null,
    SSH_ASKPASS: process.env.SSH_ASKPASS ?? null,
    SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? null,
    DISPLAY: process.env.DISPLAY ?? null,
  } : null,
}) + '\\n');

const expectedPassword = ${JSON.stringify(scenario.expectedPassword ?? null)};
if (expectedPassword !== null) {
  if (process.env.HAPPIER_SSH_PASSWORD !== expectedPassword) {
    process.stderr.write('missing or mismatched HAPPIER_SSH_PASSWORD\\n');
    process.exit(42);
  }
  if (process.env.SSH_ASKPASS_REQUIRE !== 'force') {
    process.stderr.write('missing SSH_ASKPASS_REQUIRE\\n');
    process.exit(43);
  }
  if (!process.env.SSH_ASKPASS || !process.env.SSH_ASKPASS.includes('happier-ssh-askpass')) {
    process.stderr.write('missing SSH_ASKPASS\\n');
    process.exit(44);
  }
}

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
            return raw
                ? raw.split('\n').map((line) => {
                    const parsed = JSON.parse(line) as { argv?: string[] };
                    return Array.isArray(parsed.argv) ? parsed.argv : [];
                })
                : [];
        },
	        readEnvSnapshots() {
	            const raw = readFileSync(logPath, 'utf8').trim();
	            return raw
	                ? raw.split('\n').map((line) => {
	                    const parsed = JSON.parse(line) as { env?: Readonly<Record<string, string | null>> };
	                    return parsed.env ?? {};
	                })
	                : [];
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

if (argv[0] === 'serve' && argv.includes('--bg')) {
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

    it('enforces 0600 permissions on the persisted local relay access config file (even when it already exists)', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const configDir = join(home, 'relay', 'access');
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const configPath = join(configDir, 'local.json');
        writeFileSync(configPath, '{}\n', 'utf8');
        chmodSync(configPath, 0o644);

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.test', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.test', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            const mode = statSync(configPath).mode & 0o777;
            expect(mode).toBe(0o600);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('accepts --yes for relay access configure and persists localOnly config', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'configure', '--provider', 'localOnly', '--yes', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'localOnly', '--yes', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_configure');
            expect(parsed.data?.configured).toBe(true);
            expect(parsed.data?.providerId).toBe('localOnly');
            expect(parsed.data?.state).toBe('disabled');
            expect(parsed.data?.shareUrl).toBe(null);
            expect(parsed.data?.config).toEqual({ providerId: 'localOnly' });

            const persistedPath = join(home, 'relay', 'access', 'local.json');
            const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'));
            expect(persisted).toEqual({ providerId: 'localOnly' });
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('adopts a configured local share URL in the active relay profile', async () => {
        await addServerProfile({
            name: 'selfhost',
            serverUrl: 'https://old-relay.example.test',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'https://old-app.example.test',
            use: true,
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.example.test', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'lan', '--url', 'https://relay.lan.example.test', '--json'],
                terminalRuntime: null,
            });

            const active = await getActiveServerProfile();
            expect(active.serverUrl).toBe('https://relay.lan.example.test');
            expect(active.localServerUrl).toBe('http://127.0.0.1:3005');

            await commandRegistry.relay({
                args: ['relay', 'access', 'disable', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'disable', '--json'],
                terminalRuntime: null,
            });
            const afterDisable = await getActiveServerProfile();
            expect(afterDisable.serverUrl).toBe('http://127.0.0.1:3005');
            expect(afterDisable.localServerUrl).toBeUndefined();
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

    it('does not overwrite an active relay profile changed after access was configured', async () => {
        await addServerProfile({
            name: 'selfhost',
            serverUrl: 'https://user-selected.example.test',
            localServerUrl: 'http://127.0.0.1:3005',
            webappUrl: 'https://user-selected.example.test',
            use: true,
        });
        const persistedPath = join(home, 'relay', 'access', 'local.json');
        mkdirSync(join(home, 'relay', 'access'), { recursive: true });
        writeFileSync(persistedPath, JSON.stringify({ providerId: 'lan', url: 'https://old-provider.example.test' }), 'utf8');

        const output = captureConsoleLogAndMuteStdout();
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'disable', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'disable', '--json'],
                terminalRuntime: null,
            });

            const active = await getActiveServerProfile();
            expect(active.serverUrl).toBe('https://user-selected.example.test');
            expect(active.localServerUrl).toBe('http://127.0.0.1:3005');
        } finally {
            output.restore();
        }
    });

    it('accepts --yes for relay access disable', async () => {
        const persistedPath = join(home, 'relay', 'access', 'local.json');
        mkdirSync(join(home, 'relay', 'access'), { recursive: true });
        writeFileSync(persistedPath, JSON.stringify({ providerId: 'localOnly' }), 'utf8');

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await commandRegistry.relay({
                args: ['relay', 'access', 'disable', '--yes', '--json'],
                rawArgv: ['node', 'happier', 'relay', 'access', 'disable', '--yes', '--json'],
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
                ['serve', 'status'],
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
                ['serve', 'status'],
                ['status', '--json'],
            ]);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeTailscale.cleanup();
        }
    });

    it('uses an active loopback server URL as the relay-access upstream', async () => {
        const relayEnvScope = createEnvKeyScope([
            'HAPPIER_SERVER_URL',
            'HAPPIER_LOCAL_SERVER_URL',
            'HAPPIER_PUBLIC_SERVER_URL',
            'HAPPIER_ACTIVE_SERVER_ID',
            'HAPPIER_WEBAPP_URL',
        ]);
        relayEnvScope.patch({
            HAPPIER_SERVER_URL: undefined,
            HAPPIER_LOCAL_SERVER_URL: undefined,
            HAPPIER_PUBLIC_SERVER_URL: undefined,
            HAPPIER_ACTIVE_SERVER_ID: undefined,
            HAPPIER_WEBAPP_URL: undefined,
        });
        const now = Date.now();
        writeFileSync(join(home, 'settings.json'), JSON.stringify({
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'selfhost',
            servers: {
                selfhost: {
                    id: 'selfhost',
                    name: 'selfhost',
                    serverUrl: 'http://127.0.0.1:3005',
                    webappUrl: 'http://127.0.0.1:3005',
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: now,
                },
            },
        }), 'utf8');
        reloadConfiguration();

        const fakeTailscale = createFakeTailscale({
            statusJson: {
                BackendState: 'NeedsLogin',
                AuthURL: 'https://login.tailscale.com/a/example',
                Self: {},
                CurrentTailnet: {},
                TailscaleIPs: [],
            },
        });

        try {
            await withPatchedPath(fakeTailscale.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'configure', '--provider', 'tailscaleServe'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'configure', '--provider', 'tailscaleServe'],
                    terminalRuntime: null,
                });
            });

            expect(fakeTailscale.readInvocations()).toContainEqual([
                'serve',
                '--bg',
                'http://127.0.0.1:3005',
            ]);
        } finally {
            fakeTailscale.cleanup();
            relayEnvScope.restore();
            reloadConfiguration();
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

    it('trusts the SSH host key (app-managed known_hosts) before reading relay access config when --known-hosts-path and --yes are provided', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const knownHostsRoot = mkdtempSync(join(tmpdir(), 'happier-relay-access-known-hosts-'));
        const knownHostsPath = join(knownHostsRoot, 'known_hosts');

        const keyscanPath = join(fakeSsh.binDir, 'ssh-keyscan');
        writeFileSync(
            keyscanPath,
            '#!/usr/bin/env bash\nset -eu\necho \"example.test ssh-ed25519 AAAANEW\"\n',
            'utf8',
        );
        chmodSync(keyscanPath, 0o755);

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@example.test',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--yes',
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@example.test',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--yes',
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);

            expect(readFileSync(knownHostsPath, 'utf8')).toContain('example.test ssh-ed25519 AAAANEW');
            const invocations = fakeSsh.readInvocations();
            expect(invocations[0]?.join(' ')).toContain(`UserKnownHostsFile=${knownHostsPath}`);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            rmSync(knownHostsRoot, { recursive: true, force: true });
        }
    });

    it('supports password auth when reading relay access config over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        const previousPassword = process.env.HAPPIER_SSH_PASSWORD;
        process.exitCode = undefined;
        process.env.HAPPIER_SSH_PASSWORD = 'super-secret-password';
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-auth', 'password', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-auth', 'password', '--json'],
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
            expect(output.logs.join('\n')).not.toContain('super-secret-password');

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0]?.includes('dev@example.test')).toBe(true);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            if (previousPassword === undefined) {
                delete process.env.HAPPIER_SSH_PASSWORD;
            } else {
                process.env.HAPPIER_SSH_PASSWORD = previousPassword;
            }
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

    it('supports --ssh-config-file when scanning host keys for relay access status over ssh', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: 'hostname 127.0.0.1\nport 53621\n' },
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const knownHostsRoot = mkdtempSync(join(tmpdir(), 'happier-relay-access-known-hosts-'));
        const knownHostsPath = join(knownHostsRoot, 'known_hosts');

        const keyscanPath = join(fakeSsh.binDir, 'ssh-keyscan');
        writeFileSync(
            keyscanPath,
            `#!/usr/bin/env bash
set -eu
if [[ "$*" != *"-p 53621"* ]]; then
  echo "missing expected port flag" >&2
  exit 1
fi
if [[ "$*" != *"127.0.0.1"* ]]; then
  echo "missing expected host" >&2
  exit 1
fi
if [[ "$*" == *"lima-alias"* ]]; then
  echo "unexpected alias host in keyscan args" >&2
  exit 1
fi
echo "[127.0.0.1]:53621 ssh-ed25519 AAAATESTKEY"
`,
            'utf8',
        );
        chmodSync(keyscanPath, 0o755);

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@lima-alias',
                        '--ssh-config-file',
                        '/tmp/ssh.config',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--yes',
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@lima-alias',
                        '--ssh-config-file',
                        '/tmp/ssh.config',
                        '--known-hosts-path',
                        knownHostsPath,
                        '--yes',
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_status');
            expect(parsed.data?.configured).toBe(true);
            expect(parsed.data?.providerId).toBe('lan');
            expect(parsed.data?.shareUrl).toBe('https://relay.remote.lan.test');

            const invocations = fakeSsh.readInvocations().map((args) => args.join(' '));
            expect(invocations.some((invocation) => invocation.includes('-G'))).toBe(true);
            expect(invocations.some((invocation) => invocation.includes('-F /tmp/ssh.config'))).toBe(true);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            rmSync(knownHostsRoot, { recursive: true, force: true });
        }
    });

    it('supports --ssh-port when reading relay access config over ssh', async () => {
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
                    args: ['relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-port', '2222', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'access', 'status', '--ssh', 'dev@example.test', '--ssh-port', '2222', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            const argv = invocations[0] ?? [];
            expect(argv.includes('-p')).toBe(true);
            expect(argv.includes('2222')).toBe(true);
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
            expect(args.join(' ')).toContain('mkdir -p ~/.happier/relay/access');
            expect(args.join(' ')).toContain('chmod 600 ~/.happier/relay/access/local.json');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('does not forward local tailscale bin overrides into ssh relay access status', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'tailscaleServe' })}\n` },
                { status: 0, stdout: '/usr/bin/tailscale\n' },
                {
                    status: 0,
                    stdout: `${JSON.stringify({
                        BackendState: 'NeedsLogin',
                        AuthURL: 'https://login.tailscale.com/a/example',
                        Self: {},
                        CurrentTailnet: {},
                        TailscaleIPs: [],
                    })}\n`,
                },
            ],
        });

        const envScope = createEnvKeyScope(['HAPPIER_STACK_TAILSCALE_BIN']);
        envScope.patch({ HAPPIER_STACK_TAILSCALE_BIN: '/Applications/Tailscale.app/Contents/MacOS/tailscale' });

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
            expect(parsed.data?.providerId).toBe('tailscaleServe');
            expect(parsed.data?.state).toBe('needs_auth');

            const invocations = fakeSsh.readInvocations().map((argv) => argv.join(' '));
            expect(invocations.some((invocation) => invocation.includes('command -v'))).toBe(true);
            expect(invocations.some((invocation) => invocation.includes('tailscale'))).toBe(true);
            expect(invocations.some((invocation) => invocation.includes('/Applications/Tailscale.app/Contents/MacOS'))).toBe(false);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            envScope.restore();
            fakeSsh.cleanup();
        }
    });

    it('supports password auth over ssh without leaking the password into argv', async () => {
        const fakeSsh = createFakeSsh({
            expectedPassword: 'super-secret',
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ providerId: 'lan', url: 'https://relay.remote.lan.test' })}\n` },
            ],
        });

        const previousPassword = process.env.HAPPIER_SSH_PASSWORD;
        process.env.HAPPIER_SSH_PASSWORD = 'super-secret';

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: [
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@example.test',
                        '--ssh-auth',
                        'password',
                        '--json',
                    ],
                    rawArgv: [
                        'node',
                        'happier',
                        'relay',
                        'access',
                        'status',
                        '--ssh',
                        'dev@example.test',
                        '--ssh-auth',
                        'password',
                        '--json',
                    ],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_access_status');
            expect(parsed.data?.configured).toBe(true);
            expect(parsed.data?.providerId).toBe('lan');
            expect(output.logs.join('\n')).not.toContain('super-secret');

            const invocations = fakeSsh.readInvocations();
            expect(invocations.length).toBe(1);
            const args = invocations[0] ?? [];
            expect(args.join(' ')).toContain('BatchMode=no');
            expect(args.join(' ')).not.toContain('super-secret');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
            if (previousPassword === undefined) {
                delete process.env.HAPPIER_SSH_PASSWORD;
            } else {
                process.env.HAPPIER_SSH_PASSWORD = previousPassword;
            }
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
