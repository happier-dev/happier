import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RemoteBootstrapMachineParams } from '@happier-dev/cli-common/systemTasks';
import { installRemoteFirstPartyComponent } from '@happier-dev/cli-common/systemTasks';
import { describe, expect, it, vi } from 'vitest';

import {
    installRemoteCliDefault,
    approveLocalRemoteAuthRequestDefault,
    createRemoteEnrollmentExecutorDefault,
    resolveRemoteSshHostTrustDefault,
    runRemoteBootstrapCommandDefault,
} from './remoteSshBootstrapTasks.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string; signal?: 'SIGTERM' }>[];
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-fake-ssh-'));
    const binDir = join(rootDir, 'bin');
    const sshPath = join(binDir, 'ssh');
    const scpPath = join(binDir, 'scp');
    const statePath = join(rootDir, 'scenario.json');
    const logPath = join(rootDir, 'invocations.log');

    writeFileSync(
        statePath,
        JSON.stringify({
            outputs: scenario.outputs ?? [],
        }),
        'utf8',
    );
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
if (next.signal) {
    process.stdout.write('', () => process.kill(process.pid, next.signal));
} else {
process.exit(Number(next.status ?? 0));
}
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

function createFakeSshKeyscan(scenario: Readonly<{
    status?: number;
    stdout?: string;
    stderr?: string;
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-fake-keyscan-'));
    const binDir = join(rootDir, 'bin');
    const keyscanPath = join(binDir, 'ssh-keyscan');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
        keyscanPath,
        `#!/usr/bin/env node
const scenario = ${JSON.stringify({
    status: scenario.status ?? 0,
    stdout: scenario.stdout ?? '',
    stderr: scenario.stderr ?? '',
})};
if (scenario.stdout) process.stdout.write(String(scenario.stdout));
if (scenario.stderr) process.stderr.write(String(scenario.stderr));
process.exit(Number(scenario.status ?? 0));
`,
        'utf8',
    );
    chmodSync(keyscanPath, 0o755);

    return {
        binDir,
        cleanup() {
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
}

function createParsedRemoteBootstrapParams(channel: 'stable' | 'preview' | 'dev' = 'stable'): RemoteBootstrapMachineParams {
    return {
        ssh: {
            target: 'dev@example.test',
            auth: 'agent',
        },
        relay: {
            relayUrl: 'https://relay.example.test',
        },
        channel,
    };
}

describe('resolveRemoteSshHostTrustDefault', () => {
    it('prompts to replace a mismatched persisted host key instead of trusting the host implicitly', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hsetup-known-hosts-'));
        const knownHostsPath = join(tempDir, 'known_hosts');
        const fakeKeyscan = createFakeSshKeyscan({
            stdout: `${SCANNED_HOST_KEY}\n`,
        });

        writeFileSync(knownHostsPath, `${DIFFERENT_HOST_KEY}\n`, 'utf8');

        try {
            await withPatchedPath(fakeKeyscan.binDir, async () => {
                const resolution = await resolveRemoteSshHostTrustDefault({
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                        knownHostsPath,
                    },
                    knownHostsMode: 'app',
                });

                expect(resolution.status).toBe('prompt');
                if (resolution.status !== 'prompt') {
                    throw new Error('Expected an SSH trust prompt.');
                }
                expect(resolution.promptKind).toBe('ssh.replaceHostKey');
                expect(resolution.promptData).toEqual({
                    host: 'example.test',
                    keyType: 'ssh-ed25519',
                    fingerprint: expect.stringMatching(/^SHA256:/),
                    existingFingerprint: expect.stringMatching(/^SHA256:/),
                });

                await resolution.accept();

                expect(readFileSync(knownHostsPath, 'utf8').trim()).toBe(SCANNED_HOST_KEY);
            });
        } finally {
            fakeKeyscan.cleanup();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when an explicit trusted host key does not match the fresh scan result', async () => {
        const fakeKeyscan = createFakeSshKeyscan({
            stdout: `${SCANNED_HOST_KEY}\n`,
        });

        try {
            await withPatchedPath(fakeKeyscan.binDir, async () => {
                await expect(resolveRemoteSshHostTrustDefault({
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                        trustedHostKey: DIFFERENT_HOST_KEY,
                    },
                    knownHostsMode: 'app',
                })).rejects.toThrow(/trusted host key/i);
            });
        } finally {
            fakeKeyscan.cleanup();
        }
    });
});

