import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ConnectedAccountBindingSummary as PluginConnectedAccountBindingSummary,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk';

import type {
    StablePluginConnectedAccountsOwner,
} from './invocation/services/connectedAccounts';
import type {
    QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
    HostCurrentSessionInteractionsService,
    HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { StoredCredentials } from '@/persistence';
import {
    createResolvedContributionRegistry,
    resolveMergedContributionRegistry,
} from '../projection/registry/createResolvedContributionRegistry';
import {
    resolveExecutablePluginRuntimeRegistry,
    type PluginRuntimeNetworkDependencies,
    type ResolvedExecutablePluginRuntimeRegistry,
} from './resolveExecutablePluginRuntimeRegistry';
import type {
    PinnedHttpStreamRequest,
    PinnedHttpStreamResponse,
} from '@/network/pinnedHttp';
import type { AccountPluginDataStorageHostDependencies } from './context/accountPluginDataStorage';
import {
    createConnectedAccountAuthenticationAttemptOwner,
} from './connectedAccounts/authenticationAttemptOwner';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
} from './connectedAccounts/contributionRegistry';

const temporaryRoots: string[] = [];

const resolveDevelopmentSourceAuthority = ({
    pluginId,
    rootPath,
}: Readonly<{ pluginId: string; rootPath: string }>) => Object.freeze({
    kind: 'development' as const,
    registeredRootId: `connected-accounts-fixture:${pluginId}`,
    canonicalRoot: rootPath,
    observedRevision: 1,
});

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
    }));
});

function bindingSummary(): PluginConnectedAccountBindingSummary {
    return Object.freeze({
        purpose: 'realtime_upstream',
        service: Object.freeze({
            pluginId: 'acme.agent.realtime',
            localId: 'openai',
        }),
        account: Object.freeze({
            service: Object.freeze({
                pluginId: 'acme.agent.realtime',
                localId: 'openai',
            }),
            accountId: 'realtime-test-account',
        }),
        target: Object.freeze({
            kind: 'account',
            displayName: 'Realtime test account',
        }),
    });
}

function materialization(): PluginConnectedAccountMaterialization {
    return Object.freeze({
        kind: 'environment',
        env: Object.freeze({ OPENAI_API_KEY: 'test-only-key' }),
    });
}

function createBundledAccountDataDependencies(): AccountPluginDataStorageHostDependencies {
    const credentials = Object.freeze({
        token: 'bundled-connected-accounts-fixture-token',
        encryption: null,
    } satisfies StoredCredentials);

    return Object.freeze({
        readCredentials: async () => credentials,
        isCurrentAccount: (candidate) => candidate === credentials,
        resolveAccountScopeKey: () => 'bundled-connected-accounts-fixture',
        resolveBaseUrl: () => 'https://bundled-connected-accounts.invalid',
        resolveAccountEncryptionCurrentness: async () => ({
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
        }),
        http: {
            async get(url: string) {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                }
                throw new Error(`Unexpected bundled Account Data GET: ${url}`);
            },
            async post(url: string) {
                if (url.endsWith('/v1/plugins/data/query')) {
                    return { status: 200, data: { rows: [], changeCursor: 0 } };
                }
                throw new Error(`Unexpected bundled Account Data POST: ${url}`);
            },
        },
    });
}

/**
 * A public-classified address no bundled service actually answers on. The host
 * admits an origin by resolving it once and then connects to exactly that
 * answer, so seeing this address on the socket proves the connection used the
 * admitted DNS result rather than resolving the hostname a second time.
 */
const FIXTURE_VALIDATED_ADDRESS = '203.0.114.10';

type ObservedPinnedRequest = Readonly<{
    url: string;
    method: string | undefined;
    headers: Readonly<Record<string, string>>;
    validatedAddresses: readonly string[];
}>;

function pinnedJsonResponse(
    body: unknown,
    init: Readonly<{
        status?: number;
        headers?: Readonly<Record<string, string>>;
    }> = {},
): PinnedHttpStreamResponse {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    let delivered = false;
    return Object.freeze({
        status: init.status ?? 200,
        headers: Object.freeze({
            'content-type': 'application/json',
            ...(init.headers ?? {}),
        }),
        contentLength: bytes.byteLength,
        read: async () => {
            if (delivered) return null;
            delivered = true;
            return bytes;
        },
        cancel: () => {},
    });
}

