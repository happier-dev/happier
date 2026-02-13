import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/api/offline/serverConnectionErrors';
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

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((data: any) => data),
    encrypt: vi.fn((data: any) => data)
}));

// Mock configuration
vi.mock('./configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com'
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
    const previousRetryEnv: Record<string, string | undefined> = {};

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests

        // Keep retry loops fast and deterministic in unit tests.
        for (const [key, value] of [
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '3'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS', '0'],
        ] as const) {
            if (!Object.prototype.hasOwnProperty.call(previousRetryEnv, key)) {
                previousRetryEnv[key] = process.env[key];
            }
            process.env[key] = value;
        }

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
        for (const [key, value] of Object.entries(previousRetryEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        for (const key of Object.keys(previousRetryEnv)) {
            delete previousRetryEnv[key];
        }
    });

    describe('getOrCreateSession', () => {
        it('should not log bearer tokens or vendor keys when axios errors occur', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(connectionState.isOffline()).toBe(true);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session creation failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('throws when server returns 500 Internal Server Error (do not enter offline mode)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('throws when server returns 503 Service Unavailable (do not enter offline mode)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
            } finally {
                consoleSpy.mockRestore();
            }
        });

        it('should re-throw non-connection errors', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
                expect(consoleSpy).not.toHaveBeenCalledWith(
                    expect.stringContaining('server unreachable')
                );
            } finally {
                consoleSpy.mockRestore();
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

        it('should return minimal machine object when server is unreachable (ECONNREFUSED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: {
                    status: 'running',
                    pid: 1234
                },
                daemonStateVersion: 0,
            });
            expect(connectionState.isOffline()).toBe(true);

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should throw on 409 machine id conflict (do not enter offline mode)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
            expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('server unreachable'));

            consoleSpy.mockRestore();
        });

        it('should return minimal machine object when server endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            });
            expect(connectionState.isOffline()).toBe(true);

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 404')
            );

            consoleSpy.mockRestore();
        });
    });
});
