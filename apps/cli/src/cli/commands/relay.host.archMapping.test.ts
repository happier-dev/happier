import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

type PreparedPayload = Readonly<{
    componentId: string;
    channel: string;
    versionId: string;
    payloadRoot: string;
    source: string | null;
    cleanup: () => Promise<void>;
}>;

let preparedRoots: string[] = [];

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        prepareFirstPartyComponentPayloadFromGitHubRelease: async (params: Readonly<{
            componentId: string;
            channel: string;
            os: string;
            arch: string;
        }>): Promise<PreparedPayload> => {
            const arch = String(params.arch ?? '').trim() || 'unknown';
            const rootDir = mkdtempSync(join(tmpdir(), `happier-first-party-mock-${arch}-`));
            preparedRoots.push(rootDir);
            for (const name of ['happier', 'happier-server']) {
                const binPath = join(rootDir, name);
                writeFileSync(binPath, '#!/usr/bin/env bash\necho stub\n', 'utf8');
                chmodSync(binPath, 0o755);
            }
            return {
                componentId: params.componentId,
                channel: params.channel,
                versionId: `mock-${arch}`,
                payloadRoot: rootDir,
                source: null,
                cleanup: async () => undefined,
            };
        },
    };
});

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

describe('happier relay host arch resolution', () => {
    let home = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeEach(async () => {
        preparedRoots = [];
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-host-arch-');
        envScope.patch({
            HAPPIER_HOME_DIR: home,
        });
    });

    afterEach(async () => {
        envScope.restore();
        await removeTempDir(home);
        await Promise.all(preparedRoots.map(async (dir) => {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }));
        preparedRoots = [];
    });

    it('treats remote aarch64 as arm64 when preparing the server payload', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 0, stdout: `${JSON.stringify({ platform: 'linux', arch: 'aarch64' })}\n` },
                { status: 0, stdout: 'yes\n' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            const { commandRegistry } = await import('@/cli/commandRegistry');
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const invocations = fakeSsh.readInvocations();
            const scpCall = invocations.find((entry) => entry[0] === 'scp');
            expect(scpCall).toBeTruthy();
            const stagedPayloadRoot = (scpCall ?? []).find((entry) => entry.includes('happier-first-party-mock-')) ?? '';
            expect(stagedPayloadRoot).toContain('happier-first-party-mock-arm64-');

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });

    it('surfaces SSH stderr when remote target resolution fails', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                { status: 255, stdout: '', stderr: 'ssh: Could not resolve hostname example.test: Name or service not known\n' },
            ],
        });

        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            const { commandRegistry } = await import('@/cli/commandRegistry');
            expect(commandRegistry.relay).toBeDefined();

            await withPatchedPath(fakeSsh.binDir, async () => {
                await commandRegistry.relay({
                    args: ['relay', 'host', 'status', '--ssh', 'dev@example.test', '--json'],
                    rawArgv: ['node', 'happier', 'relay', 'host', 'status', '--ssh', 'dev@example.test', '--json'],
                    terminalRuntime: null,
                });
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(false);
            expect(String(parsed.error?.message ?? '')).toContain('Could not resolve hostname');
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
            fakeSsh.cleanup();
        }
    });
});