describe('installRemoteCliDefault', () => {
    it('rejects cancelled setup before the real installer probes the remote host', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(installRemoteCliDefault({
            parsed: createParsedRemoteBootstrapParams(), auth: { mode: 'agent' }, knownHostsMode: 'system',
            signal: controller.signal,
        }, {
            installRemoteFirstPartyComponent: (params) => installRemoteFirstPartyComponent(params, {
                // Only the remote OS/network boundaries are replaced; installer admission is real.
                resolveRemoteReleaseTarget: async () => { throw new Error('Remote probe reached after cancellation'); },
                runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
                copyLocalDirectoryToRemote: async () => undefined,
            }),
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('delegates remote CLI installation to the shared first-party installer', async () => {
        const invocations: Array<Record<string, unknown>> = [];

        await installRemoteCliDefault({
            parsed: createParsedRemoteBootstrapParams(),
            auth: { mode: 'agent' },
            knownHostsMode: 'system',
        }, {
            installRemoteFirstPartyComponent: async (params) => {
                invocations.push(params as Record<string, unknown>);
                return {
                    binaryPath: '$HOME/.happier/cli/current/happier',
                    versionId: '1.2.3',
                    source: 'https://example.test/happier.tgz',
                };
            },
        });

        expect(invocations).toEqual([
            expect.objectContaining({
                componentId: 'happier-cli',
                channel: 'stable',
                knownHostsMode: 'system',
            }),
        ]);
    });
});

describe('approveLocalRemoteAuthRequestDefault', () => {
    it('uses the selected release-ring local happier runner instead of depending on PATH resolution', async () => {
        const runLocalHappierJsonCommand = vi.fn(async (params: Readonly<{ args: readonly string[]; releaseRing?: string; stdinText?: string }>) => {
            expect(params.releaseRing).toBe('preview');
            expect(params.args).toEqual([
                'auth',
                'approve',
                '--public-key',
                'public-key-123',
                '--json',
                '--request-json-stdin',
                '--home-target-from-request-json',
            ]);
            expect(JSON.parse(String(params.stdinText))).toEqual({
                publicKey: 'public-key-123',
                pairing: { secretB64Url: 'pairing-secret', createdAtMs: 1, expiresAtMs: 2 },
                supportsTokenOnly: true,
                homeTarget: {
                    kind: 'https_url',
                    url: 'https://relay.example.test',
                },
            });
            return { success: true };
        });

        await approveLocalRemoteAuthRequestDefault({
            publicKey: 'public-key-123',
            pairing: { secretB64Url: 'pairing-secret', createdAtMs: 1, expiresAtMs: 2 },
            supportsTokenOnly: true,
            parsed: createParsedRemoteBootstrapParams('preview'),
        }, {
            runLocalHappierJsonCommand,
        });

        expect(runLocalHappierJsonCommand).toHaveBeenCalledTimes(1);
    });

    it('does not pass legacy --public-server-url when a public relay URL is supplied', async () => {
        const runLocalHappierJsonCommand = vi.fn(async (params: Readonly<{ args: readonly string[] }>) => {
            expect(params.args.join(' ')).not.toContain('--public-server-url=');
            expect(params.args).toEqual([
                'auth',
                'approve',
                '--public-key',
                'public-key-123',
                '--json',
                '--request-json-stdin',
                '--home-target-from-request-json',
            ]);
            expect(JSON.parse(String((params as { stdinText?: string }).stdinText))).toEqual({
                publicKey: 'public-key-123',
                homeTarget: {
                    kind: 'https_url',
                    url: 'https://public-relay.example.test',
                    localUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
            });
            return { success: true };
        });

        await approveLocalRemoteAuthRequestDefault({
            publicKey: 'public-key-123',
            parsed: {
                ...createParsedRemoteBootstrapParams(),
                relay: {
                    relayUrl: 'https://relay.example.test',
                    publicRelayUrl: 'https://public-relay.example.test',
                },
            },
        }, {
            runLocalHappierJsonCommand,
        });

        expect(runLocalHappierJsonCommand).toHaveBeenCalledTimes(1);
    });
});

describe('runRemoteBootstrapCommandDefault', () => {
    it('continues server selection after the clean-host CLI exits 1 with its signed-out envelope', async () => {
        const fakeSsh = createFakeSsh({ outputs: [
            { status: 1, stdout: `${JSON.stringify({ v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } })}\n` },
            { status: 0, stdout: `${JSON.stringify({ v: 1, ok: true, kind: 'server_set', data: { active: { id: 'remote-home' } } })}\n` },
        ] });
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                const request = { parsed: createParsedRemoteBootstrapParams(), auth: { mode: 'agent' as const }, knownHostsMode: 'system' as const };
                expect(await runRemoteBootstrapCommandDefault({ ...request, label: 'auth.status' }))
                    .toEqual({ ok: true, data: { authenticated: false } });
                expect(await runRemoteBootstrapCommandDefault({ ...request, label: 'server.configure' }))
                    .toEqual({ ok: true, data: { active: { id: 'remote-home' } } });
            });
            expect(fakeSsh.readInvocations().map((args) => args.at(-1))).toEqual([
                expect.stringContaining('auth status --json'), expect.stringContaining('server set'),
            ]);
        } finally { fakeSsh.cleanup(); }
    });

    it.each([
        { name: 'transport failure with a signed-out envelope', status: 255, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
        { name: 'signal termination with a signed-out envelope', signal: 'SIGTERM' as const, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
        { name: 'unavailable auth at exit 0', status: 0, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'auth_status_unavailable' } } },
        { name: 'unavailable auth at exit 1', status: 1, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'auth_status_unavailable' } } },
        { name: 'missing envelope', status: 0, value: { authenticated: false } },
        { name: 'missing version', status: 0, value: { ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
        { name: 'malformed success', status: 0, value: { v: 1, ok: true, kind: 'auth_status', data: {} } },
        { name: 'success payload despite failed process', status: 1, value: { v: 1, ok: true, kind: 'auth_status', data: { authenticated: true } } },
        { name: 'signed-out response to server selection', status: 1, label: 'server.configure' as const, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
    ])('fails closed for $name before server selection', async ({ status, value, ...scenario }) => {
        const fakeSsh = createFakeSsh({ outputs: [{ status, stdout: `${JSON.stringify(value)}\n`, ...scenario }] });
        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                const result = await runRemoteBootstrapCommandDefault({
                    label: scenario.label ?? 'auth.status', parsed: createParsedRemoteBootstrapParams(), auth: { mode: 'agent' }, knownHostsMode: 'system',
                }).catch((error: unknown) => error);
                expect(result instanceof Error || (result as { ok?: boolean }).ok === false).toBe(true);
            });
            expect(fakeSsh.readInvocations()).toHaveLength(1);
        } finally { fakeSsh.cleanup(); }
    });

    it('uses the channel-specific managed CLI path instead of a hardcoded bin shim path', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ v: 1, ok: true, kind: 'auth_status', data: { authenticated: false } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await runRemoteBootstrapCommandDefault({
                    label: 'auth.status',
                    parsed: createParsedRemoteBootstrapParams('preview'),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                });
            });

            const remoteCommand = fakeSsh.readInvocations().at(-1)?.at(-1) ?? '';
            expect(remoteCommand).toContain('.happier/cli-preview/current/happier');
            expect(remoteCommand).toContain('auth status --json');
            expect(remoteCommand).not.toContain('$HOME/.happier/bin/happier');
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('does not pass legacy --public-server-url when configuring the remote server profile', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: `${JSON.stringify({ ok: true, data: { ok: true } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await runRemoteBootstrapCommandDefault({
                    label: 'server.configure',
                    parsed: {
                        ...createParsedRemoteBootstrapParams(),
                        relay: {
                            relayUrl: 'https://relay.example.test',
                            publicRelayUrl: 'https://public-relay.example.test',
                        },
                    },
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                });
            });

            const remoteCommand = fakeSsh.readInvocations().at(-1)?.at(-1) ?? '';
            expect(remoteCommand).toContain(' server set ');
            expect(remoteCommand).toContain('--server-url');
            expect(remoteCommand).toContain('https://public-relay.example.test');
            expect(remoteCommand).toContain('--local-server-url');
            expect(remoteCommand).toContain('https://relay.example.test');
            expect(remoteCommand).not.toContain('--public-server-url=');
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('passes data.localServerUrl as --local-server-url when configuring the remote server profile after installing a relay runtime', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: `${JSON.stringify({ ok: true, data: { ok: true } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await runRemoteBootstrapCommandDefault({
                    label: 'server.configure',
                    parsed: createParsedRemoteBootstrapParams(),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                    data: {
                        localServerUrl: 'http://127.0.0.1:3005',
                    },
                });
            });

            const remoteCommand = fakeSsh.readInvocations().at(-1)?.at(-1) ?? '';
            expect(remoteCommand).toContain('--server-url');
            expect(remoteCommand).toContain('https://relay.example.test');
            expect(remoteCommand).toContain('--local-server-url');
            expect(remoteCommand).toContain('http://127.0.0.1:3005');
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('runs remote enrollment through the hidden single-process command', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: `${JSON.stringify({ kind: 'remote_home_enrollment_result' })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                const executor = createRemoteEnrollmentExecutorDefault({
                    parsed: createParsedRemoteBootstrapParams(),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                });
                await executor.runHappierText(
                    ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
                    { input: JSON.stringify({ kind: 'https_url', url: 'https://relay.example.test' }) },
                );
            });

            const remoteCommand = fakeSsh.readInvocations().at(-1)?.at(-1) ?? '';
            expect(remoteCommand).toContain('auth');
            expect(remoteCommand).toContain('enroll-remote');
            expect(remoteCommand).toContain('--home-target-stdin');
            expect(remoteCommand).not.toMatch(/auth (?:request|wait)|--persist/u);
        } finally {
            fakeSsh.cleanup();
        }
    });
});