/**
 * Substitutes the two process-owned network boundaries the plugin HTTP host
 * finally crosses — the DNS answer that admits an origin and the socket pinned
 * to it — so these cases exercise the real admission, credential and
 * currentness path without leaving the machine.
 */
function createPinnedNetworkFixture(
    respond: (request: PinnedHttpStreamRequest) => PinnedHttpStreamResponse,
) {
    const observed: ObservedPinnedRequest[] = [];
    const openPinnedStream = vi.fn(async (request: PinnedHttpStreamRequest) => {
        observed.push(Object.freeze({
            url: request.url,
            method: request.method,
            headers: request.headers,
            validatedAddresses: request.validatedAddresses,
        }));
        return respond(request);
    });
    const networkDependencies = Object.freeze({
        openPinnedStream,
        resolveNetworkAddresses: async () => Object.freeze([FIXTURE_VALIDATED_ADDRESS]),
    }) satisfies PluginRuntimeNetworkDependencies;
    return Object.freeze({
        observed: observed as readonly ObservedPinnedRequest[],
        openPinnedStream,
        networkDependencies,
    });
}

describe('executable plugin runtime Connected Accounts integration', () => {

    it('exposes the single host established-account owner only while the registry generation is current', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-established-owner-'));
        temporaryRoots.push(happyHomeDir);
        const establishedOwner = Object.freeze({
            invoke: vi.fn(),
        }) as unknown as Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            resolveDevelopmentSourceAuthority,
            qualifiedConnectedAccountEstablishedRuntimeOwner: establishedOwner,
        });

        try {
            expect(
                runtime.resolveQualifiedConnectedAccountEstablishedRuntimeOwner?.(),
            ).toBe(establishedOwner);
            runtime.retireConsumers();
            expect(
                runtime.resolveQualifiedConnectedAccountEstablishedRuntimeOwner?.(),
            ).toBeNull();
        } finally {
            await runtime.dispose();
        }
    });

    it('exposes the canonical purpose-binding reader and materializer only while the registry generation is current', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-purpose-owner-'));
        temporaryRoots.push(happyHomeDir);
        const purposeOwner: StablePluginConnectedAccountsOwner = Object.freeze({
            getBinding: vi.fn(async () => null),
            requestSelection: vi.fn(async () => {
                throw new Error('unexpected selection');
            }),
            materialize: vi.fn(async () => materialization()),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn(() => Object.freeze({ dispose() {} })),
        });
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            resolveDevelopmentSourceAuthority,
            connectedAccounts: purposeOwner,
        });

        try {
            expect(
                runtime.resolveConnectedAccountPurposeBindingOwner?.(),
            ).toEqual({
                getBinding: purposeOwner.getBinding,
                materialize: purposeOwner.materialize,
                watch: purposeOwner.watch,
                // Credential-free bounded metadata, consumed by SCM hosting routing to recognize
                // a configured self-managed deployment.
                listAccounts: purposeOwner.listAccounts,
            });
            runtime.retireConsumers();
            expect(
                runtime.resolveConnectedAccountPurposeBindingOwner?.(),
            ).toBeNull();
        } finally {
            await runtime.dispose();
        }
    });

    it('invokes a bundled manual authentication mode through the configured-origin final fetch boundary', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-producer-'));
        temporaryRoots.push(happyHomeDir);
        let configurationCurrent = true;
        let invalidateConfigurationDuringFetch = false;
        const network = createPinnedNetworkFixture(() => {
            if (invalidateConfigurationDuringFetch) {
                configurationCurrent = false;
            }
            return pinnedJsonResponse({
                id: 42,
                login: 'octocat',
                email: 'octocat@example.test',
            }, { headers: { 'x-oauth-scopes': 'repo, read:user' } });
        });
        let runtime: ResolvedExecutablePluginRuntimeRegistry | null = null;

        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                resolveDevelopmentSourceAuthority,
                pluginIds: ['happier.scm.forge.github'],
                networkDependencies: network.networkDependencies,
            });
            const service = Object.freeze({
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            });
            const lease = await runtime.resolveConnectedAccountRuntime?.(service);
            if (!lease) throw new Error('Expected the bundled GitHub Connected Account runtime');
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({
                    kind: 'service',
                    service,
                    modeId: 'fine-grained-pat',
                }),
                revision: 'unconfigured',
                // This URL-looking value is intentionally unrelated host data. It must not
                // become network authority; only the manifest's semantic service target does.
                values: Object.freeze({ unrelatedUrl: 'https://attacker.invalid' }),
                getSecret: async () => null,
            });
            const staged = new Map<string, string>();
            const attemptCredentials = Object.freeze({
                get: async (key: string) => staged.get(key) ?? null,
                set: async (key: string, value: string) => {
                    staged.set(key, value);
                },
                delete: async (key: string) => {
                    staged.delete(key);
                },
            });

            await expect(runtime.connectedAccountRuntimeInvoker?.invokeAuthentication({
                admission: Object.freeze({
                    service,
                    descriptor: lease.descriptor.authentication.modes[0]!,
                    modeId: 'fine-grained-pat',
                    occurrenceId: lease.occurrenceId,
                    sourceCustody: lease.sourceCustody,
                }),
                operation: Object.freeze({
                    kind: 'submitManual',
                    fields: Object.freeze({ token: 'github_pat_test' }),
                }),
                context: Object.freeze({
                    service,
                    attempt: Object.freeze({ kind: 'connect', attemptId: 'attempt-1' }),
                    configuration,
                    attemptCredentials,
                }),
                isConfigurationCurrent: async () => true,
                signal: new AbortController().signal,
            })).resolves.toMatchObject({
                status: 'connected',
                accountId: '42',
                displayName: 'octocat',
            });
            expect(network.openPinnedStream).toHaveBeenCalledOnce();
            // The admitted address — not a second DNS answer — is what the socket
            // connected to, so the manifest origin and the connection identity
            // that carried its credential are asserted together.
            expect(network.observed[0]).toMatchObject({
                url: 'https://api.github.com/user',
                validatedAddresses: [FIXTURE_VALIDATED_ADDRESS],
            });
            expect(staged.get('token')).toBe('github_pat_test');

            const establishedConfiguration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({
                    kind: 'service',
                    service,
                    modeId: 'fine-grained-pat',
                }),
                revision: 'unconfigured',
                values: Object.freeze({}),
                getSecret: async () => null,
            });
            const credentials = Object.freeze({
                get: async (key: string) => staged.get(key) ?? null,
            });
            const establishedTarget = Object.freeze({
                account: Object.freeze({ service, accountId: '42' }),
                expectedCredentialRevision: 'credential-1',
                expectedRuntimeConfigurationRevision: 'unconfigured',
            });

            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({
                target: establishedTarget,
                operation: Object.freeze({ kind: 'status' }),
                context: Object.freeze({
                    account: establishedTarget.account,
                    configuration: establishedConfiguration,
                    credentials,
                }),
                isConfigurationCurrent: async () => true,
                isCredentialRevisionCurrent: async () => true,
                signal: new AbortController().signal,
            })).resolves.toMatchObject({
                status: 'connected',
                displayName: 'octocat',
            });
            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({
                target: establishedTarget,
                operation: Object.freeze({
                    kind: 'materialize',
                    request: Object.freeze({
                        kind: 'httpHeaders',
                        origin: 'https://api.github.com',
                        headerNames: Object.freeze(['Authorization']),
                    }),
                }),
                context: Object.freeze({
                    account: establishedTarget.account,
                    configuration: establishedConfiguration,
                    credentials,
                }),
                isConfigurationCurrent: async () => true,
                isCredentialRevisionCurrent: async () => true,
                signal: new AbortController().signal,
            })).resolves.toEqual({
                kind: 'httpHeaders',
                headers: { Authorization: 'Bearer github_pat_test' },
            });
            invalidateConfigurationDuringFetch = true;
            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({
                target: establishedTarget,
                operation: Object.freeze({ kind: 'status' }),
                context: Object.freeze({
                    account: establishedTarget.account,
                    configuration: establishedConfiguration,
                    credentials,
                }),
                isConfigurationCurrent: async () => configurationCurrent,
                isCredentialRevisionCurrent: async () => true,
                signal: new AbortController().signal,
            })).rejects.toThrow('target is no longer current');
            expect(network.openPinnedStream).toHaveBeenCalledTimes(3);
        } finally {
            await runtime?.dispose();
        }
    });

    it.each([
        {
            pluginId: 'happier.agent.codex',
            serviceId: 'openai-codex',
            accountId: 'chatgpt-account-1',
            modeId: 'oauth',
            usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
            credentials: new Map([
                ['accessToken', 'codex-access'],
                ['providerAccountId', 'chatgpt-account-1'],
            ]),
            response: {
                rate_limit: {
                    primary_window: { used_percent: 25, reset_at: 1_700_000_000 },
                    secondary_window: { used_percent: 60, reset_at: 1_800_000_000 },
                },
            },
            expectedLimit: {
                id: 'session',
                used: 25,
                remaining: 75,
                resetsAtMs: 1_700_000_000_000,
            },
        },
        {
            pluginId: 'happier.agent.claude',
            serviceId: 'claude-subscription',
            accountId: 'claude-account-1',
            // Only the OAuth mode reads subscription usage; a setup-token account
            // answers `limits: []` locally and never reaches a host boundary, so
            // it cannot prove anything about the configured-origin path.
            modeId: 'oauth',
            usageUrl: 'https://api.anthropic.com/api/oauth/usage',
            credentials: new Map([
                ['accessToken', 'sk-ant-oat01-access-token'],
            ]),
            response: {
                five_hour: {
                    utilization: 10,
                    resets_at: '2026-02-16T00:00:00Z',
                },
            },
            expectedLimit: {
                id: 'five_hour',
                used: 10,
                remaining: 90,
                resetsAtMs: Date.parse('2026-02-16T00:00:00Z'),
            },
        },
    ])('invokes $serviceId quota through the real configured-origin host boundary', async ({
        pluginId,
        serviceId,
        accountId,
        modeId,
        usageUrl,
        credentials,
        response,
        expectedLimit,
    }) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-quota-'));
        temporaryRoots.push(happyHomeDir);
        const network = createPinnedNetworkFixture(() => pinnedJsonResponse(response));
        let runtime: ResolvedExecutablePluginRuntimeRegistry | null = null;

        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                resolveDevelopmentSourceAuthority,
                pluginIds: [pluginId],
                networkDependencies: network.networkDependencies,
            });
            const service = Object.freeze({ pluginId, localId: serviceId });
            const lease = await runtime.resolveConnectedAccountRuntime?.(service);
            if (!lease) throw new Error(`Expected the bundled ${serviceId} Connected Account runtime`);
            const account = Object.freeze({ service, accountId });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({ kind: 'account', account, modeId }),
                revision: 'configuration-1',
                values: Object.freeze({}),
                getSecret: async () => null,
            });
            const target = Object.freeze({
                account,
                expectedCredentialRevision: 'credential-1',
                expectedRuntimeConfigurationRevision: configuration.revision,
            });

            await expect(runtime.connectedAccountRuntimeInvoker?.invokeEstablished({
                target,
                operation: Object.freeze({ kind: 'quota' }),
                context: Object.freeze({
                    account,
                    configuration,
                    credentials: Object.freeze({
                        get: async (key: string) => credentials.get(key) ?? null,
                    }),
                }),
                isConfigurationCurrent: async () => true,
                isCredentialRevisionCurrent: async () => true,
                signal: new AbortController().signal,
            })).resolves.toMatchObject({
                observedAtMs: expect.any(Number),
                limits: expect.arrayContaining([expectedLimit]),
            });
            expect(network.openPinnedStream).toHaveBeenCalledOnce();
            expect(network.observed[0]).toMatchObject({
                url: usageUrl,
                method: 'GET',
                validatedAddresses: [FIXTURE_VALIDATED_ADDRESS],
            });
        } finally {
            await runtime?.dispose();
        }
    });

    it.each([
        {
            pluginId: 'happier.agent.codex',
            serviceId: 'openai-codex',
            tokenUrl: 'https://auth.openai.com/oauth/token',
        },
        {
            pluginId: 'happier.agent.claude',
            serviceId: 'claude-subscription',
            tokenUrl: 'https://platform.claude.com/v1/oauth/token',
        },
    ])('binds $serviceId OAuth POST through the real host and terminalizes an uncertain none outcome without replay', async ({
        pluginId,
        serviceId,
        tokenUrl,
    }) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-oauth-'));
        temporaryRoots.push(happyHomeDir);
        const network = createPinnedNetworkFixture(() => {
            throw new Error('simulated response loss after remote effect');
        });
        let runtime: ResolvedExecutablePluginRuntimeRegistry | null = null;

        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                resolveDevelopmentSourceAuthority,
                pluginIds: [pluginId],
                networkDependencies: network.networkDependencies,
            });
            const service = Object.freeze({ pluginId, localId: serviceId });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({ kind: 'service', service, modeId: 'oauth' }),
                revision: 'unconfigured',
                values: Object.freeze({}),
                getSecret: async () => null,
            });
            const settle = vi.fn();
            const attempts = createConnectedAccountAuthenticationAttemptOwner({
                createAttemptId: () => 'oauth-attempt-1',
                createAccountId: () => 'account-1',
                now: () => 1_000,
                accounts: Object.freeze({ readExact: async () => null }),
                configuration: Object.freeze({
                    admit: async () => Object.freeze({
                        status: 'ready' as const,
                        snapshot: configuration,
                    }),
                    isCurrent: async () => true,
                }),
                runtime: Object.freeze({
                    admit: async ({ modeId }) => {
                        const lease = await runtime!.resolveConnectedAccountRuntime?.(service);
                        if (!lease) throw new Error('Expected current connected-account runtime');
                        const descriptor = lease.descriptor.authentication.modes
                            .find((candidate) => candidate.id === modeId);
                        if (!descriptor) throw new Error('Expected OAuth descriptor');
                        return Object.freeze({
                            service,
                            descriptor,
                            occurrenceId: lease.occurrenceId,
                            sourceCustody: lease.sourceCustody,
                        });
                    },
                    isCurrent: async () => true,
                    invoke: async (input) => await runtime!.connectedAccountRuntimeInvoker!.invokeAuthentication({
                        ...input,
                        isConfigurationCurrent: async () => true,
                    }),
                }),
                oauth: Object.freeze({
                    create: async () => Object.freeze({
                        request: Object.freeze({
                            callbackUrl: 'http://127.0.0.1:32123/oauth/callback',
                            state: 'oauth-state-1',
                            pkce: Object.freeze({
                                challenge: 'pkce-challenge-1',
                                method: 'S256' as const,
                            }),
                        }),
                        // The transaction owner — not its caller — holds the PKCE
                        // verifier it minted beside the challenge, so it is the
                        // party that completes the callback with it. Returning the
                        // bare callback fields would hand the runtime an
                        // `undefined` secret to register for redaction.
                        acceptCompletion: async (completion: Readonly<{
                            code: string;
                            callbackUrl: string;
                            state: string;
                        }>) => Object.freeze({
                            ...completion,
                            pkceVerifier: 'pkce-verifier-1',
                        }),
                        close: async () => undefined,
                    }),
                }),
                settlement: Object.freeze({ settle }),
            });

            const begun = await attempts.beginConnect({ service, modeId: 'oauth' });
            expect(begun).toEqual({ status: 'starting', attemptId: 'oauth-attempt-1' });
            for (let index = 0; index < 20; index += 1) {
                const current = await attempts.read({ attemptId: 'oauth-attempt-1' });
                if (current.status === 'awaitingOAuth') break;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            await expect(attempts.completeOAuth({
                attemptId: 'oauth-attempt-1',
                completion: {
                    code: 'remote-code-1',
                    callbackUrl: 'http://127.0.0.1:32123/oauth/callback',
                    state: 'oauth-state-1',
                },
            })).resolves.toEqual({
                status: 'reconnectRequired',
                attemptId: 'oauth-attempt-1',
                code: expect.stringContaining('outcome_unknown'),
            });
            expect(network.openPinnedStream).toHaveBeenCalledOnce();
            expect(network.observed[0]).toMatchObject({
                url: tokenUrl,
                method: 'POST',
                validatedAddresses: [FIXTURE_VALIDATED_ADDRESS],
            });
            expect(settle).not.toHaveBeenCalled();
            await expect(attempts.reconcile({
                attemptId: 'oauth-attempt-1',
            })).resolves.toEqual({
                status: 'reconnectRequired',
                attemptId: 'oauth-attempt-1',
                code: expect.stringContaining('outcome_unknown'),
            });
            expect(network.openPinnedStream).toHaveBeenCalledOnce();
        } finally {
            await runtime?.dispose();
        }
    });

    it('normalizes an Agent purpose and injects the real invocation host boundary', async () => {
        const request = vi.fn() as HostCurrentSessionInteractionsService['request'];
        const currentSession: HostCurrentSessionUiServices = Object.freeze({
            interactions: Object.freeze({ request }),
        });
        const disposeWatch = vi.fn();
        const owner: StablePluginConnectedAccountsOwner = Object.freeze({
            getBinding: vi.fn(async () => bindingSummary()),
            requestSelection: vi.fn(async (input) => {
                if (!input.currentSession) {
                    throw new PluginError({
                        code: 'plugin_ui_unavailable',
                        message: 'Connected Account selection requires a current session',
                    });
                }
                input.assertGenerationCurrent();
                return bindingSummary();
            }),
            materialize: vi.fn(async () => materialization()),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn(() => Object.freeze({ dispose: disposeWatch })),
        });
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-accounts-host-'));
        temporaryRoots.push(happyHomeDir);
        let runtime: ResolvedExecutablePluginRuntimeRegistry | null = null;

        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                resolveDevelopmentSourceAuthority,
                contributes: createResolvedContributionRegistry({
                    agents: [{
                        id: 'realtime-agent',
                        provenance: 'external',
                        source: { kind: 'path' },
                        definition: {
                            kindVersion: 1,
                            id: 'realtime-agent',
                            ownedBackendIds: [],
                        },
                        richDefinition: {
                            provenance: 'external',
                            definition: {
                                id: 'realtime-agent',
                                title: 'Realtime Agent',
                                runtime: {
                                    kind: 'acp',
                                    transport: {
                                        kind: 'stdio',
                                        executable: { kind: 'systemTool', id: 'fixture-agent' },
                                    },
                                },
                                primary: 'sessions',
                                connectedAccounts: [{
                                    purpose: 'realtime_upstream',
                                    service: 'openai',
                                    required: false,
                                    materializationKinds: ['environment'],
                                }],
                                capabilities: {
                                    sessions: {
                                        open: ['create'],
                                        delivery: ['newTurn'],
                                        cancel: true,
                                    },
                                },
                            },
                        },
                        pluginId: 'acme.agent.realtime',
                        hostAccess: {
                            required: [],
                            optional: [],
                        },
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/acme-agent-realtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                            resolvedVersion: '1.0.0',
                        },
                    }],
                    connectedAccountDescriptors: [{
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.agent.realtime',
                        definition: {
                            id: 'openai',
                            title: 'OpenAI',
                            authentication: {
                                defaultModeId: 'manual',
                                modes: [{
                                    id: 'manual',
                                    kind: 'manual',
                                    outcomeReconciliation: 'none',
                                    fields: [{
                                        id: 'token',
                                        title: 'API key',
                                        schema: { type: 'string' },
                                        secret: true,
                                    }],
                                }],
                            },
                        },
                    }],
                    activationTargets: [],
                }),
                generation: 17,
                generationAuthority: {
                    commit: null,
                    generations: new Map([[
                        'acme.agent.realtime',
                        {
                            pluginId: 'acme.agent.realtime',
                            immutableGenerationId: 'fixture-acme-agent-realtime-1',
                            rootPath: '/plugins/acme-agent-realtime',
                            // A committed generation always carries its structural
                            // file inventory, and the resources owner normalizes
                            // that inventory before it will hand out a resource
                            // handle. `{} as never` skipped the type checker and
                            // then failed the runtime contract, so every case here
                            // died on `plugin_resource_generation_invalid`.
                            record: {
                                t: 'happier_plugin_generation_v1',
                                schemaVersion: 1,
                                pluginId: 'acme.agent.realtime',
                                immutableGenerationId: 'fixture-acme-agent-realtime-1',
                                createdAtMs: 1,
                                sourceProvenance: 'localSource',
                                manifestRelativePath: '.happier-plugin/plugin.json',
                                files: [
                                    { relativePath: '.happier-plugin/plugin.json', byteLength: 2 },
                                ],
                            },
                            installation: {
                                enabled: true,
                                trust: {
                                    pluginId: 'acme.agent.realtime',
                                    distribution: {
                                        kind: 'localPath',
                                        canonicalPath: '/plugins/acme-agent-realtime',
                                    },
                                    state: 'trusted',
                                    approvedAtMs: 1,
                                },
                                source: {
                                    distribution: {
                                        kind: 'localPath',
                                        canonicalPath: '/plugins/acme-agent-realtime',
                                    },
                                },
                                updatePolicy: 'allowed',
                                optionalAccess: [],
                            },
                        },
                    ]]),
                    rejectedGenerations: new Map(),
                    isCurrent: async () => true,
                },
                connectedAccounts: owner,
            });
            const occurrenceId = runtime.readPluginOccurrenceId?.('acme.agent.realtime');
            if (!occurrenceId) throw new Error('Expected admitted realtime Agent occurrence');
            const services = await runtime.createAgentInvocationServices({
                pluginId: 'acme.agent.realtime',
                pluginVersion: '1.0.0',
                agentId: 'realtime-agent',
                occurrenceId,
                correlationId: 'connected-accounts-integration',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                session: {
                    id: 'session-1',
                    current: currentSession,
                },
            });

            expect(services.availability('connectedAccounts')).toEqual({ status: 'available' });
            await expect(services.connectedAccounts.getBinding('realtime_upstream')).resolves.toEqual(bindingSummary());
            await expect(services.connectedAccounts.requestSelection({
                purpose: 'realtime_upstream',
                reason: 'Choose an account for realtime audio',
            })).resolves.toEqual(bindingSummary());
            await expect(services.connectedAccounts.materialize('realtime_upstream', {
                kind: 'environment',
                keys: ['OPENAI_API_KEY'],
            })).resolves.toEqual(materialization());
            expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
                purpose: {
                    consumer: {
                        pluginId: 'acme.agent.realtime',
                        localId: 'realtime-agent',
                    },
                    purpose: 'realtime_upstream',
                },
                serviceRefs: [{
                    pluginId: 'acme.agent.realtime',
                    localId: 'openai',
                }],
            }));
            expect(owner.requestSelection).toHaveBeenCalledWith(expect.objectContaining({
                currentSession,
                assertGenerationCurrent: expect.any(Function),
            }));

            const servicesWithoutSession = await runtime.createAgentInvocationServices({
                pluginId: 'acme.agent.realtime',
                pluginVersion: '1.0.0',
                agentId: 'realtime-agent',
                occurrenceId,
                correlationId: 'connected-accounts-background-integration',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });
            await expect(servicesWithoutSession.connectedAccounts.getBinding('realtime_upstream'))
                .resolves.toEqual(bindingSummary());
            await expect(servicesWithoutSession.connectedAccounts.materialize('realtime_upstream', {
                kind: 'environment',
                keys: ['OPENAI_API_KEY'],
            })).resolves.toEqual(materialization());
            const watch = servicesWithoutSession.connectedAccounts.watch(
                'realtime_upstream',
                () => undefined,
            );
            await expect(servicesWithoutSession.connectedAccounts.requestSelection({
                purpose: 'realtime_upstream',
                reason: 'Background selection is not allowed',
            })).rejects.toMatchObject({
                code: 'plugin_ui_unavailable',
            });

            runtime.retireConsumers();
            expect(disposeWatch).toHaveBeenCalledOnce();
            await expect(services.connectedAccounts.getBinding('realtime_upstream')).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            await expect(services.connectedAccounts.requestSelection({
                purpose: 'realtime_upstream',
                reason: 'Old generation cannot select',
            })).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            await expect(services.connectedAccounts.materialize('realtime_upstream', {
                kind: 'environment',
                keys: ['OPENAI_API_KEY'],
            })).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            runtime.retireConsumers();
            watch.dispose();
            expect(disposeWatch).toHaveBeenCalledOnce();
        } finally {
            await runtime?.dispose();
        }
    });
});
