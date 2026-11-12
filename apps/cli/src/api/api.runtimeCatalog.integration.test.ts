import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol';
import { ApiClient } from './api';
import { encodeBase64 } from './encryption';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { logger } from '@/ui/logger';
import { AccountEncryptionModeResponseSchema, AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { MachinePublishedRowV1Schema, type MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import type { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

function createSessionFromCreationFields(body: ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>) {
    const { sharedMetadata, ...fields } = body;
    return { id: 's1', ...fields, metadata: sharedMetadata.ciphertext };
}

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const {
    mockGet,
    mockPost,
    mockIsAxiosError,
    mockFetchServerFeaturesSnapshot,
    configurationMock,
} = vi.hoisted(() => {
    const happyHomeDir = `/tmp/happier-api-test-${process.pid}`;
    return {
        mockGet: vi.fn(),
        mockPost: vi.fn(),
        mockIsAxiosError: vi.fn(() => true),
        mockFetchServerFeaturesSnapshot: vi.fn(),
        configurationMock: {
            activeServerId: 'cloud',
            apiServerUrl: 'https://api.example.com',
            happyHomeDir,
            settingsFile: `${happyHomeDir}/settings.json`,
            privateKeyFile: `${happyHomeDir}/servers/cloud/access.key`,
            legacyPrivateKeyFile: `${happyHomeDir}/access.key`,
            installationIdentityFile: '',
        },
    };
});

vi.mock('axios', () => ({
    default: {
        defaults: {},
        get: mockGet,
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    get: mockGet,
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warnLocalFile: vi.fn(),
    }
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: mockFetchServerFeaturesSnapshot,
}));

// Mock configuration
vi.mock('@/configuration', () => ({
    configuration: configurationMock
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

// A real Ed25519 public key: MachineInstallationPublicKeySchema rejects small-order
// points (packages/protocol/src/crypto/ed25519.ts), so an all-zero placeholder is
// not a valid registration identity.
const testInstallationPublicKey = Buffer.from(
    tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
).toString('base64url');

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib'
};

function writeApiTestSettings(settings: unknown): void {
    mkdirSync(configurationMock.happyHomeDir, { recursive: true });
    writeFileSync(configurationMock.settingsFile, JSON.stringify(settings, null, 2));
}

function readApiTestSettings(): any {
    return JSON.parse(readFileSync(configurationMock.settingsFile, 'utf8'));
}

async function readApiGetFixture(url: string) {
    if (url.endsWith('/v1/account/encryption')) {
        return { status: 200, data: AccountEncryptionModeResponseSchema.parse({ mode: 'e2ee', updatedAt: 1 }) };
    }
    if (url.includes('/v1/machines/')) {
        throw { isAxiosError: true, response: { status: 404, data: { error: 'machine_not_found' } } };
    }
    if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: AccountEncryptionCurrentnessResponseSchema.parse({
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: 'content-fingerprint', updatedAt: 1,
        }) };
    }
    throw new Error('Unexpected API fixture GET');
}

function createMachineRegistrationFixture(overrides: Partial<MachinePublishedRowV1> = {}) {
    // These cases exercise registration and error policy. No stored Machine
    // content is needed; an absent payload still follows the real key owner.
    return MachinePublishedRowV1Schema.parse({ id: 'test-machine', metadata: null,
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0, ...overrides });
}

describe('Api server error handling', () => {
    let api: ApiClient;
    const envKeys = [
        'HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS',
        'HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS',
        'HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS',
        'HAPPIER_E2E_DELAY_CREATE_SESSION_MS',
        'HAPPIER_LOCAL_SERVER_URL',
        'HAPPIER_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_STACK_ENV_FILE',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetchServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    encryption: {
                        storagePolicy: 'optional',
                        allowAccountOptOut: true,
                        defaultAccountMode: 'e2ee',
                    },
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: 2,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            },
        });
        mockGet.mockImplementation(readApiGetFixture);
        connectionState.reset(); // Reset offline state between tests
        rmSync(configurationMock.happyHomeDir, { recursive: true, force: true });
        mkdirSync(configurationMock.happyHomeDir, { recursive: true });

        // Keep retry loops fast and deterministic in unit tests.
        envScope.patch(Object.fromEntries([
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '3'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0'],
            ['HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS', '0'],
            ['HAPPIER_LOCAL_SERVER_URL', undefined],
            ['HAPPIER_SERVER_URL', undefined],
            ['HAPPIER_PUBLIC_SERVER_URL', undefined],
            ['HAPPIER_STACK_ENV_FILE', undefined],
        ]) as Readonly<Record<string, string | undefined>>);

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
        rmSync(configurationMock.happyHomeDir, { recursive: true, force: true });
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
    });

    describe('getOrCreateSession', () => {
        it('establishes the exact Machine access binding before returning a created Session', async () => {
            api.setLocalMachineId('target-machine');
            const requests: string[] = [];
            let releaseBinding: (() => void) | undefined;
            const bindingCompletion = new Promise<void>((resolve) => { releaseBinding = resolve; });
            mockGet.mockImplementation(async (url: string) => url.includes('/v1/access-keys/')
                ? (requests.push('access-key-read'), { status: 200, data: { accessKey: null } })
                : {
                    status: 200,
                    data: {
                        mode: 'e2ee', version: 1,
                        signingKeyFingerprint: 'signing-fingerprint',
                        contentKeyFingerprint: 'content-fingerprint',
                        updatedAt: 1,
                    },
                });
            mockPost.mockImplementation(async (url: string, body: ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>) => {
                if (url.endsWith('/v1/sessions')) {
                    requests.push('session');
                    return { status: 201, data: { session: createSessionFromCreationFields(body), created: true } };
                }
                if (url.includes('/v1/access-keys/s1/target-machine')) {
                    requests.push('access-key');
                    await bindingCompletion;
                    return { status: 200, data: { success: true } };
                }
                throw new Error(`Unexpected POST: ${url}`);
            });

            const created = api.getOrCreateSession({
                tag: 'test-tag', metadata: testMetadata, state: null,
                creationAuthorizationToken: 'host-signed-proof',
            });
            await vi.waitFor(() => expect(requests).toEqual(['session', 'access-key']));
            let returned = false;
            void created.then(() => { returned = true; });
            expect(returned).toBe(false);
            releaseBinding?.();
            await expect(created).resolves.toMatchObject({ id: 's1' });
            // A Session this call just created has no binding yet: one write, no lookup round trip.
            expect(requests).toEqual(['session', 'access-key']);
            expect(mockPost).toHaveBeenCalledWith('https://api.example.com/v1/sessions',
                expect.not.objectContaining({ creationAuthorizationToken: 'host-signed-proof' }),
                expect.objectContaining({ headers: expect.objectContaining({
                    [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: 'host-signed-proof',
                }) }));
        });

        it('delays session creation when HAPPIER_E2E_DELAY_CREATE_SESSION_MS is set', async () => {
            vi.useFakeTimers();
            envScope.patch({ HAPPIER_E2E_DELAY_CREATE_SESSION_MS: '1000' });

            try {
                mockPost.mockImplementation(async (_url: string, body: ReturnType<typeof buildSessionMetadataEnvelopeCreateFields>) => ({
                    status: 201, data: { session: createSessionFromCreationFields(body) },
                }));

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

            const debugMock = vi.mocked(logger.debug);
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

        it.each(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET'])('preserves an uncertain creation receipt (%s)', async (code) => {
            connectionState.reset();
            const output = captureConsoleText();

            mockPost.mockRejectedValue({ code });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            })).rejects.toMatchObject({ code: 'outcome_unknown', cause: { code } });

            expect(connectionState.isOffline()).toBe(false);
            expect(output.text()).not.toContain('server unreachable');
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

        it.each([
            { error: 'database_transaction_timeout', statusCode: 503, transactionOutcome: 'rolled_back' },
            { error: 'database_transaction_conflict_exhausted', statusCode: 503 },
        ])('preserves the creation transport\'s confirmed $error through API settlement', async body => {
            // HTTP is the boundary; the real creation transport classifies the receipt.
            mockGet.mockImplementation(readApiGetFixture);
            mockPost.mockResolvedValue({ status: 503, data: body });
            await expect(api.getOrCreateSession({
                tag: 'test-tag', metadata: testMetadata, state: null,
            })).rejects.toMatchObject({ code: body.error, response: { status: 503 } });
            expect(connectionState.isOffline()).toBe(false);
        });

        it('preserves the server\'s exact organization-placement refusal as a bounded creation error', async () => {
            mockPost.mockRejectedValue({
                response: {
                    status: 400,
                    data: {
                        error: 'invalid-params',
                        code: 'invalid-session-organization-placement',
                    },
                },
                isAxiosError: true,
            });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
                organizationPlacement: { folderId: 'folder-1', tagIds: [] },
            })).rejects.toMatchObject({
                name: 'SessionCreationPlacementError',
                code: 'organization_invalid',
            });
            expect(connectionState.isOffline()).toBe(false);
        });

        it('does not infer a placement result from another invalid-params response', async () => {
            mockPost.mockRejectedValue({
                response: {
                    status: 400,
                    data: {
                        error: 'invalid-params',
                        code: 'another-invalid-parameter',
                    },
                },
                isAxiosError: true,
            });

            const error = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
                organizationPlacement: { folderId: 'folder-1', tagIds: [] },
            }).then(
                () => null,
                (caught: unknown) => caught,
            );

            expect(error).toMatchObject({
                name: 'Error',
                message: expect.stringContaining('Failed to get or create session'),
            });
            expect(error).not.toMatchObject({ code: 'organization_invalid' });
            expect(connectionState.isOffline()).toBe(false);
        });

        it('keeps an unclassified response loss uncertain rather than inventing an authentication refusal', async () => {
            const output = captureConsoleText();

            try {
                // A transport label without an HTTP refusal cannot prove that
                // the Home rejected or rolled back this mutation.
                const transportError = Object.assign(new Error('No response received'), { code: 'UNAUTHORIZED' });
                mockPost.mockRejectedValue(transportError);

                await expect(
                    api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
                ).rejects.toMatchObject({ code: 'outcome_unknown', cause: { code: 'UNAUTHORIZED' } });
                expect(connectionState.isOffline()).toBe(false);

                // Should not show the offline mode message
                expect(output.text()).not.toContain('server unreachable');
            } finally {
                output.restore();
            }
        });
    });

    describe('getOrCreateSession encryption-currentness preflight', () => {
        it('preserves the typed failure without declaring offline when Account currentness is unreachable', async () => {
            connectionState.reset();
            const output = captureConsoleText();
            try {
                // No Session request was issued; a failed observation is not
                // proof that the Home or a previously created Session is absent.
                mockGet.mockRejectedValue({ code: 'ECONNREFUSED' });

                await expect(api.getOrCreateSession({
                    tag: 'test-tag',
                    metadata: testMetadata,
                    state: null,
                })).rejects.toMatchObject({ code: 'account_encryption_currentness_unavailable',
                    cause: { code: 'ECONNREFUSED' } });
                expect(connectionState.isOffline()).toBe(false);
                expect(mockPost).not.toHaveBeenCalled();
            } finally {
                output.restore();
            }
        });

        it('throws the stable auth status error when the Account currentness read is refused', async () => {
            connectionState.reset();
            mockGet.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
            })).rejects.toMatchObject({
                name: 'HttpStatusError',
                response: { status: 401 },
            });
            expect(connectionState.isOffline()).toBe(false);
            expect(mockPost).not.toHaveBeenCalled();
        });

        it('throws the stable auth status error when the refusal is not an Axios error', async () => {
            connectionState.reset();
            // Real Axios answers `false` for the preflight's HttpStatusError cause
            // (it is the repository's minimal Axios-like status carrier, not an
            // Axios error), so the classifier must read the status, not the brand.
            mockIsAxiosError.mockImplementation(() => false);
            mockGet.mockResolvedValue({ status: 403, data: { error: 'forbidden' } });

            try {
                await expect(api.getOrCreateSession({
                    tag: 'test-tag',
                    metadata: testMetadata,
                    state: null,
                })).rejects.toMatchObject({
                    name: 'HttpStatusError',
                    response: { status: 403 },
                });
                expect(connectionState.isOffline()).toBe(false);
                expect(mockPost).not.toHaveBeenCalled();
            } finally {
                mockIsAxiosError.mockImplementation(() => true);
            }
        });
    });

    describe('getOrCreateMachine', () => {
        it('retains only the server-validated exact-target operation capability snapshot', async () => {
            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture({
                        revokedAt: null,
                        replacedByMachineId: null,
                        operationProtocolCapabilities: {
                            sessionSpawn: { protocolVersions: [1] },
                        },
                        operationProtocolCapabilitiesRevision: 4,
                    }),
                },
            });

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            })).resolves.toMatchObject({
                operationProtocolCapabilities: {
                    sessionSpawn: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 4,
            });
        });

        it('uses provided timeout override for machine registration request', async () => {
            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture(),
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
                    publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2)).publicKey,
                    machineKey: new Uint8Array(32).fill(2),
                },
            };

            const dataKeyApi = await ApiClient.create(dataKeyCredential as any);

            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture(),
                },
            });

            await dataKeyApi.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            } as any);

            const body = mockPost.mock.calls[0]?.[1];
            expect(body?.contentPublicKey).toBe(encodeBase64(dataKeyCredential.encryption.publicKey));
        });

        it('includes explicit installation identity fields when registering a machine', async () => {
            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture(),
                },
            });

            await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                registrationIdentity: {
                    installationId: 'installation-1',
                    installationPublicKey: testInstallationPublicKey,
                    installationProof: {
                        version: 1,
                        algorithm: 'ed25519',
                        signature: Buffer.from(new Uint8Array(64)).toString('base64url'),
                    },
                    replacesMachineId: 'machine-old',
                    replacementReason: 'reauth',
                    contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
                },
            });

            const body = mockPost.mock.calls[0]?.[1];
            expect(body).toEqual(expect.objectContaining({
                installationId: 'installation-1',
                installationPublicKey: testInstallationPublicKey,
                installationProof: {
                    version: 1,
                    algorithm: 'ed25519',
                    signature: Buffer.from(new Uint8Array(64)).toString('base64url'),
                },
                replacesMachineId: 'machine-old',
                replacementReason: 'reauth',
                contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            }));
        });

        it('consumes a replacement candidate after explicit server acknowledgement', async () => {
            writeApiTestSettings({
                schemaVersion: 6,
                onboardingCompleted: true,
                activeServerId: 'cloud',
                machineIdByServerId: { cloud: 'machine-new' },
                machineReplacementCandidatesByServerIdByAccountId: {
                    cloud: {
                        'account-1': {
                            machineId: 'machine-old',
                            replacementReason: 'reauth',
                            createdAt: 123,
                        },
                    },
                },
            });

            mockPost.mockResolvedValue({
                data: {
                    machineReplacement: {
                        status: 'applied',
                        replacesMachineId: 'machine-old',
                    },
                    machine: createMachineRegistrationFixture(),
                },
            });

            await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                registrationIdentity: {
                    installationId: 'installation-1',
                    installationPublicKey: testInstallationPublicKey,
                    installationProof: {
                        version: 1,
                        algorithm: 'ed25519',
                        signature: Buffer.from(new Uint8Array(64)).toString('base64url'),
                    },
                    replacesMachineId: 'machine-old',
                    replacementReason: 'reauth',
                    replacementCandidateAccountId: 'account-1',
                },
            });

            expect(
                readApiTestSettings().machineReplacementCandidatesByServerIdByAccountId?.cloud?.['account-1'],
            ).toBeUndefined();
        });

        it('consumes a replacement candidate when the old machine already points at the new machine', async () => {
            writeApiTestSettings({
                schemaVersion: 6,
                onboardingCompleted: true,
                activeServerId: 'cloud',
                machineIdByServerId: { cloud: 'machine-new' },
                machineReplacementCandidatesByServerIdByAccountId: {
                    cloud: {
                        'account-1': {
                            machineId: 'machine-old',
                            replacementReason: 'reauth',
                            createdAt: 123,
                        },
                    },
                },
            });

            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture(),
                },
            });
            mockGet.mockImplementation(async (url: string) => url.endsWith('/v1/machines/machine-old') ? {
                data: {
                    machine: {
                        id: 'machine-old',
                        replacedByMachineId: 'test-machine',
                    },
                },
            } : readApiGetFixture(url));

            await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                registrationIdentity: {
                    installationId: 'installation-1',
                    installationPublicKey: testInstallationPublicKey,
                    installationProof: {
                        version: 1,
                        algorithm: 'ed25519',
                        signature: Buffer.from(new Uint8Array(64)).toString('base64url'),
                    },
                    replacesMachineId: 'machine-old',
                    replacementReason: 'reauth',
                    replacementCandidateAccountId: 'account-1',
                },
            });

            expect(mockGet).toHaveBeenCalledWith(
                'https://api.example.com/v1/machines/machine-old',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer fake-token',
                    }),
                }),
            );
            expect(
                readApiTestSettings().machineReplacementCandidatesByServerIdByAccountId?.cloud?.['account-1'],
            ).toBeUndefined();
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

        it('throws a stable error when the server reports that the machine was replaced', async () => {
            connectionState.reset();
            mockPost.mockResolvedValue({
                data: {
                    machine: createMachineRegistrationFixture({ replacedByMachineId: 'replacement-machine' }),
                },
            });

            await expect(
                api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                }),
            ).rejects.toMatchObject({
                name: 'MachineReplacedError',
                machineId: 'test-machine',
                replacementMachineId: 'replacement-machine',
            });

            expect(connectionState.isOffline()).toBe(false);
        });

        it('throws a stable error on 410 machine replaced with replacement id', async () => {
            connectionState.reset();
            mockPost.mockRejectedValue({
                response: {
                    status: 410,
                    data: {
                        error: 'machine_replaced',
                        replacementMachineId: 'replacement-machine',
                    },
                },
                isAxiosError: true,
            });

            await expect(
                api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                }),
            ).rejects.toMatchObject({
                name: 'MachineReplacedError',
                machineId: 'test-machine',
                replacementMachineId: 'replacement-machine',
            });

            expect(connectionState.isOffline()).toBe(false);
        });

        it('throws a stable error on 410 machine-replaced socket-style payloads', async () => {
            connectionState.reset();
            mockPost.mockRejectedValue({
                response: {
                    status: 410,
                    data: {
                        error: 'machine-replaced',
                        replacementMachineId: 'replacement-machine',
                    },
                },
                isAxiosError: true,
            });

            await expect(
                api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata,
                }),
            ).rejects.toMatchObject({
                name: 'MachineReplacedError',
                replacementMachineId: 'replacement-machine',
            });
        });

        it('throws a stable error when server rejects machine registration due to content public key mismatch', async () => {
            connectionState.reset();

            const dataKeyCredential = {
                token: 'fake-token',
                encryption: {
                    type: 'dataKey' as const,
                    publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2)).publicKey,
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
                    publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2)).publicKey,
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
