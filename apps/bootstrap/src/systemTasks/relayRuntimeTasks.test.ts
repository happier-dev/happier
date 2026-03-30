import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { preparePayloadMock, createRelayHostEngineMock } = vi.hoisted(() => ({
    preparePayloadMock: vi.fn(),
    createRelayHostEngineMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
    return {
        ...actual,
        prepareFirstPartyComponentPayloadFromGitHubRelease: preparePayloadMock,
    };
});

vi.mock('@happier-dev/cli-common/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/systemTasks')>();
    return {
        ...actual,
        createRelayHostEngine: (...args: unknown[]) => {
            createRelayHostEngineMock(...args);
            return actual.createRelayHostEngine(...(args as Parameters<typeof actual.createRelayHostEngine>));
        },
    };
});

import { installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';

afterEach(() => {
    vi.clearAllMocks();
});

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-relay-fake-ssh-'));
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

describe('installOrUpdateRelayRuntimeDefault', () => {
    it('installs the local relay runtime without requiring `hstack self-host install`', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-local-relay-runtime-install-'));
        const happyHomeDir = join(rootDir, '.happier-home');
        const fakeOsHomeDir = join(rootDir, '.home');
        const payloadRoot = join(rootDir, 'payload');
        const previousHomeDir = process.env.HAPPIER_HOME_DIR;
        const previousPath = process.env.PATH;
        const previousCwd = process.cwd();
        const previousHome = process.env.HOME;
        const previousUserProfile = process.env.USERPROFILE;

        try {
            mkdirSync(payloadRoot, { recursive: true });
            writeFileSync(
                join(payloadRoot, 'happier-server'),
                '#!/bin/sh\nexit 0\n',
                'utf8',
            );
            chmodSync(join(payloadRoot, 'happier-server'), 0o755);

            preparePayloadMock.mockImplementation(async ({ componentId }) => {
                if (componentId === 'hstack') {
                    throw new Error('unexpected hstack acquisition');
                }
                return {
                    versionId: '1.2.3',
                    payloadRoot,
                    cleanup: async () => {},
                };
            });

            process.env.HAPPIER_HOME_DIR = happyHomeDir;
            process.env.HOME = fakeOsHomeDir;
            process.env.USERPROFILE = fakeOsHomeDir;
            process.env.PATH = '';
            process.chdir(rootDir);

            await expect(installOrUpdateRelayRuntimeDefault({
                target: {
                    kind: 'local',
                },
                channel: 'stable',
                mode: 'user',
            }, {
                runLocalServiceCommands: false,
                skipLocalHealthCheck: true,
            })).resolves.toMatchObject({
                relayUrl: 'http://127.0.0.1:3005',
                mode: 'user',
            });

            expect(preparePayloadMock).toHaveBeenCalledWith(expect.objectContaining({
                componentId: 'happier-server',
            }));
            expect(createRelayHostEngineMock).toHaveBeenCalled();

            const installRoot = join(fakeOsHomeDir, '.happier', 'self-host');
            expect(readFileSync(join(installRoot, 'self-host-state.json'), 'utf8')).toContain('"version"');
            expect(readFileSync(join(installRoot, 'config', 'server.env'), 'utf8')).toContain('PORT=3005');
        } finally {
            if (previousHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHomeDir;
            }
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
            if (previousUserProfile === undefined) {
                delete process.env.USERPROFILE;
            } else {
                process.env.USERPROFILE = previousUserProfile;
            }
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
            process.chdir(previousCwd);
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('avoids piping the remote relay runtime installer over curl and bash', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: 'yes\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await installOrUpdateRelayRuntimeDefault({
                    target: {
                        kind: 'ssh',
                        ssh: {
                            target: 'dev@example.test',
                            auth: 'agent',
                        },
                    },
                    channel: 'stable',
                    mode: 'user',
                }, {}, {
                    installRemoteFirstPartyComponent: async ({ componentId }) => ({
                        binaryPath: componentId === 'happier-cli'
                            ? '$HOME/.happier/cli/current/happier'
                            : '$HOME/.happier/server/current/happier-server',
                        versionId: '1.2.3',
                        source: 'https://example.test/payload.tgz',
                    }),
                });
            });

            const remoteCommands = fakeSsh.readInvocations().map((args) => args.join(' ')).join('\n');
            expect(remoteCommands).not.toContain('curl -fsSL https://happier.dev/install');
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('does not delegate remote relay runtime installs to `hstack self-host install`', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: 'yes\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
                {
                    status: 0,
                    stdout: '\n',
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await expect(installOrUpdateRelayRuntimeDefault({
                    target: {
                        kind: 'ssh',
                        ssh: {
                            target: 'dev@example.test',
                            auth: 'agent',
                        },
                    },
                    channel: 'stable',
                    mode: 'user',
                }, {}, {
                    installRemoteFirstPartyComponent: async ({ componentId }) => {
                        switch (componentId) {
                            case 'happier-cli':
                                return {
                                    binaryPath: '$HOME/.happier/cli/current/happier',
                                    versionId: '1.2.3',
                                    source: 'https://example.test/payload.tgz',
                                };
                            case 'happier-server':
                                return {
                                    binaryPath: '$HOME/.happier/server/current/happier-server',
                                    versionId: '1.2.3',
                                    source: 'https://example.test/payload.tgz',
                                };
                            default: {
                                const exhaustive: never = componentId;
                                throw new Error(`unexpected component id: ${String(exhaustive)}`);
                            }
                        }
                    },
                })).resolves.toMatchObject({
                    relayUrl: 'http://127.0.0.1:3005',
                    mode: 'user',
                });
            });

            const remoteCommands = fakeSsh.readInvocations().map((args) => args.join(' ')).join('\n');
            expect(remoteCommands).not.toContain('hstack');
            expect(remoteCommands).not.toContain("'$HOME/");
        } finally {
            fakeSsh.cleanup();
        }
    });
});

describe('readRelayRuntimeStatusDefault', () => {
    it('does not delegate remote relay runtime status reads to `hstack self-host status`', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ platform: 'linux', arch: 'x86_64' })}\n`,
                },
                {
                    status: 0,
                    stdout: `${JSON.stringify({ version: '1.2.3' })}\n`,
                },
                {
                    status: 0,
                    stdout: 'enabled\nactive\nrunning\n',
                },
                {
                    status: 0,
                    stdout: 'yes\n',
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await readRelayRuntimeStatusDefault({
                    target: {
                        kind: 'ssh',
                        ssh: {
                            target: 'dev@example.test',
                            auth: 'agent',
                        },
                    },
                    channel: 'preview',
                    mode: 'user',
                });
            });

            const remoteCommands = fakeSsh.readInvocations().map((args) => args.join(' ')).join('\n');
            expect(remoteCommands).not.toContain('hstack self-host status');
            expect(remoteCommands).not.toContain("'$HOME/");
        } finally {
            fakeSsh.cleanup();
        }
    });
});
