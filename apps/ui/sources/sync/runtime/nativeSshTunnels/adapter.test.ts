import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NativeSshAuthPromptEvent, NativeSshHostKeyPromptEvent, NativeSshModule } from '@happier-dev/ssh-native';

/**
 * The Expo native module is a genuine system boundary: the adapter asks `@happier-dev/ssh-native`
 * for the optional module and everything beneath that call is real adapter logic.
 */
let resolvedNativeModule: NativeSshModule | null = null;
vi.mock('@happier-dev/ssh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/ssh-native')>();
    return {
        ...actual,
        getOptionalHappierSshNativeModule: () => resolvedNativeModule,
    };
});

afterEach(() => {
    resolvedNativeModule = null;
});

describe('createNativeSshTunnelAdapter', () => {
    it('starts native loopback tunnels with resolved credentials and prompt host-key verification', async () => {
        const loaded = await import('./adapter').catch(() => null);
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
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;

        const adapter = loaded!.createNativeSshTunnelAdapter({
            nativeModule,
            resolveCredentials: async () => ({
                auth: {
                    username: 'dev',
                    password: 'secret',
                },
            }),
        });

        await expect(adapter.startLoopbackTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            sshPort: 2222,
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
            requestedLocalPort: 49152,
        })).resolves.toEqual({
            nativeTunnelId: 'native-1',
            localPort: 49152,
        });

        expect(nativeModule.startLoopbackTunnel).toHaveBeenCalledWith({
            requestId: expect.stringContaining('native-ssh-tunnel:'),
            host: '10.0.0.5',
            port: 2222,
            username: 'dev',
            auth: {
                username: 'dev',
                password: 'secret',
            },
            hostKeyVerification: {
                decision: 'prompt',
            },
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            requestedLocalPort: 49152,
            connectTimeoutMs: 15_000,
            authTimeoutMs: 15_000,
        });
    });

    it('routes tunnel host-key prompts through the adapter prompt callback before native timeout', async () => {
        const loaded = await import('./adapter').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener as (event: NativeSshHostKeyPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
            startLoopbackTunnel: vi.fn(async (request) => {
                const listener = hostKeyListener;
                if (!listener) {
                    throw new Error('host-key listener was not registered');
                }
                listener({
                    requestId: request.requestId,
                    promptId: 'prompt-1',
                    host: request.host,
                    port: request.port,
                    algorithm: 'ssh-ed25519',
                    fingerprintSha256: 'SHA256:abc',
                    status: 'unknown',
                });
                await vi.waitFor(() => {
                    expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-1', {
                        decision: 'accept-once',
                        fingerprintSha256: 'SHA256:abc',
                    });
                });
                return {
                    nativeTunnelId: 'native-1',
                    localPort: 49152,
                };
            }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const promptHostKey = vi.fn(async (event: NativeSshHostKeyPromptEvent) => ({
            decision: 'accept-once' as const,
            fingerprintSha256: event.fingerprintSha256,
        }));
        const adapter = loaded!.createNativeSshTunnelAdapter({
            nativeModule,
            promptHostKey,
            resolveCredentials: async () => ({
                auth: {
                    username: 'dev',
                    password: 'secret',
                },
            }),
        });

        await expect(adapter.startLoopbackTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
        })).resolves.toEqual({
            nativeTunnelId: 'native-1',
            localPort: 49152,
        });

        expect(promptHostKey).toHaveBeenCalledWith(expect.objectContaining({
            promptId: 'prompt-1',
            fingerprintSha256: 'SHA256:abc',
        }), expect.objectContaining({
            remoteHostId: 'host-a',
        }));
    });

    it('routes changed tunnel host-key prompts through the adapter prompt callback', async () => {
        const loaded = await import('./adapter').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener as (event: NativeSshHostKeyPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
            startLoopbackTunnel: vi.fn(async (request) => {
                const listener = hostKeyListener;
                if (!listener) {
                    throw new Error('host-key listener was not registered');
                }
                listener({
                    requestId: request.requestId,
                    promptId: 'prompt-2',
                    host: request.host,
                    port: request.port,
                    algorithm: 'ssh-ed25519',
                    fingerprintSha256: 'SHA256:new',
                    existingFingerprintSha256: 'SHA256:old',
                    status: 'changed',
                });
                await vi.waitFor(() => {
                    expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-2', {
                        decision: 'accept-once',
                        fingerprintSha256: 'SHA256:new',
                    });
                });
                return {
                    nativeTunnelId: 'native-1',
                    localPort: 49152,
                };
            }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const promptHostKey = vi.fn(async (event: NativeSshHostKeyPromptEvent) => ({
            decision: 'accept-once' as const,
            fingerprintSha256: event.fingerprintSha256,
        }));
        const adapter = loaded!.createNativeSshTunnelAdapter({
            nativeModule,
            promptHostKey,
            resolveCredentials: async () => ({
                auth: {
                    username: 'dev',
                    privateKeyPem: 'private-key',
                },
            }),
        });

        await expect(adapter.startLoopbackTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
        })).resolves.toEqual({
            nativeTunnelId: 'native-1',
            localPort: 49152,
        });

        expect(promptHostKey).toHaveBeenCalledWith(expect.objectContaining({
            promptId: 'prompt-2',
            status: 'changed',
            existingFingerprintSha256: 'SHA256:old',
        }), expect.objectContaining({
            remoteHostId: 'host-a',
        }));
    });

    it('routes tunnel auth prompts through the adapter prompt callback before native timeout', async () => {
        const loaded = await import('./adapter').catch(() => null);
        expect(loaded).not.toBeNull();

        let authPromptListener: ((event: NativeSshAuthPromptEvent) => void) | null = null;
        const respondToAuthPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            respondToAuthPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'authPrompt') {
                    authPromptListener = listener as (event: NativeSshAuthPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
            startLoopbackTunnel: vi.fn(async (request) => {
                const listener = authPromptListener;
                if (!listener) {
                    throw new Error('auth prompt listener was not registered');
                }
                listener({
                    requestId: request.requestId,
                    promptId: 'auth-passphrase-1',
                    kind: 'private-key-passphrase',
                    host: request.host,
                    port: request.port,
                    username: request.username,
                    attemptsRemaining: 3,
                });
                await vi.waitFor(() => {
                    expect(respondToAuthPrompt).toHaveBeenCalledWith('auth-passphrase-1', {
                        decision: 'submit',
                        value: 'secret phrase',
                    });
                });
                return {
                    nativeTunnelId: 'native-1',
                    localPort: 49152,
                };
            }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const promptAuth = vi.fn(async () => ({
            decision: 'submit' as const,
            value: 'secret phrase',
        }));
        const adapter = loaded!.createNativeSshTunnelAdapter({
            nativeModule,
            promptAuth,
            resolveCredentials: async () => ({
                auth: {
                    username: 'dev',
                    privateKeyPem: 'private-key',
                },
            }),
        });

        await expect(adapter.startLoopbackTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
        })).resolves.toEqual({
            nativeTunnelId: 'native-1',
            localPort: 49152,
        });

        expect(promptAuth).toHaveBeenCalledWith(expect.objectContaining({
            promptId: 'auth-passphrase-1',
            kind: 'private-key-passphrase',
        }), expect.objectContaining({
            remoteHostId: 'host-a',
        }));
    });

    it('stops native loopback tunnels through the native module', async () => {
        const loaded = await import('./adapter').catch(() => null);
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
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;

        const adapter = loaded!.createNativeSshTunnelAdapter({
            nativeModule,
            resolveCredentials: async () => ({
                auth: {
                    username: 'dev',
                    password: 'secret',
                },
            }),
        });

        await adapter.stopLoopbackTunnel('native-1');

        expect(nativeModule.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
    });

    /**
     * §7.1: the sole production caller (`runtime.ts` -> `createDefaultSupervisor`) passes no
     * `nativeModule`, so both prompt subscriptions were skipped and a host needing trust or
     * credentials simply timed out. `startNativeSshLoopbackTunnel` already resolves the module
     * itself when the caller passes `undefined`; the adapter must apply the SAME rule so the
     * prompt bridge is registered against the module the tunnel actually starts on.
     */
    it('resolves the optional native module itself so prompts fire for callers that pass none', async () => {
        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener as (event: NativeSshHostKeyPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
            startLoopbackTunnel: vi.fn(async (request) => {
                const listener = hostKeyListener;
                if (!listener) {
                    throw new Error('host-key listener was not registered');
                }
                listener({
                    requestId: request.requestId,
                    promptId: 'prompt-auto',
                    host: request.host,
                    port: request.port,
                    algorithm: 'ssh-ed25519',
                    fingerprintSha256: 'SHA256:auto',
                    status: 'unknown',
                });
                await vi.waitFor(() => {
                    expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-auto', {
                        decision: 'accept-once',
                        fingerprintSha256: 'SHA256:auto',
                    });
                });
                return { nativeTunnelId: 'native-auto', localPort: 49153 };
            }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        resolvedNativeModule = nativeModule;

        const loaded = await import('./adapter').catch(() => null);
        expect(loaded).not.toBeNull();

        const promptHostKey = vi.fn(async (event: NativeSshHostKeyPromptEvent) => ({
            decision: 'accept-once' as const,
            fingerprintSha256: event.fingerprintSha256,
        }));
        const adapter = loaded!.createNativeSshTunnelAdapter({
            promptHostKey,
            resolveCredentials: async () => ({ auth: { username: 'dev', password: 'secret' } }),
        });

        await expect(adapter.startLoopbackTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
        })).resolves.toEqual({ nativeTunnelId: 'native-auto', localPort: 49153 });

        expect(promptHostKey).toHaveBeenCalledWith(
            expect.objectContaining({ promptId: 'prompt-auto' }),
            expect.objectContaining({ remoteHostId: 'host-a' }),
        );
    });
});
