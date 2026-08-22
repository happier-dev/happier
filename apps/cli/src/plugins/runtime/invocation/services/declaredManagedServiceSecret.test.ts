import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    createDaemonPluginSecretCustodyRouter,
    createPluginSecretCustodyRouter,
    createStableDeclaredPluginSecretsHost,
    type PluginSecretCustody,
} from '@/plugins/runtime/context/secrets';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { createDeclaredManagedServiceSecretResolver } from './declaredManagedServiceSecret';

const scope = Object.freeze({
    generation: 'generation-1',
    pluginId: 'acme.managed-service',
    contributionQualifiedId: 'acme.managed-service/agents/managed',
    isGenerationCurrent: () => true,
});

type DeclaredSecretLease = Readonly<{
    value: string | null;
    revision: string;
    isCurrent(signal?: AbortSignal): Promise<boolean>;
}>;

function expectDeclaredSecretLease(value: unknown): asserts value is DeclaredSecretLease {
    expect(value).toMatchObject({
        revision: expect.any(String),
        isCurrent: expect.any(Function),
    });
    expect(value).toHaveProperty('value');
}

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolver) => {
        resolve = resolver;
    });
    return Object.freeze({ promise, resolve });
}

describe('declared managed-service secret resolver', () => {
    it('binds a declared daemon secret to one canonical origin without reading the retained global value', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-managed-secret-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const originOne = 'https://one.example.test';
        const originTwo = 'https://two.example.test';
        const resolveDeviceLocalSecretStorage = async () => Object.freeze({
            deriveSecretKey: () => new Uint8Array(32).fill(7),
        });
        try {
            const daemonCustody = createDaemonPluginSecretCustodyRouter({
                paths,
                resolveDeviceLocalSecretStorage,
            });
            const daemonPassword = daemonCustody.resolve({
                pluginId: scope.pluginId,
                declaration: { id: 'daemon-password', custody: 'daemon' },
            });
            const accountPassword = daemonCustody.resolve({
                pluginId: scope.pluginId,
                declaration: { id: 'account-password', custody: 'daemon' },
            });
            if (!daemonPassword || !accountPassword) throw new Error('Expected daemon custody');

            // Retain the old unscoped value exactly as stored. An origin
            // binding must be an explicit write, never an automatic copy.
            await daemonPassword.set({ secretId: 'daemon-password', value: 'legacy-global-secret' });
            const originOneBinding = Object.freeze({
                secretId: 'daemon-password',
                value: 'origin-one-secret',
                canonicalOrigin: originOne,
            });
            await daemonPassword.set(originOneBinding);
            await accountPassword.set({ secretId: 'account-password', value: 'must-not-read' });
            const secretsHost = createStableDeclaredPluginSecretsHost({
                declarations: [{
                    pluginId: scope.pluginId,
                    declaration: {
                        id: 'daemon-password',
                        custody: 'daemon',
                        managedServiceOrigin: { endpointSettingId: 'endpoint' },
                    },
                }, {
                    pluginId: scope.pluginId,
                    declaration: { id: 'account-password', custody: 'account' },
                }],
                resolveCustody: createPluginSecretCustodyRouter({
                    daemon: daemonCustody.resolve,
                }).resolve,
            });
            const declaredSecretReadPort = secretsHost.bindManagedServiceSecretReadPort({
                pluginId: scope.pluginId,
                signal: new AbortController().signal,
                isGenerationCurrent: scope.isGenerationCurrent,
                registerRawForRedaction: () => {},
            });
            if (!declaredSecretReadPort) throw new Error('Expected declared secret read port');
            const resolveSecret = createDeclaredManagedServiceSecretResolver();
            const declaredScope = Object.freeze({ ...scope, declaredSecretReadPort });
            const query = (secretId: string, canonicalOrigin: string) => Object.freeze({
                scope: declaredScope,
                secretId,
                canonicalOrigin,
            });

            const daemonLease = await resolveSecret(query('daemon-password', originOne));
            expectDeclaredSecretLease(daemonLease);
            expect(daemonLease.value).toBe('origin-one-secret');
            await expect(daemonLease.isCurrent()).resolves.toBe(true);
            // The old encrypted value remains available to its old explicit
            // owner but is never an attach fallback.
            expect((await daemonPassword.get('daemon-password'))?.value)
                .toBe('legacy-global-secret');
            const foreignOriginLease = await resolveSecret(query('daemon-password', originTwo));
            expectDeclaredSecretLease(foreignOriginLease);
            expect(foreignOriginLease.value).toBeNull();
            await expect(resolveSecret(query('account-password', originOne)))
                .resolves.toBeNull();
            await expect(resolveSecret(query('not-declared', originOne)))
                .resolves.toBeNull();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps retained G on its admitted daemon declaration while H uses its own declaration and live custody state', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-managed-secret-generation-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const managedOrigin = 'http://127.0.0.1:4312';
        const resolveDeviceLocalSecretStorage = async () => Object.freeze({
            deriveSecretKey: () => new Uint8Array(32).fill(11),
        });
        let gCurrent = true;
        try {
            const daemonCustody = createDaemonPluginSecretCustodyRouter({
                paths,
                resolveDeviceLocalSecretStorage,
            });
            const custody = createPluginSecretCustodyRouter({
                daemon: daemonCustody.resolve,
            });
            const gSecretsHost = createStableDeclaredPluginSecretsHost({
                declarations: [{
                    pluginId: scope.pluginId,
                    declaration: {
                        id: 'g-password',
                        custody: 'daemon',
                        managedServiceOrigin: { endpointSettingId: 'endpoint' },
                    },
                }],
                resolveCustody: custody.resolve,
            });
            const hSecretsHost = createStableDeclaredPluginSecretsHost({
                declarations: [{
                    pluginId: scope.pluginId,
                    declaration: { id: 'h-password', custody: 'account' },
                }],
                resolveCustody: custody.resolve,
            });
            const gSecretReadPort = gSecretsHost.bindManagedServiceSecretReadPort({
                pluginId: scope.pluginId,
                signal: new AbortController().signal,
                isGenerationCurrent: () => gCurrent,
                registerRawForRedaction: () => {},
            });
            const hSecretReadPort = hSecretsHost.bindManagedServiceSecretReadPort({
                pluginId: scope.pluginId,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                registerRawForRedaction: () => {},
            });
            if (!gSecretReadPort || !hSecretReadPort) throw new Error('Expected declared secret read ports');
            const gScope = Object.freeze({
                ...scope,
                generation: 'G',
                isGenerationCurrent: () => gCurrent,
                declaredSecretReadPort: gSecretReadPort,
            });
            const hScope = Object.freeze({
                ...scope,
                generation: 'H',
                declaredSecretReadPort: hSecretReadPort,
            });
            const gPassword = daemonCustody.resolve({
                pluginId: scope.pluginId,
                declaration: { id: 'g-password', custody: 'daemon' },
            });
            if (!gPassword) throw new Error('Expected G daemon custody');
            const initial = await gPassword.status('g-password', { canonicalOrigin: managedOrigin });
            await gPassword.set({
                secretId: 'g-password',
                value: 'g-password-v1',
                canonicalOrigin: managedOrigin,
                expectedRevision: initial.revision,
            });

            // G and H bind different normalized declaration sets. The
            // retained call must use G's daemon port while the H port cannot
            // reinterpret or access G's identifier.
            const resolveSecret = createDeclaredManagedServiceSecretResolver();

            const firstLease = await resolveSecret({
                scope: gScope,
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
            });
            expectDeclaredSecretLease(firstLease);
            expect(firstLease.value).toBe('g-password-v1');
            await expect(resolveSecret({
                scope: hScope,
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
            }))
                .resolves.toBeNull();

            const configured = await gPassword.status('g-password', { canonicalOrigin: managedOrigin });
            await gPassword.set({
                secretId: 'g-password',
                value: 'g-password-v2',
                canonicalOrigin: managedOrigin,
                expectedRevision: configured.revision,
            });
            const secondLease = await resolveSecret({
                scope: gScope,
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
            });
            expectDeclaredSecretLease(secondLease);
            expect(secondLease.value).toBe('g-password-v2');
            await expect(firstLease.isCurrent()).resolves.toBe(false);

            const rotated = await gPassword.status('g-password', { canonicalOrigin: managedOrigin });
            await gPassword.delete({
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
                expectedRevision: rotated.revision,
            });
            const missingLease = await resolveSecret({
                scope: gScope,
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
            });
            expectDeclaredSecretLease(missingLease);
            expect(missingLease.value).toBeNull();

            const missing = await gPassword.status('g-password', { canonicalOrigin: managedOrigin });
            await gPassword.set({
                secretId: 'g-password',
                value: 'g-password-v3',
                canonicalOrigin: managedOrigin,
                expectedRevision: missing.revision,
            });
            await expect(missingLease.isCurrent()).resolves.toBe(false);

            gCurrent = false;
            await expect(resolveSecret({
                scope: gScope,
                secretId: 'g-password',
                canonicalOrigin: managedOrigin,
            }))
                .resolves.toBeNull();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps the exact custody revision with concurrent reads so a late older value cannot be dispatched', async () => {
        const oldGet = deferred<Readonly<{ value: string; revision: string }>>();
        let current: Readonly<{ value: string; revision: string }> = Object.freeze({
            value: 'old-secret',
            revision: 'secret-r1:old',
        });
        const custody = Object.freeze({
            status: vi.fn(async () => Object.freeze({
                state: 'configured' as const,
                revision: current.revision,
            })),
            get: vi.fn(async () => {
                if (current.revision === 'secret-r1:old') {
                    return await oldGet.promise;
                }
                return current;
            }),
            async set() {
                throw new Error('not used by this read-only test');
            },
            async delete() {
                throw new Error('not used by this read-only test');
            },
        }) satisfies PluginSecretCustody;
        const secretsHost = createStableDeclaredPluginSecretsHost({
            declarations: [{
                pluginId: scope.pluginId,
                declaration: {
                    id: 'daemon-password',
                    custody: 'daemon',
                    managedServiceOrigin: { endpointSettingId: 'endpoint' },
                },
            }],
            resolveCustody: () => custody,
        });
        const readPort = secretsHost.bindManagedServiceSecretReadPort({
            pluginId: scope.pluginId,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            registerRawForRedaction: () => {},
        });
        if (!readPort) throw new Error('Expected declared secret read port');
        const resolveSecret = createDeclaredManagedServiceSecretResolver();
        const declaredScope = Object.freeze({ ...scope, declaredSecretReadPort: readPort });

        const olderRead = resolveSecret({
            scope: declaredScope,
            secretId: 'daemon-password',
            canonicalOrigin: 'http://127.0.0.1:4312',
        });
        await vi.waitFor(() => expect(custody.get).toHaveBeenCalledOnce());

        current = Object.freeze({ value: 'new-secret', revision: 'secret-r1:new' });
        const newerLease = await resolveSecret({
            scope: declaredScope,
            secretId: 'daemon-password',
            canonicalOrigin: 'http://127.0.0.1:4312',
        });
        expectDeclaredSecretLease(newerLease);
        expect(newerLease.value).toBe('new-secret');

        oldGet.resolve(Object.freeze({
            value: 'old-secret',
            revision: 'secret-r1:old',
        }));
        const olderLease = await olderRead;
        expectDeclaredSecretLease(olderLease);
        expect(olderLease.value).toBe('old-secret');
        await expect(newerLease.isCurrent()).resolves.toBe(true);
        await expect(olderLease.isCurrent()).resolves.toBe(false);
    });
});
