import {
    accountSettingsParse,
    resolveAccountSettingsPluginSecret,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    clearActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
    type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createAccountPluginSecretCustodyRouter } from './accountPluginSecretCustody';
import {
    createDeclaredPluginSecretsService,
    createPluginSecretCustodyRouter,
} from './secrets';

const {
    axiosGetMock,
    axiosPostMock,
    readStoredCredentialsMock,
} = vi.hoisted(() => ({
    axiosGetMock: vi.fn(),
    axiosPostMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: axiosGetMock,
        post: axiosPostMock,
    },
    get: axiosGetMock,
    post: axiosPostMock,
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: () => readStoredCredentialsMock(),
}));

describe('createAccountPluginSecretCustodyRouter', () => {
    it('creates and binds a SavedSecret through one explicit Account Settings version', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const updateOnce = vi.fn(async (input: Readonly<{
            expectedVersion: number;
            mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
            assertCurrent(): void;
        }>) => {
            input.assertCurrent();
            snapshot = {
                ...snapshot,
                settings: accountSettingsParse(input.mutate(snapshot.settings)),
                settingsVersion: 5,
            };
            return Object.freeze({
                status: 'applied' as const,
                version: snapshot.settingsVersion,
                settings: snapshot.settings,
            });
        });
        const owner = {
            readSnapshot: () => snapshot,
            updateOnce,
        };
        // The test owns an in-memory Account Settings boundary, not router internals.
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toBeNull();

        const result = await custody.set({ secretId: 'token', value: 'raw-secret' });

        expect(result.revision).toMatch(/^account-secret-r1:/u);
        expect(updateOnce).toHaveBeenCalledTimes(1);
        expect(updateOnce).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4 }));
        await expect(custody.status('token')).resolves.toMatchObject({
            state: 'configured',
            revision: result.revision,
        });
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toMatchObject({
            binding: { savedSecretId: 'saved-secret-1', createdForBinding: true },
            secret: { id: 'saved-secret-1' },
        });
    });

    it('binds an existing SavedSecret without accepting or returning its material', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({
                secrets: [{
                    id: 'saved-secret-existing',
                    name: 'Existing',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        encryptedValue: { t: 'enc-v1', c: 'ciphertext' },
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                    settingsVersion: 5,
                };
                return Object.freeze({
                    status: 'applied' as const,
                    version: snapshot.settingsVersion,
                    settings: snapshot.settings,
                });
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });

        const result = await router.bindExisting({
            pluginId: 'acme.example',
            secretId: 'token',
            savedSecretId: 'saved-secret-existing',
        });

        expect(result).toEqual({ revision: expect.stringMatching(/^account-secret-r1:/u) });
        expect(JSON.stringify(result)).not.toContain('ciphertext');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toMatchObject({
            binding: { savedSecretId: 'saved-secret-existing', createdForBinding: false },
        });
    });

    it('unbinds an Account plugin secret without deleting the SavedSecret it referenced', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({
                secrets: [{
                    id: 'saved-secret-existing',
                    name: 'Existing',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        encryptedValue: { t: 'enc-v1', c: 'ciphertext' },
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
                pluginSecretBindingsV1: {
                    '["acme.example","account","token"]': {
                        pluginId: 'acme.example',
                        custody: 'account',
                        localId: 'token',
                        savedSecretId: 'saved-secret-existing',
                        createdForBinding: true,
                    },
                },
            }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input: Readonly<{
                    expectedVersion: number;
                    mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                    assertCurrent(): void;
                }>) {
                    input.assertCurrent();
                    snapshot = {
                        ...snapshot,
                        settings: accountSettingsParse(input.mutate(snapshot.settings)),
                        settingsVersion: 5,
                    };
                    return Object.freeze({
                        status: 'applied' as const,
                        version: snapshot.settingsVersion,
                        settings: snapshot.settings,
                    });
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });

        await expect(router.unbind({
            pluginId: 'acme.example',
            secretId: 'token',
        })).resolves.toEqual({ revision: expect.stringMatching(/^account-secret-r1:/u) });
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: 'acme.example',
            localId: 'token',
        })).toBeNull();
        expect((snapshot.settings.secrets as readonly { id: string }[]).map(({ id }) => id))
            .toEqual(['saved-secret-existing']);
    });

    it.each([
        {
            label: 'an Account switch',
            next: {
                source: 'network' as const,
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:b',
            },
        },
        { label: 'logout', next: null },
    ])('fails closed after $label instead of rebinding an existing custody object', async ({ next }) => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const updateOnce = vi.fn(async () => {
            throw new Error('A retired Account custody must not reach Account Settings CAS');
        });
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                updateOnce,
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        snapshot = next;

        await expect(custody.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        await expect(custody.get('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        await expect(custody.set({ secretId: 'token', value: 'must-not-rebind' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
        expect(updateOnce).not.toHaveBeenCalled();
    });

    it('binds Account custody when the invocation service is created, not on its first secret read', async () => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const accountCustody = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce() {
                    throw new Error('not reached by a status read');
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const service = createDeclaredPluginSecretsService({
            pluginId: 'acme.example',
            declarations: [{ id: 'token', custody: 'account' }],
            resolveCustody: createPluginSecretCustodyRouter({
                account: accountCustody.resolve,
            }).resolve,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            registerRawForRedaction: () => {},
        });

        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:b',
        };

        await expect(service.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
    });

    it('does not revive an Account service after Account A transitions through B and returns to A', async () => {
        const controller = new AbortController();
        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isGenerationCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:b',
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 5,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });

            await expect(service.status('token')).rejects.toMatchObject({
                code: 'plugin_secret_custody_unavailable',
            });
        } finally {
            controller.abort();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('keeps a production Account service usable when its active Account snapshot advances from v4 to v5', async () => {
        const controller = new AbortController();
        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isGenerationCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 5,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'account:a',
            });

            await expect(service.status('token')).resolves.toMatchObject({ state: 'missing' });
        } finally {
            controller.abort();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('keeps a production Account service usable after its own settled v4-to-v5 secret mutation', async () => {
        const controller = new AbortController();
        const credentials = {
            token: 'account-a',
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
        };
        resetActiveAccountSettingsSnapshotForTests();
        readStoredCredentialsMock.mockResolvedValue(credentials);
        axiosGetMock.mockImplementation(async (url: string) => {
            if (url.endsWith('/v2/account/settings')) {
                return { status: 200, data: { content: { t: 'plain', v: {} }, version: 4 } };
            }
            if (url.endsWith('/v1/account/encryption')) {
                return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            }
            throw new Error(`unexpected account settings request: ${url}`);
        });
        axiosPostMock.mockResolvedValue({ status: 200, data: { success: true, version: 5 } });
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials),
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isGenerationCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            const result = await service.set('token', 'raw-secret');

            expect(axiosPostMock).toHaveBeenCalledTimes(1);
            expect(result.revision).toMatch(/^account-secret-r1:/u);
            await expect(service.status('token')).resolves.toMatchObject({
                state: 'configured',
                revision: result.revision,
            });
        } finally {
            controller.abort();
            axiosGetMock.mockReset();
            axiosPostMock.mockReset();
            readStoredCredentialsMock.mockReset();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('does not republish an outcome-unknown SavedSecret write after its Account lifetime is cleared', async () => {
        const controller = new AbortController();
        const credentials = {
            token: 'account-a',
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
        };
        let accountSettingsReads = 0;
        let submittedContent: unknown = null;
        let releaseAuthoritativeReread!: () => void;
        resetActiveAccountSettingsSnapshotForTests();
        readStoredCredentialsMock.mockResolvedValue(credentials);
        axiosGetMock.mockImplementation((url: string) => {
            if (url.endsWith('/v2/account/settings')) {
                accountSettingsReads += 1;
                if (accountSettingsReads === 1) {
                    return Promise.resolve({
                        status: 200,
                        data: { content: { t: 'plain', v: {} }, version: 4 },
                    });
                }
                return new Promise((resolve) => {
                    releaseAuthoritativeReread = () => resolve({
                        status: 200,
                        data: { content: submittedContent, version: 5 },
                    });
                });
            }
            if (url.endsWith('/v1/account/encryption')) {
                return Promise.resolve({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
            }
            throw new Error(`unexpected account settings request: ${url}`);
        });
        axiosPostMock.mockImplementation(async (_url: string, body: { content: unknown }) => {
            submittedContent = body.content;
            throw new Error('connection reset after submitted Account Settings write');
        });
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 4,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials),
            });
            const accountCustody = createAccountPluginSecretCustodyRouter();
            const service = createDeclaredPluginSecretsService({
                pluginId: 'acme.example',
                declarations: [{ id: 'token', custody: 'account' }],
                resolveCustody: createPluginSecretCustodyRouter({
                    account: accountCustody.resolve,
                }).resolve,
                signal: controller.signal,
                isGenerationCurrent: () => true,
                registerRawForRedaction: () => {},
            });

            const pending = service.set('token', 'raw-secret');
            await vi.waitFor(() => expect(accountSettingsReads).toBe(2));
            clearActiveAccountSettingsSnapshot();
            releaseAuthoritativeReread();

            await expect(pending).rejects.toMatchObject({
                code: 'plugin_secret_outcome_unknown',
            });
            expect(getActiveAccountSettingsSnapshot()).toBeNull();
        } finally {
            controller.abort();
            axiosGetMock.mockReset();
            axiosPostMock.mockReset();
            readStoredCredentialsMock.mockReset();
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('uses the captured Account lifetime rather than scope equality after A transitions through B and back to A', async () => {
        let snapshot: ActiveAccountSettingsSnapshot | null = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        let lifetimeToken = 1;
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                readLifetimeToken: () => lifetimeToken,
                async updateOnce() {
                    throw new Error('a retired Account custody must not reach Account Settings CAS');
                },
            } as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:b',
        };
        lifetimeToken += 1;
        snapshot = {
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 5,
            loadedAtMs: 3,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        lifetimeToken += 1;

        await expect(custody.status('token')).rejects.toMatchObject({
            code: 'plugin_secret_custody_unavailable',
        });
    });

    it('accepts a lost write response only after an authoritative reread proves the exact SavedSecret postcondition', async () => {
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        let submitted: Readonly<Record<string, unknown>> | null = null;
        let submittedWithoutResponse = false;
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                submitted = input.mutate(snapshot.settings);
                submittedWithoutResponse = true;
                return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: 4 });
            },
            async rereadAfterAmbiguousWrite() {
                if (!submitted) throw new Error('expected submitted mutation');
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(submitted),
                    settingsVersion: 5,
                };
                return snapshot;
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            // The test owns an in-memory Account Settings boundary, not router internals.
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({
            secretId: 'token',
            value: 'raw-secret',
            assertCurrent: () => {
                if (!submittedWithoutResponse) return;
                throw new PluginError({
                    code: 'plugin_invocation_retired',
                    message: 'plugin invocation retired after submission',
                });
            },
        })).resolves.toMatchObject({
            revision: expect.stringMatching(/^account-secret-r1:/u),
        });
    });

    it('does not let post-ack currentness hide an acknowledged SavedSecret mutation', async () => {
        let acknowledged = false;
        let snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const rereadAfterAmbiguousWrite = vi.fn(async () => snapshot);
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                snapshot = {
                    ...snapshot,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                    settingsVersion: 5,
                };
                acknowledged = true;
                return Object.freeze({
                    status: 'applied' as const,
                    version: snapshot.settingsVersion,
                    settings: snapshot.settings,
                });
            },
            rereadAfterAmbiguousWrite,
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({
            secretId: 'token',
            value: 'raw-secret',
            assertCurrent: () => {
                if (!acknowledged) return;
                throw new PluginError({
                    code: 'plugin_invocation_retired',
                    message: 'plugin invocation retired after submission',
                });
            },
        })).resolves.toMatchObject({
            revision: expect.stringMatching(/^account-secret-r1:/u),
        });
        expect(rereadAfterAmbiguousWrite).not.toHaveBeenCalled();
    });

    it('does not accept a satisfied Account Settings result until the exact SavedSecret postcondition is reread', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const rereadAfterAmbiguousWrite = vi.fn(async () => snapshot);
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                return Object.freeze({
                    status: 'satisfied' as const,
                    version: 5,
                    settings: accountSettingsParse(input.mutate(snapshot.settings)),
                });
            },
            rereadAfterAmbiguousWrite,
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_outcome_unknown',
        });
        expect(rereadAfterAmbiguousWrite).toHaveBeenCalledTimes(1);
    });

    it('preserves pre-submission cancellation and request-size refusal as distinct plugin errors', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input) {
                    input.assertCurrent();
                    return Object.freeze({ status: 'cancelled' as const, submitted: false as const });
                },
            },
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_cancelled',
        });

        const tooLargeRouter = createAccountPluginSecretCustodyRouter({
            owner: {
                readSnapshot: () => snapshot,
                async updateOnce(input) {
                    input.assertCurrent();
                    return Object.freeze({ status: 'invalid' as const, reason: 'tooLarge' as const });
                },
            },
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const tooLargeCustody = tooLargeRouter.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!tooLargeCustody) throw new Error('expected Account custody');

        await expect(tooLargeCustody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_custody_too_large',
        });
    });

    it('reports an unknown outcome when the authoritative reread cannot prove the submitted SavedSecret postcondition', async () => {
        const snapshot: ActiveAccountSettingsSnapshot = {
            source: 'network',
            settings: accountSettingsParse({ secrets: [] }),
            settingsVersion: 4,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account:a',
        };
        const owner = {
            readSnapshot: () => snapshot,
            async updateOnce(input: Readonly<{
                expectedVersion: number;
                mutate(settings: Readonly<Record<string, unknown>>): Record<string, unknown>;
                assertCurrent(): void;
            }>) {
                input.assertCurrent();
                input.mutate(snapshot.settings);
                return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: 4 });
            },
            async rereadAfterAmbiguousWrite() {
                // The server may have accepted or rejected the request; this
                // still-current document proves neither outcome.
                return snapshot;
            },
        };
        const router = createAccountPluginSecretCustodyRouter({
            owner: owner as unknown as NonNullable<Parameters<typeof createAccountPluginSecretCustodyRouter>[0]>['owner'],
            createId: () => 'saved-secret-1',
            nowMs: () => 10,
        });
        const custody = router.resolve({
            pluginId: 'acme.example',
            declaration: { id: 'token', custody: 'account' },
        });
        if (!custody) throw new Error('expected Account custody');

        await expect(custody.set({ secretId: 'token', value: 'raw-secret' })).rejects.toMatchObject({
            code: 'plugin_secret_outcome_unknown',
        });
    });
});
