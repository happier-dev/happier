import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { logger } from '@/ui/logger';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockIsAxiosError } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true)
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((data: any) => data),
    encrypt: vi.fn((data: any) => data),
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len)),
}));

// Mock configuration
vi.mock('@/configuration', () => ({
    configuration: {
        apiServerUrl: 'https://api.example.com'
    }
}));

// Mock libsodium encryption
vi.mock('./libsodiumEncryption', () => ({
    libsodiumEncryptForPublicKey: vi.fn((data: any) => new Uint8Array(32))
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools'
};

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib'
};

describe('Api server error handling', () => {
    let api: ApiClient;
    const envKeys = [
        'HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS',
        'HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS',
        'HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS',
        'HAPPIER_E2E_DELAY_CREATE_SESSION_MS',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests

        // Keep retry loops fast and deterministic in unit tests.
        envScope.patch(Object.fromEntries([
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '3'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS', '0'],
        ]) as Readonly<Record<string, string>>);

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
    });

    describe('getOrCreateSession', () => {
        it('delays session creation when HAPPIER_E2E_DELAY_CREATE_SESSION_MS is set', async () => {
            vi.useFakeTimers();
            envScope.patch({ HAPPIER_E2E_DELAY_CREATE_SESSION_MS: '1000' });

            try {
                mockPost.mockResolvedValue({ status: 201, data: { session: { id: 's1' } } });

                const promise = api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata as any, state: null });

                expect(mockPost).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(999);
                expect(mockPost).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                await expect(promise).resolves.toEqual(expect.objectContaining({ id: 's1' }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('should not log bearer tokens or vendor keys when axios errors occur', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            const leakedBearer = 'Bearer very-secret';
            const leakedVendorKey = 'sk-test-123';
            const leakedUrl = 'https://api.example.com/v1/sessions?token=sekret';

            mockPost.mockRejectedValue({
                message: 'boom',
                config: {
                    url: leakedUrl,
                    method: 'post',
                    headers: { Authorization: leakedBearer },
                    data: { apiKey: leakedVendorKey }
                },
                response: { status: 500 }
            });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            })).rejects.toThrow(/Failed to get or create session/i);

            const debugMock = (logger as any).debug as any;
            const serialized = JSON.stringify(debugMock.mock.calls);
            expect(serialized).not.toContain(leakedBearer);
            expect(serialized).not.toContain(leakedVendorKey);
            expect(serialized).not.toContain('token=sekret');

            output.restore();
        });

        it('should return null when Happy server is unreachable (ECONNREFUSED)', async () => {
            const output = captureConsoleText();

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(output.text()).toContain('server unreachable');
            output.restore();
        });

        it('should return null when Happy server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(output.text()).toContain('server unreachable');
            output.restore();
        });

        it('should return null when Happy server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(output.text()).toContain('server unreachable');
            output.restore();
        });

        it('should return null when Axios aborts bootstrap on timeout (ECONNABORTED)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            mockPost.mockRejectedValue({ code: 'ECONNABORTED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(output.text()).toContain('server unreachable');
            output.restore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            // New unified format via connectionState.fail()
            expect(output.text()).toContain('server unreachable');
            expect(output.text()).toContain('Session creation failed: 404');
            output.restore();
        });

        it('throws when server returns 500 Internal Server Error (do not enter offline mode)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            try {
                // Mock axios to return 500 error
                mockPost.mockRejectedValue({
                    response: { status: 500 },
                    isAxiosError: true
                });

                await expect(
                    api.getOrCreateSession({
                        tag: 'test-tag',
                        metadata: testMetadata,
                        state: null
                    })
                ).rejects.toThrow(/Failed to get or create session/i);

                expect(connectionState.isOffline()).toBe(false);
                expect(output.text()).not.toContain('server unreachable');
            } finally {
                output.restore();
            }
        });

        it('throws when server returns 503 Service Unavailable (do not enter offline mode)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            try {
                // Mock axios to return 503 error
                mockPost.mockRejectedValue({
                    response: { status: 503 },
                    isAxiosError: true
                });

                await expect(
                    api.getOrCreateSession({
                        tag: 'test-tag',
                        metadata: testMetadata,
                        state: null
                    })
                ).rejects.toThrow(/Failed to get or create session/i);

                expect(connectionState.isOffline()).toBe(false);
                expect(output.text()).not.toContain('server unreachable');
            } finally {
                output.restore();
            }
        });

        it('throws a stable auth status error on 401 so callers can stop retrying', async () => {
            connectionState.reset();

            mockPost.mockRejectedValue({
                response: { status: 401 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
            })).rejects.toMatchObject({
                name: 'HttpStatusError',
                response: { status: 401 },
            });

            expect(connectionState.isOffline()).toBe(false);
        });

        it('throws a stable auth status error on 403 so callers can stop retrying', async () => {
            connectionState.reset();

            mockPost.mockRejectedValue({
                response: { status: 403 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
            })).rejects.toMatchObject({
                name: 'HttpStatusError',
                response: { status: 403 },
            });

            expect(connectionState.isOffline()).toBe(false);
        });

        it('should re-throw non-connection errors', async () => {
            const output = captureConsoleText();

            try {
                // Mock axios to throw a different type of error (e.g., authentication error)
                const authError = new Error('Invalid API key');
                (authError as any).code = 'UNAUTHORIZED';
                mockPost.mockRejectedValue(authError);

                await expect(
                    api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
                ).rejects.toThrow('Failed to get or create session: Invalid API key');
                expect(connectionState.isOffline()).toBe(false);

                // Should not show the offline mode message
                expect(output.text()).not.toContain('server unreachable');
            } finally {
                output.restore();
            }
        });
    });

    describe('getOrCreateMachine', () => {
        it('uses provided timeout override for machine registration request', async () => {
            mockPost.mockResolvedValue({
                data: {
                    machine: {
                        id: 'test-machine',
                        metadata: testMachineMetadata,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            });

            await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                timeoutMs: 5_000,
            } as any);

            const config = mockPost.mock.calls[0]?.[2];
            expect(config?.timeout).toBe(5_000);
        });

        it('includes contentPublicKey when registering a machine with dataKey credentials', async () => {
            const dataKeyCredential = {
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(1),
                    machineKey: new Uint8Array(32).fill(2),
                },
            };

            const dataKeyApi = await ApiClient.create(dataKeyCredential as any);

            mockPost.mockResolvedValue({
                data: {
                    machine: {
                        id: 'test-machine',
                        metadata: testMachineMetadata,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            });

            await dataKeyApi.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            } as any);

            const body = mockPost.mock.calls[0]?.[1];
            expect(body?.contentPublicKey).toEqual(dataKeyCredential.encryption.publicKey);
        });

        it('throws (instead of returning a synthetic machine) when server is unreachable (ECONNREFUSED)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            // Mock axios to throw connection refused error
            const connectionError = { code: 'ECONNREFUSED' };
            mockPost.mockRejectedValue(connectionError);

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            })).rejects.toBe(connectionError);
            expect(connectionState.isOffline()).toBe(true);

            expect(output.text()).toContain('server unreachable');
            output.restore();
        });

        it('should throw on 409 machine id conflict (do not enter offline mode)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            mockPost.mockRejectedValue({
                response: { status: 409, data: { error: 'machine_id_conflict' } },
                isAxiosError: true,
            });

            await expect(
                api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                }),
            ).rejects.toThrow(/machine/i);

            expect(connectionState.isOffline()).toBe(false);
            expect(output.text()).not.toContain('server unreachable');
            output.restore();
        });

        it('throws a stable error on 410 machine revoked (do not enter offline mode)', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            mockPost.mockRejectedValue({
                response: { status: 410, data: { error: 'machine_revoked' } },
                isAxiosError: true,
            });

            await expect(
                api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                }),
            ).rejects.toMatchObject({ name: 'MachineRevokedError', machineId: 'test-machine' });

            expect(connectionState.isOffline()).toBe(false);
            expect(output.text()).not.toContain('server unreachable');
            output.restore();
        });

        it('throws a stable error when server rejects machine registration due to content public key mismatch', async () => {
            connectionState.reset();

            const dataKeyCredential = {
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(1),
                    machineKey: new Uint8Array(32).fill(2),
                },
            };
            const dataKeyApi = await ApiClient.create(dataKeyCredential as any);

            mockPost.mockRejectedValue({
                response: { status: 400, data: { error: 'invalid-params', reason: 'content_public_key_mismatch' } },
                isAxiosError: true,
            });

            await expect(
                dataKeyApi.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                } as any),
            ).rejects.toMatchObject({ name: 'MachineContentPublicKeyMismatchError' });

            expect(connectionState.isOffline()).toBe(false);
        });

        it('does not misclassify unrelated invalid-params machine registration failures as content key mismatches', async () => {
            connectionState.reset();

            const dataKeyCredential = {
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: new Uint8Array(32).fill(1),
                    machineKey: new Uint8Array(32).fill(2),
                },
            };
            const dataKeyApi = await ApiClient.create(dataKeyCredential as any);

            const unrelatedError = {
                response: { status: 400, data: { error: 'invalid-params', reason: 'missing_machine_name' } },
                isAxiosError: true,
            };
            mockPost.mockRejectedValue(unrelatedError);

            await expect(
                dataKeyApi.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                } as any),
            ).rejects.not.toMatchObject({ name: 'MachineContentPublicKeyMismatchError' });
            await expect(
                dataKeyApi.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                } as any),
            ).rejects.toBe(unrelatedError);

            expect(connectionState.isOffline()).toBe(false);
        });

        it('throws (instead of returning a synthetic machine) when server endpoint returns 404', async () => {
            connectionState.reset();
            const output = captureConsoleText();

            // Mock axios to return 404
            const endpointError = {
                response: { status: 404 },
                isAxiosError: true
            };
            mockPost.mockRejectedValue(endpointError);

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            })).rejects.toBe(endpointError);
            expect(connectionState.isOffline()).toBe(true);

            // New unified format via connectionState.fail()
            expect(output.text()).toContain('server unreachable');
            expect(output.text()).toContain('Machine registration failed: 404');
            output.restore();
        });
    });
});
