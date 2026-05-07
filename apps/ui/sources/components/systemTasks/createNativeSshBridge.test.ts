import { describe, expect, it, vi } from 'vitest';

import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { NativeSshAuthPromptEvent, NativeSshHostKeyPromptEvent, NativeSshModule } from '@happier-dev/ssh-native';
import type {
    NativeSshBridgeInterruptionMarker,
    NativeSshBridgeInterruptionStore,
} from './createNativeSshBridge';

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
            serviceMode: 'user',
            knownHostsMode: 'app',
        },
        ...overrides,
    };
}

describe('createNativeSshBridge', () => {
    it('rejects non-whitelisted system task kinds before native SSH execution', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const runBootstrapTask = vi.fn();
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask,
        });

        await expect(bridge.start({
            protocolVersion: 1,
            kind: 'daemon.sshTunnel.ensure.v1',
            params: {},
        })).rejects.toThrow('native_ssh_task_not_allowed');
        expect(runBootstrapTask).not.toHaveBeenCalled();
    });

    it('validates bootstrap params with the shared remote bootstrap parser before native SSH execution', async () => {
        const loaded = await import('./remoteSshBootstrap/nativeTask').catch(() => null);
        expect(loaded).not.toBeNull();

        await expect(loaded!.runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule: {
                getAvailability: () => ({
                    available: true,
                    platform: 'ios',
                    engine: 'russh',
                    moduleVersion: '0.0.0',
                    supportsLoopbackTunnel: false,
                    supportsPersistentHostKeyStorage: false,
                }),
                exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
                cancelRequest: async () => undefined,
            },
            spec: createRemoteBootstrapSpec({
            params: {
                ssh: {
                    target: 'dev@10.0.0.5',
                    auth: 'agent',
                },
                relay: {
                    relayUrl: '',
                    webappUrl: '',
                },
                channel: 'stable',
                serviceMode: 'user',
                knownHostsMode: 'app',
            },
            }),
        })).rejects.not.toThrow('native_ssh_bootstrap_requires_engine_spike');
    });


    it('dedupes in-flight bootstrap work by remote host and task kind', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let resolveRun: (value: unknown) => void = () => {
            throw new Error('native bootstrap promise was not initialized');
        };
        const runBootstrapTask = vi.fn(async () => new Promise((resolve) => {
            resolveRun = resolve;
        }));
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask,
        });

        const firstTaskId = await bridge.start(createRemoteBootstrapSpec());
        const secondTaskId = await bridge.start(createRemoteBootstrapSpec());

        expect(secondTaskId).toBe(firstTaskId);
        expect(runBootstrapTask).toHaveBeenCalledTimes(1);
        resolveRun({ machineId: 'machine-a' });
    });

    it('returns an interrupted result when a previous native bootstrap marker survived process restart', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const recoveryStore = new Map<string, NativeSshBridgeInterruptionMarker>();
        const runBootstrapTask = vi.fn(async () => ({ machineId: 'machine-a' }));
        const spec = createRemoteBootstrapSpec();
        const key = loaded!.readNativeSshBridgeInterruptionKey(spec);
        recoveryStore.set(key, {
            taskId: 'native_ssh_task_stale',
            key,
            startedAtMs: 1,
        });
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask,
            interruptionStore: {
                read: (storeKey) => recoveryStore.get(storeKey) ?? null,
                write: (marker) => {
                    recoveryStore.set(marker.key, marker);
                },
                remove: (storeKey) => {
                    recoveryStore.delete(storeKey);
                },
            },
        });

        const taskId = await bridge.start(spec);
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: (payload) => results.push(payload as SystemTaskResult),
        });

        expect(runBootstrapTask).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(results).toHaveLength(1);
        });
        expect(results[0]?.ok === false ? results[0].error.code : null).toBe('native_ssh_task_interrupted');
        expect(recoveryStore.has(key)).toBe(false);
    });

    it('provides a durable interruption store backed by app persistence storage', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const storedValues = new Map<string, string>();
        const createStore = (loaded as unknown as {
            createNativeSshBridgeInterruptionStore?: unknown;
        }).createNativeSshBridgeInterruptionStore;
        expect(typeof createStore).toBe('function');
        const store = (createStore as (storage: {
            getString: (key: string) => string | undefined;
            set: (key: string, value: string) => void;
            delete: (key: string) => void;
            getAllKeys: () => string[];
        }) => NativeSshBridgeInterruptionStore)({
            getString: (key) => storedValues.get(key),
            set: (key, value) => {
                storedValues.set(key, value);
            },
            delete: (key) => {
                storedValues.delete(key);
            },
            getAllKeys: () => [...storedValues.keys()],
        });
        expect(store).toBeTruthy();

        const marker = {
            taskId: 'native_ssh_task_a',
            key: 'native-ssh-interrupted:host-a:remote.ssh.bootstrapMachine.v1',
            startedAtMs: 1760000000000,
        };
        store!.write(marker);
        storedValues.set('other-key', JSON.stringify({
            taskId: 'ignored',
            key: 'other-key',
            startedAtMs: 1,
        }));

        expect(store!.read(marker.key)).toEqual(marker);
        expect(store!.list?.()).toEqual([marker]);
        store!.remove(marker.key);
        expect(store!.read(marker.key)).toBeNull();
    });

    it('maps native task completion through the system-task result contract', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask: vi.fn(async () => ({ machineId: 'machine-a' })),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: (payload) => {
                results.push(payload as SystemTaskResult);
            },
        });
        await vi.waitFor(() => {
            expect(results).toHaveLength(1);
        });

        expect(results[0]).toEqual({
            protocolVersion: 1,
            taskId,
            ok: true,
            data: {
                machineId: 'machine-a',
            },
        });
    });

    it('preserves stable SystemTaskExecutionError codes in failure results', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask: vi.fn(async () => {
                throw new SystemTaskExecutionError(
                    'native_ssh_remote_cli_install_failed',
                    'Native SSH bootstrap could not install Happier on the remote.',
                );
            }),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: (payload) => {
                results.push(payload as SystemTaskResult);
            },
        });

        await vi.waitFor(() => {
            expect(results).toHaveLength(1);
        });
        expect(results[0]?.ok === false ? results[0].error.code : null)
            .toBe('native_ssh_remote_cli_install_failed');
    });

    it('emits only one terminal result when cancellation races with fail-closed execution', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let rejectRun: (reason: Error) => void = () => {
            throw new Error('native bootstrap promise was not initialized');
        };
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask: vi.fn(async () => new Promise((_resolve, reject) => {
                rejectRun = reject;
            })),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: (payload) => {
                results.push(payload as SystemTaskResult);
            },
        });

        await bridge.cancel(taskId);
        rejectRun(new Error('native_ssh_bootstrap_requires_engine_spike'));
        await vi.waitFor(() => {
            expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).not.toContain('native_ssh_bootstrap_requires_engine_spike');
        });
        expect(results).toHaveLength(1);
        expect(results[0]?.ok === false ? results[0].error.code : null).toBe('cancelled');
    });

    it('keeps cancelled bootstrap work deduped until the native execution unwinds', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let rejectRun: (reason: Error) => void = () => {
            throw new Error('native bootstrap promise was not initialized');
        };
        const runBootstrapTask = vi.fn(async () => new Promise((_resolve, reject) => {
            rejectRun = reject;
        }));
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask,
        });

        const firstTaskId = await bridge.start(createRemoteBootstrapSpec());
        await bridge.cancel(firstTaskId);
        const secondTaskId = await bridge.start(createRemoteBootstrapSpec());

        expect(secondTaskId).toBe(firstTaskId);
        expect(runBootstrapTask).toHaveBeenCalledTimes(1);

        rejectRun(new Error('native_ssh_task_cancelled'));
        await vi.waitFor(() => {
            expect(runBootstrapTask).toHaveBeenCalledTimes(1);
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const thirdTaskId = await bridge.start(createRemoteBootstrapSpec());
        expect(thirdTaskId).not.toBe(firstTaskId);
        expect(runBootstrapTask).toHaveBeenCalledTimes(2);
    });

    it('routes native host-key prompts through system-task respond', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const hostKeyListenerRef: { current: ((event: NativeSshHostKeyPromptEvent) => void) | null } = { current: null };
        let resolveRun: (value: unknown) => void = () => {
            throw new Error('native bootstrap promise was not initialized');
        };
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'libssh2',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListenerRef.current = listener as (event: NativeSshHostKeyPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise((resolve) => {
                resolveRun = resolve;
            })),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: () => {},
        });

        const listener = hostKeyListenerRef.current;
        if (!listener) {
            throw new Error('Expected native host-key listener to be registered.');
        }
        listener({
            requestId: `${taskId}:exec-1`,
            promptId: 'prompt-1',
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            status: 'unknown',
        });
        await bridge.respond(taskId, { trusted: true });
        resolveRun({ machineId: 'machine-a' });

        expect(events).toContainEqual(expect.objectContaining({
            taskId,
            type: 'prompt',
            stepId: 'ssh.hostTrust',
            data: expect.objectContaining({
                kind: 'ssh.trustHost',
                host: '10.0.0.5',
                fingerprint: 'SHA256:abc',
            }),
        }));
        expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-1', {
            decision: 'accept-once',
            fingerprintSha256: 'SHA256:abc',
        });
    });

    it('auto-accepts native host keys that match the app trusted-host-key store', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const trustedHostKeyStore = {
            readAll: () => [],
            get: vi.fn(() => ({
                hostLower: '10.0.0.5',
                port: 2222,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:abc',
                trustedAtMs: 1,
                lastSeenAtMs: 1,
                source: 'remote-host' as const,
            })),
            trust: vi.fn(),
            markSeen: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
        };
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            trustedHostKeyStore,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: () => {},
        });

        const listener = hostKeyListener as ((event: NativeSshHostKeyPromptEvent) => void) | null;
        if (!listener) {
            throw new Error('Expected native host-key listener to be registered.');
        }
        listener({
            requestId: `${taskId}:exec-1`,
            promptId: 'prompt-remembered',
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            status: 'unknown',
        });

        await vi.waitFor(() => {
            expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-remembered', {
                decision: 'accept-once',
                fingerprintSha256: 'SHA256:abc',
            });
        });
        expect(trustedHostKeyStore.markSeen).toHaveBeenCalledWith({
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
        });
        expect(events).toEqual([]);
    });

    it('routes declined native host-key prompts back to the native engine', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const hostKeyListenerRef: { current: ((event: NativeSshHostKeyPromptEvent) => void) | null } = { current: null };
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListenerRef.current = listener as (event: NativeSshHostKeyPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: () => {},
        });
        await vi.waitFor(() => {
            expect(hostKeyListenerRef.current).toBeTypeOf('function');
        });

        const listener = hostKeyListenerRef.current;
        if (listener === null) {
            throw new Error('host-key listener was not registered');
        }
        listener({
            requestId: `${taskId}:request-a`,
            promptId: 'prompt-1',
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            status: 'unknown',
        });
        await bridge.respond(taskId, { trusted: false });

        expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-1', {
            decision: 'reject',
            reason: 'SSH host trust was declined.',
        });
    });

    it('includes prompt ids in host-key prompt events so repeated exec prompts do not dedupe in the UI', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt: vi.fn(async () => undefined),
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: () => {},
        });

        const listener = hostKeyListener as ((event: NativeSshHostKeyPromptEvent) => void) | null;
        if (!listener) {
            throw new Error('Expected native host-key listener to be registered.');
        }
        for (const promptId of ['prompt-1', 'prompt-2']) {
            listener({
                requestId: `${taskId}:exec-${promptId}`,
                promptId,
                host: '10.0.0.5',
                port: 2222,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:abc',
                status: 'unknown',
            });
        }

        const promptIds = events
            .map((event) => event && typeof event === 'object' ? (event as { data?: { promptId?: unknown } }).data?.promptId : null);
        expect(promptIds).toEqual(['prompt-1', 'prompt-2']);
    });

    it('routes changed native host keys through the shared replace-host-key prompt', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        let resolveRun: (value: unknown) => void = () => {
            throw new Error('native bootstrap promise was not initialized');
        };
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise((resolve) => {
                resolveRun = resolve;
            })),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: (payload) => results.push(payload as SystemTaskResult),
        });

        const listener = hostKeyListener as ((event: NativeSshHostKeyPromptEvent) => void) | null;
        if (!listener) {
            throw new Error('Expected native host-key listener to be registered.');
        }
        listener({
            requestId: `${taskId}:exec-1`,
            promptId: 'prompt-changed',
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:new',
            existingFingerprintSha256: 'SHA256:old',
            status: 'changed',
        });
        await bridge.respond(taskId, { trusted: true });
        resolveRun({ machineId: 'machine-a' });

        expect(events).toContainEqual(expect.objectContaining({
            taskId,
            type: 'prompt',
            stepId: 'ssh.hostTrust',
            data: expect.objectContaining({
                kind: 'ssh.replaceHostKey',
                host: '10.0.0.5',
                fingerprint: 'SHA256:new',
                existingFingerprint: 'SHA256:old',
            }),
        }));
        expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-changed', {
            decision: 'accept-once',
            fingerprintSha256: 'SHA256:new',
        });
        await vi.waitFor(() => {
            expect(results[0]?.ok).toBe(true);
        });
    });

    it('persists trusted host keys when the prompt response requests remembering', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let hostKeyListener: ((event: NativeSshHostKeyPromptEvent) => void) | null = null;
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const trustedHostKeyStore = {
            readAll: () => [],
            get: vi.fn(() => null),
            trust: vi.fn(),
            markSeen: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
        };
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListener = listener;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            trustedHostKeyStore,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: () => {},
        });

        const listener = hostKeyListener as ((event: NativeSshHostKeyPromptEvent) => void) | null;
        if (!listener) {
            throw new Error('Expected native host-key listener to be registered.');
        }
        listener({
            requestId: `${taskId}:exec-1`,
            promptId: 'prompt-remember',
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            status: 'unknown',
        });
        await bridge.respond(taskId, { trusted: true, remember: true });

        expect(trustedHostKeyStore.trust).toHaveBeenCalledWith({
            host: '10.0.0.5',
            port: 2222,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: 'SHA256:abc',
            remoteHostId: 'host-a',
        });
        expect(respondToHostKeyPrompt).toHaveBeenCalledWith('prompt-remember', {
            decision: 'accept-once',
            fingerprintSha256: 'SHA256:abc',
        });
    });

    it('routes native private-key passphrase prompts through generic SSH system-task prompts', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const authPromptListenerRef: { current: ((event: NativeSshAuthPromptEvent) => void) | null } = { current: null };
        const respondToAuthPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToAuthPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'authPrompt') {
                    authPromptListenerRef.current = listener as (event: NativeSshAuthPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: () => {},
        });

        if (!authPromptListenerRef.current) {
            throw new Error('Expected native auth prompt listener to be registered.');
        }
        authPromptListenerRef.current({
            requestId: `${taskId}:exec-1`,
            promptId: 'auth-passphrase-1',
            kind: 'private-key-passphrase',
            host: '10.0.0.5',
            port: 2222,
            username: 'dev',
            attemptsRemaining: 3,
        });
        await bridge.respond(taskId, { passphrase: 'secret phrase' });

        expect(events).toContainEqual(expect.objectContaining({
            taskId,
            type: 'prompt',
            stepId: 'ssh.auth',
            data: expect.objectContaining({
                kind: 'ssh.privateKeyPassphrase',
                promptId: 'auth-passphrase-1',
                host: '10.0.0.5',
            }),
        }));
        expect(respondToAuthPrompt).toHaveBeenCalledWith('auth-passphrase-1', {
            decision: 'submit',
            value: 'secret phrase',
        });
    });

    it('routes native keyboard-interactive prompts through generic SSH system-task prompts', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const authPromptListenerRef: { current: ((event: NativeSshAuthPromptEvent) => void) | null } = { current: null };
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
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToAuthPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'authPrompt') {
                    authPromptListenerRef.current = listener as (event: NativeSshAuthPromptEvent) => void;
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const events: unknown[] = [];
        await bridge.subscribe(taskId, {
            onEvent: (payload) => events.push(payload),
            onResult: () => {},
        });

        if (!authPromptListenerRef.current) {
            throw new Error('Expected native auth prompt listener to be registered.');
        }
        authPromptListenerRef.current({
            requestId: `${taskId}:exec-1`,
            promptId: 'auth-kbi-1',
            kind: 'keyboard-interactive',
            host: '10.0.0.5',
            port: 2222,
            username: 'dev',
            prompts: [{ id: '0', label: 'OTP', echo: false }],
        });
        await bridge.respond(taskId, { keyboardInteractiveAnswers: [{ id: '0', value: '123456' }] });

        expect(events).toContainEqual(expect.objectContaining({
            taskId,
            type: 'prompt',
            stepId: 'ssh.auth',
            data: expect.objectContaining({
                kind: 'ssh.keyboardInteractive',
                promptId: 'auth-kbi-1',
                prompts: [{ id: '0', label: 'OTP', echo: false }],
            }),
        }));
        expect(respondToAuthPrompt).toHaveBeenCalledWith('auth-kbi-1', {
            decision: 'submit',
            answers: [{ id: '0', value: '123456' }],
        });
    });

    it('continues shared recipe prompts through system-task respond', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        let capturedPrompt: ((payload: Readonly<{ kind: string; message: string }>) => Promise<unknown>) | null = null;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            runBootstrapTask: vi.fn(async (params) => {
                capturedPrompt = params.prompt;
                return await params.prompt({
                    kind: 'daemon.replaceRemoteBackgroundServices',
                    stepId: 'daemon.service.preflight',
                    message: 'Replace services?',
                    data: { services: [{ label: 'old' }] },
                });
            }),
        });
        const taskId = await bridge.start(createRemoteBootstrapSpec());
        const results: SystemTaskResult[] = [];
        await bridge.subscribe(taskId, {
            onEvent: () => {},
            onResult: (payload) => results.push(payload as SystemTaskResult),
        });

        await vi.waitFor(() => {
            expect(capturedPrompt).toEqual(expect.any(Function));
        });
        await bridge.respond(taskId, { replaceExistingServices: true });

        await vi.waitFor(() => {
            expect(results).toHaveLength(1);
        });
        expect(results[0]).toEqual(expect.objectContaining({
            ok: true,
            data: {
                replaceExistingServices: true,
            },
        }));
    });

    it('does not route host-key prompts across task host scopes', async () => {
        const loaded = await import('./createNativeSshBridge').catch(() => null);
        expect(loaded).not.toBeNull();

        const hostKeyListeners: Array<(event: NativeSshHostKeyPromptEvent) => void> = [];
        const respondToHostKeyPrompt = vi.fn(async () => undefined);
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'ios',
                engine: 'libssh2',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
            cancelRequest: vi.fn(async () => undefined),
            respondToHostKeyPrompt,
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'hostKeyPrompt') {
                    hostKeyListeners.push(listener);
                }
                return { remove: vi.fn() };
            }),
        } satisfies NativeSshModule;
        const bridge = loaded!.createNativeSshBridge({
            capability: {
                available: true,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
            },
            nativeModule,
            runBootstrapTask: vi.fn(async () => new Promise(() => {})),
        });
        const firstTaskId = await bridge.start(createRemoteBootstrapSpec());
        const secondTaskId = await bridge.start(createRemoteBootstrapSpec({
            params: {
                ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                remoteHostId: 'host-b',
                ssh: {
                    target: 'dev@10.0.0.6',
                    port: 2222,
                    auth: 'password',
                    password: 'secret',
                },
            },
        }));
        const firstEvents: unknown[] = [];
        const secondEvents: unknown[] = [];
        await bridge.subscribe(firstTaskId, {
            onEvent: (payload) => firstEvents.push(payload),
            onResult: () => {},
        });
        await bridge.subscribe(secondTaskId, {
            onEvent: (payload) => secondEvents.push(payload),
            onResult: () => {},
        });

        for (const listener of hostKeyListeners) {
            listener({
                requestId: `${secondTaskId}:exec-1`,
                promptId: 'prompt-host-b',
                host: '10.0.0.6',
                port: 2222,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:host-b',
                status: 'unknown',
            });
        }

        expect(firstEvents).toHaveLength(0);
        expect(secondEvents).toContainEqual(expect.objectContaining({
            taskId: secondTaskId,
            type: 'prompt',
            data: expect.objectContaining({
                fingerprint: 'SHA256:host-b',
            }),
        }));
    });
});
