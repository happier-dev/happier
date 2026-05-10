import { describe, expect, it, vi } from 'vitest';

import { materializeBitbucketScmHostingBasicAuth } from '@happier-dev/plugins-scm-bitbucket/auth/basicAuthMaterializer';
import { materializeGithubScmHostingToken } from '@happier-dev/plugins-scm-github';
import {
    AZ_CLI_SETUP_URL,
    BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
    buildConnectedServiceCredentialRecord,
    getConnectedAccountDescriptor,
    sealAccountScopedBlobCiphertext,
    type ScmHostingProviderRef,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

import { createScmHostingProviderRuntimeServices } from './runtimeServices.js';

const legacySecret = new Uint8Array(32).fill(7);
const githubConnectedAccountDescriptor = getConnectedAccountDescriptor('github');
if (!githubConnectedAccountDescriptor) {
    throw new Error('Expected GitHub connected-account descriptor fixture');
}
const authMaterializationRegistry = {
    connectedAccountDescriptors: [
        {
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            definition: githubConnectedAccountDescriptor,
        },
        {
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            definition: BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
        },
    ],
    hookHandlersByHookId: new Map([
        [
            'connectedServices.materialization.githubScmHostingToken',
            [{
                handler: (request: unknown) => materializeGithubScmHostingToken(
                    request as Parameters<typeof materializeGithubScmHostingToken>[0],
                ),
            }],
        ],
        [
            'connectedServices.materialization.bitbucketScmHostingBasicAuth',
            [{
                handler: (request: unknown) => materializeBitbucketScmHostingBasicAuth(
                    request as Parameters<typeof materializeBitbucketScmHostingBasicAuth>[0],
                ),
            }],
        ],
    ]),
};

const legacyCredentials: Credentials = {
    token: 'account-token',
    encryption: {
        type: 'legacy',
        secret: legacySecret,
    },
};

const githubProvider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    urlSafety: { allowedSchemes: ['https:'] },
};

const enterpriseGithubProvider: ScmHostingProviderRef = {
    ...githubProvider,
    baseUrl: 'https://ghe.internal.test',
};

function githubTokenRecord(profileId: string, token: string) {
    return buildConnectedServiceCredentialRecord({
        now: 1700000000000,
        serviceId: 'github',
        profileId,
        kind: 'token',
        token: {
            token,
            providerAccountId: 'octocat',
            providerEmail: 'octocat@example.com',
        },
    });
}

function bitbucketBasicAuthRecord(profileId: string, token: string) {
    return buildConnectedServiceCredentialRecord({
        now: 1700000000000,
        serviceId: 'bitbucket',
        profileId,
        kind: 'token',
        token: {
            token,
            providerAccountId: 'dev@example.com',
            providerEmail: 'dev@example.com',
        },
    });
}

function createApi(params: Readonly<{
    plainRecord?: ReturnType<typeof githubTokenRecord> | ReturnType<typeof bitbucketBasicAuthRecord> | null;
    sealedRecord?: ReturnType<typeof githubTokenRecord> | ReturnType<typeof bitbucketBasicAuthRecord> | null;
}>) {
    return {
        getConnectedServiceCredentialPlain: vi.fn(async () => (
            params.plainRecord
                ? { content: { t: 'plain' as const, v: params.plainRecord } }
                : null
        )),
        getConnectedServiceCredentialSealed: vi.fn(async () => {
            if (!params.sealedRecord) return null;
            const ciphertext = sealAccountScopedBlobCiphertext({
                kind: 'connected_service_credential',
                material: { type: 'legacy', secret: legacySecret },
                payload: params.sealedRecord,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            });
            return {
                sealed: { format: 'account_scoped_v1' as const, ciphertext },
                metadata: { kind: 'token' as const },
            };
        }),
        listConnectedServiceProfiles: vi.fn(async () => ({
            serviceId: 'github' as const,
            profiles: [{ profileId: 'work', status: 'connected' as const, kind: 'token' as const }],
        })),
    };
}

