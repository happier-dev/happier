import { describe, expect, it, vi } from 'vitest';

import type { SystemTaskSpec } from '@happier-dev/protocol';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { NativeSshModule } from '@happier-dev/ssh-native';

function createRemoteBootstrapSpec(overrides: Partial<SystemTaskSpec> = {}): SystemTaskSpec {
    return {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
            remoteHostId: 'host-a',
            ssh: {
                target: 'dev@10.0.0.5',
                port: 2222,
                auth: 'password',
                password: 'secret',
            },
            relay: {
                relayUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
            },
            channel: 'stable',
            serviceMode: 'none',
            knownHostsMode: 'app',
        },
        ...overrides,
    };
}

describe('runNativeRemoteSshBootstrapTask', () => {
    it('runs the shared bootstrap recipe over native SSH for remotes with an installed Happier CLI', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const commands: string[] = [];
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async (request) => {
                commands.push(request.command);
                if (request.command.includes('auth status')) {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({
                            ok: true,
                            data: {
                                authenticated: true,
                                machineId: 'machine-a',
                            },
                        }),
                        stderr: '',
                    };
                }
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        data: {},
                    }),
                    stderr: '',
                };
            }),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
        })).resolves.toEqual({
            machineId: 'machine-a',
        });
        expect(commands.some((command) => command.includes('server set'))).toBe(true);
        expect(commands.some((command) => command.includes('auth status'))).toBe(true);
    });

    it('installs the remote CLI through the verified native self-download hook for fresh remotes', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 127,
                stdout: '',
                stderr: 'happier: command not found',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commands: string[] = [];
        let serverConfigureAttempts = 0;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                commands.push(command);
                if (command.includes('server set')) {
                    serverConfigureAttempts += 1;
                    return serverConfigureAttempts === 1
                        ? { ok: false, data: {} }
                        : { ok: true, data: {} };
                }
                if (command.includes('auth status')) {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            machineId: 'machine-fresh',
                        },
                    };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async ({ command }: { command: string }) => {
                commands.push(command);
                if (command.includes('uname -s')) {
                    return {
                        status: 0,
                        stdout: JSON.stringify({ platform: 'linux', arch: 'x86_64' }),
                        stderr: '',
                    };
                }
                return { status: 0, stdout: '', stderr: '' };
            }),
        };

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
            commandRunner,
            resolveInstallPlan: async () => ({
                binaryPath: '$HOME/.happier/cli/current/happier',
                versionId: '1.2.3',
                source: 'https://downloads.example.test/happier.tar.gz',
                command: 'verified self-download install command',
            }),
        })).resolves.toEqual({
            machineId: 'machine-fresh',
        });
        expect(commands).toContain('verified self-download install command');
    });

    it('normalizes failed auth status probes as unauthenticated so pairing can continue', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, data: {} }),
                stderr: '',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                if (command.includes('auth status')) {
                    return { ok: false, data: { code: 'not_authenticated' } };
                }
                if (command.includes('auth request')) {
                    return { ok: true, data: { publicKey: 'pubkey-a' } };
                }
                if (command.includes('auth wait')) {
                    return { ok: true, data: { machineId: 'machine-paired' } };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
        };

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
            commandRunner,
            prompt: async () => ({ approved: true }),
            approveLocalAuthRequest: async () => undefined,
        })).resolves.toEqual({
            machineId: 'machine-paired',
            publicKey: 'pubkey-a',
        });
    });

    it('approves local terminal auth after the user accepts remote provisioning', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, data: {} }),
                stderr: '',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                if (command.includes('auth status')) {
                    return { ok: false, data: { code: 'not_authenticated' } };
                }
                if (command.includes('auth request')) {
                    return { ok: true, data: { publicKey: 'pubkey-a' } };
                }
                if (command.includes('auth wait')) {
                    return { ok: true, data: { machineId: 'machine-paired' } };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
        };
        const approveLocalAuthRequest = vi.fn(async () => undefined);

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
            commandRunner,
            prompt: async () => ({ approved: true }),
            approveLocalAuthRequest,
        })).resolves.toEqual({
            machineId: 'machine-paired',
            publicKey: 'pubkey-a',
        });
        expect(approveLocalAuthRequest).toHaveBeenCalledWith('pubkey-a');
    });

    it('installs optional relay runtime through the remote CLI over native SSH exec', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const commands: string[] = [];
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, data: {} }),
                stderr: '',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                commands.push(command);
                if (command.includes('relay host install')) {
                    return {
                        ok: true,
                        data: {
                            relayUrl: 'http://127.0.0.1:40123',
                            mode: 'user',
                        },
                    };
                }
                if (command.includes('auth status')) {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            machineId: 'machine-relay',
                        },
                    };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
        };

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec({
                params: {
                    ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                    relayRuntime: {
                        enabled: true,
                        mode: 'user',
                    },
                },
            }),
            commandRunner,
        })).resolves.toEqual({
            machineId: 'machine-relay',
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:40123',
                mode: 'user',
            },
        });
        expect(commands.some((command) => command.includes('relay host install'))).toBe(true);
    });

    it('rejects mobile-unsupported SSH agent credentials before native execution', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        expect(() => loaded!.readNativeSshTaskCredentials(createRemoteBootstrapSpec({
            params: {
                ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                ssh: {
                    target: 'dev@10.0.0.5',
                    port: 2222,
                    auth: 'agent',
                },
            },
        }))).toThrow('native_ssh_missing_credentials');
    });

    it('reports a typed upgrade requirement without posting when local credentials are token-only', async () => {
        vi.resetModules();
        const authApprove = vi.fn();
        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
            return {
                ...actual,
                TokenStorage: {
                    getCredentials: vi.fn(async () => ({ token: 'plain-token' })),
                },
            };
        });
        vi.doMock('@/auth/flows/approve', () => ({ authApprove }));

        try {
            const loaded = await import('./nativeTask');
            const nativeModule = {
                getAvailability: () => ({
                    available: true,
                    platform: 'android',
                    engine: 'russh',
                    moduleVersion: '0.0.0',
                    supportsLoopbackTunnel: true,
                    supportsPersistentHostKeyStorage: false,
                } as const),
                exec: vi.fn(async () => ({
                    exitCode: 0,
                    stdout: JSON.stringify({ ok: true, data: {} }),
                    stderr: '',
                })),
                cancelRequest: vi.fn(async () => undefined),
            } satisfies NativeSshModule;
            const publicKey = Buffer.alloc(32, 3).toString('base64url');
            const commandRunner = {
                runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                    if (command.includes('auth status')) {
                        return { ok: false, data: { code: 'not_authenticated' } };
                    }
                    if (command.includes('auth request')) {
                        return { ok: true, data: { publicKey } };
                    }
                    return { ok: true, data: {} };
                }),
                runTextCommand: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
            };

            await expect(loaded.runNativeRemoteSshBootstrapTask({
                taskId: 'task-token-only',
                nativeModule,
                spec: createRemoteBootstrapSpec(),
                commandRunner,
                prompt: async () => ({ approved: true }),
            })).rejects.toMatchObject({
                name: 'SystemTaskExecutionError',
                code: 'native_ssh_token_only_terminal_approval_upgrade_required',
            });
            expect(authApprove).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('@/auth/storage/tokenStorage');
            vi.doUnmock('@/auth/flows/approve');
            vi.resetModules();
        }
    });

    it('passes encrypted private keys to native SSH so the shared passphrase prompt can unlock them', async () => {
        const loaded = await import('./nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        const credentials = loaded!.readNativeSshTaskCredentials(createRemoteBootstrapSpec({
            params: {
                ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                ssh: {
                    target: 'dev@10.0.0.5',
                    port: 2222,
                    auth: 'keyfile',
                    identityPrivateKey: [
                        '-----BEGIN ENCRYPTED PRIVATE KEY-----',
                        'private-key-body',
                        '-----END ENCRYPTED PRIVATE KEY-----',
                    ].join('\n'),
                },
            },
        }));

        expect(credentials.auth.privateKeyPem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    });
});
