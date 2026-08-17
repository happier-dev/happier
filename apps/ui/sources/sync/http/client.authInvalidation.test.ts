import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const readNoPendingExternalAuth = async () => ({
    value: null,
    serverMismatch: false,
});
const classifyNoRejectedCredential =
    async () => ({ kind: 'allowed' as const });

describe('serverFetch auth invalidation', () => {
    it('retains marked first-key custody and credential bytes without retrying the rejected bearer', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const storedCredentials = {
            token: 'token-invalid',
            secret: 'secret-a',
        };
        const recoveredCredentials = {
            token: 'token-recovered',
            secret: 'secret-a',
        };
        let currentCredentials:
            | typeof storedCredentials
            | typeof recoveredCredentials
            | null = storedCredentials;
        const markedCustody = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a',
            serverUrl: 'http://localhost:3012',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending-a',
                createdAt: 1,
                expiresAt: Number.MAX_SAFE_INTEGER,
                migrationSubmissionAttempted: true as const,
            },
        };
        const getCredentials = vi.fn(
            async () => currentCredentials,
        );
        let persistedRejectedToken:
            string | null = null;
        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials,
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    vi.fn(async ({
                        token,
                    }: {
                        token: string;
                    }) =>
                        token
                        === persistedRejectedToken
                            ? {
                                kind:
                                    'rejected',
                                pending:
                                    markedCustody,
                            } as const
                            : {
                                kind:
                                    'allowed',
                            } as const),
                readPendingExternalAuthStateForServerUrl: vi.fn(async () => ({
                    value: markedCustody,
                    serverMismatch: false,
                })),
                markPendingExternalAuthFirstKeyRejectedCredential:
                    vi.fn(async ({
                        expected,
                        token,
                    }: {
                        expected:
                            typeof markedCustody;
                        token: string;
                    }) => {
                        if (
                            currentCredentials?.token
                            !== token
                        ) {
                            return {
                                kind:
                                    'not_current',
                            } as const;
                        }
                        persistedRejectedToken =
                            token;
                        return {
                                kind:
                                    'recorded',
                                pending: {
                                    ...expected,
                                    accountEncryptionFirstKey: {
                                        ...expected
                                            .accountEncryptionFirstKey,
                                        rejectedCredentialTokenDigest:
                                            'A'.repeat(43),
                                    },
                                },
                            } as const;
                    }),
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const notifyAuthCredentialsInvalidated = vi.fn();
        vi.doMock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
            notifyAuthCredentialsInvalidated,
        }));

        const fetchMock = vi.fn(async (
            input: unknown,
            init?: RequestInit,
        ) => {
            const url = String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                };
            }
            const requestHeaders = new Headers(
                init?.headers,
            );
            if (
                requestHeaders.get('Authorization')
                === `Bearer ${recoveredCredentials.token}`
            ) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                };
            }
            return {
                ok: false,
                status: 401,
                headers: new Headers(),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const response = await serverFetch('/v1/machines');

        expect(response.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).not.toHaveBeenCalled();
        expect(getCredentials).toHaveBeenCalledTimes(1);
        expect(await getCredentials.mock.results[0]?.value).toBe(storedCredentials);
        expect(notifyAuthCredentialsInvalidated).toHaveBeenCalledWith({
            kind: 'first_key_recovery_required',
            serverId: 'server-a',
            serverUrl: 'http://localhost:3012',
            recovery: expect.objectContaining({
                pending: expect.objectContaining({
                    ...markedCustody,
                    accountEncryptionFirstKey:
                        expect.objectContaining({
                            ...markedCustody
                                .accountEncryptionFirstKey,
                            rejectedCredentialTokenDigest:
                                'A'.repeat(43),
                        }),
                }),
            }),
        });
        expect(fetchMock.mock.calls.filter(
            ([input]) => String(input).endsWith('/v1/machines'),
        )).toHaveLength(1);
        const {
            peekServerReachabilityToken,
        } = await import(
            '@/sync/runtime/connectivity/serverReachabilitySupervisorPool'
        );
        expect(
            peekServerReachabilityToken(
                'http://localhost:3012',
            ),
        ).toBeNull();

        const repeatedResponse =
            await serverFetch('/v1/machines');
        expect(repeatedResponse.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated)
            .toHaveBeenCalledTimes(1);
        const repeatedRequests =
            fetchMock.mock.calls.filter(
                ([input]) =>
                    String(input)
                        .endsWith('/v1/machines'),
            );
        expect(
            new Headers(
                repeatedRequests[1]?.[1]?.headers,
            ).get('Authorization'),
        ).toBeNull();

        const explicitRepeatedResponse =
            await serverFetch('/v1/machines', {
                headers: {
                    Authorization:
                        `Bearer ${storedCredentials.token}`,
                },
            }, { includeAuth: false });
        expect(explicitRepeatedResponse.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated)
            .toHaveBeenCalledTimes(1);
        const explicitRepeatedRequests =
            fetchMock.mock.calls.filter(
                ([input]) =>
                    String(input)
                        .endsWith('/v1/machines'),
            );
        expect(
            new Headers(
                explicitRepeatedRequests[2]?.[1]
                    ?.headers,
            ).get('Authorization'),
        ).toBeNull();

        currentCredentials = recoveredCredentials;
        const recoveredResponse =
            await serverFetch('/v1/machines');
        expect(recoveredResponse.status).toBe(200);
        const recoveredRequests =
            fetchMock.mock.calls.filter(
                ([input]) =>
                    String(input)
                        .endsWith('/v1/machines'),
            );
        expect(
            new Headers(
                recoveredRequests[3]?.[1]?.headers,
            ).get('Authorization'),
        ).toBe(
            `Bearer ${recoveredCredentials.token}`,
        );

        const staleResponse =
            await serverFetch('/v1/machines', {
                headers: {
                    Authorization:
                        `Bearer ${storedCredentials.token}`,
                },
            }, {
                includeAuth: false,
                retry: 'none',
            });
        expect(staleResponse.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated)
            .toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl)
            .not.toHaveBeenCalled();

        const currentResponse =
            await serverFetch(
                '/v1/machines',
                undefined,
                { retry: 'none' },
            );
        expect(currentResponse.status).toBe(200);
        const currentRequests =
            fetchMock.mock.calls.filter(
                ([input]) =>
                    String(input)
                        .endsWith('/v1/machines'),
            );
        expect(
            new Headers(
                currentRequests[5]?.[1]?.headers,
            ).get('Authorization'),
        ).toBe(
            `Bearer ${recoveredCredentials.token}`,
        );
    });

    it('invalidates stored credentials when the server returns 401 for an authenticated request', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 'token-invalid', secret: 'secret-a' })),
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    classifyNoRejectedCredential,
                readPendingExternalAuthStateForServerUrl: readNoPendingExternalAuth,
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines');

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid', {
            serverId: 'server-a',
        });
    });

    it('invalidates stored credentials when includeAuth=false but an Authorization header is present', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    classifyNoRejectedCredential,
                readPendingExternalAuthStateForServerUrl: readNoPendingExternalAuth,
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid', {
            serverId: 'server-a',
        });
    });

    it('retries idempotent requests once with refreshed credentials after invalidating a rejected token', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        const getCredentials = vi.fn(async () => ({ token: 'token-refreshed', secret: 'secret-a' }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials,
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    classifyNoRejectedCredential,
                readPendingExternalAuthStateForServerUrl: readNoPendingExternalAuth,
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        let profileCalls = 0;
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/account/profile')) {
                const response = profileCalls === 0
                    ? { ok: false, status: 401, headers: new Headers() }
                    : { ok: true, status: 200, headers: new Headers() };
                profileCalls += 1;
                return response;
            }
            return { ok: true, status: 200, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/account/profile', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(resp.status).toBe(200);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(getCredentials).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/account/profile'))).toHaveLength(2);
    });

    it('emits an auth-credential invalidation notification when a bearer token is rejected', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const notifyAuthCredentialsInvalidated = vi.fn();
        vi.doMock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
            notifyAuthCredentialsInvalidated,
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    classifyNoRejectedCredential,
                readPendingExternalAuthStateForServerUrl: readNoPendingExternalAuth,
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => true),
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const response = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(response.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
        expect(notifyAuthCredentialsInvalidated).toHaveBeenCalledWith({
            kind: 'credentials_removed',
            serverId: 'server-a',
            serverUrl: 'http://localhost:3012',
        });
    });

    it('does not emit an auth-credential invalidation notification when the stored credentials were not invalidated', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const notifyAuthCredentialsInvalidated = vi.fn();
        vi.doMock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
            notifyAuthCredentialsInvalidated,
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    classifyNoRejectedCredential,
                readPendingExternalAuthStateForServerUrl: readNoPendingExternalAuth,
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const response = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(response.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated).not.toHaveBeenCalled();
    });
});