describe('createScmHostingProviderRuntimeServices', () => {
    it('materializes plaintext GitHub connected-account tokens for github.com only', async () => {
        const api = createApi({ plainRecord: githubTokenRecord('work', '  redacted-test-token  ') });
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => legacyCredentials,
            createApi: async () => api,
            getGhDepStatus: vi.fn(),
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand: vi.fn(),
        });

        await expect(services.resolveScmHostingTokenMaterialization?.({
            kind: 'scm_hosting_token',
            providerId: 'scm.github',
            host: 'github.com',
            provider: githubProvider,
            profileId: 'work',
        })).resolves.toEqual({
            kind: 'available',
            token: 'redacted-test-token',
            profileKey: 'github:work',
        });

        await expect(services.resolveScmHostingTokenMaterialization?.({
            kind: 'scm_hosting_token',
            providerId: 'scm.github',
            host: 'ghe.internal.test',
            provider: enterpriseGithubProvider,
            profileId: 'work',
        })).resolves.toEqual({
            kind: 'missing',
            reason: 'unsupported_host',
        });
    });

    it('opens sealed GitHub connected-account credentials when plaintext storage is absent', async () => {
        const api = createApi({ sealedRecord: githubTokenRecord('work', 'sealed-redacted-token') });
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => legacyCredentials,
            createApi: async () => api,
            getGhDepStatus: vi.fn(),
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand: vi.fn(),
        });

        await expect(services.resolveScmHostingTokenMaterialization?.({
            kind: 'scm_hosting_token',
            providerId: 'scm.github',
            host: 'github.com',
            provider: githubProvider,
            profileId: 'work',
        })).resolves.toMatchObject({
            kind: 'available',
            token: 'sealed-redacted-token',
            profileKey: 'github:work',
        });
        expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalled();
        expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalled();
    });

    it('materializes Bitbucket Cloud connected-account credentials as basic auth', async () => {
        const api = createApi({ plainRecord: bitbucketBasicAuthRecord('work', '  bb-api-token  ') });
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => legacyCredentials,
            createApi: async () => api,
            getGhDepStatus: vi.fn(),
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand: vi.fn(),
        });

        await expect(services.resolveScmHostingBasicAuthMaterialization?.({
            kind: 'scm_hosting_basic_auth',
            providerId: 'scm.bitbucket',
            host: 'bitbucket.org',
            provider: {
                id: 'scm.bitbucket',
                kind: 'bitbucket',
                displayName: 'Bitbucket',
                baseUrl: 'https://bitbucket.org',
                urlSafety: { allowedSchemes: ['https:'] },
            },
            profileId: 'work',
        })).resolves.toEqual({
            kind: 'available',
            username: 'dev@example.com',
            password: 'bb-api-token',
            profileKey: 'bitbucket:work',
        });
    });

    it('reports missing credentials without creating an API client when account credentials are unavailable', async () => {
        const createApiFn = vi.fn();
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => null,
            createApi: createApiFn,
            getGhDepStatus: vi.fn(),
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand: vi.fn(),
        });

        await expect(services.resolveScmHostingTokenMaterialization?.({
            kind: 'scm_hosting_token',
            providerId: 'scm.github',
            host: 'github.com',
            provider: githubProvider,
        })).resolves.toEqual({
            kind: 'missing',
            reason: 'credential_unavailable',
        });
        expect(createApiFn).not.toHaveBeenCalled();
    });

    it('resolves dep.gh using only installed status and delegates command execution', async () => {
        const getGhDepStatus = vi.fn(async (_opts?: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean }>) => ({
            capabilityId: 'dep.gh' as const,
            installed: true,
            resolvedSource: 'managed' as const,
            binPath: '/managed/gh/current/bin/gh',
            installDir: '/managed/gh',
            managedBinPath: '/managed/gh/current/bin/gh',
            installedVersion: '2.0.0',
            sourceKind: 'github_release_binary' as const,
            authenticated: true,
            authStatus: 'authenticated' as const,
            remediationReason: null,
            lastInstallLogPath: null,
            lastBackgroundUpdateCheckAtMs: null,
        }));
        const runCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', exitCode: 0 }));
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => legacyCredentials,
            createApi: async () => createApi({}),
            getGhDepStatus,
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand,
        });

        await expect(services.resolveInstallableCommand?.({ capabilityId: 'dep.gh' })).resolves.toEqual({
            kind: 'available',
            source: 'managed',
            binPath: '/managed/gh/current/bin/gh',
        });
        expect(getGhDepStatus).toHaveBeenCalledWith({ onlyIfInstalled: true });

        await expect(services.runCommand?.({
            binPath: '/managed/gh/current/bin/gh',
            args: ['auth', 'status'],
            timeoutMs: 1000,
        })).resolves.toEqual({ ok: true, stdout: 'ok', stderr: '', exitCode: 0 });
        expect(runCommand).toHaveBeenCalledWith({
            binPath: '/managed/gh/current/bin/gh',
            args: ['auth', 'status'],
            timeoutMs: 1000,
        });
    });

    it('resolves dep.az as a system-only provider CLI dependency', async () => {
        const getAzDepStatus = vi.fn(async (_opts?: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean }>) => ({
            capabilityId: 'dep.az' as const,
            installed: true,
            resolvedSource: 'system' as const,
            binPath: '/usr/local/bin/az',
            installDir: null,
            managedBinPath: null,
            installedVersion: '2.72.0',
            sourceKind: 'manual_only' as const,
            authenticated: true,
            authStatus: 'authenticated' as const,
            remediationReason: null,
            setupUrl: AZ_CLI_SETUP_URL,
            loginCommand: ['az', 'login'] as const,
            accountName: 'dev@example.com',
            tenantId: 'tenant-1',
            lastInstallLogPath: null,
            lastBackgroundUpdateCheckAtMs: null,
        }));
        const services = createScmHostingProviderRuntimeServices({
            readCredentials: async () => legacyCredentials,
            createApi: async () => createApi({}),
            getGhDepStatus: vi.fn(),
            getAzDepStatus,
            resolveAuthMaterializationRegistry: async () => authMaterializationRegistry,
            runCommand: vi.fn(),
        });

        await expect(services.resolveInstallableCommand?.({ capabilityId: 'dep.az' })).resolves.toEqual({
            kind: 'available',
            source: 'system',
            binPath: '/usr/local/bin/az',
        });
        expect(getAzDepStatus).toHaveBeenCalledWith({ onlyIfInstalled: true });
    });
});
