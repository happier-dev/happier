import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as protocol from '@happier-dev/protocol';
import {
    createRecipientContractDigestV1,
    createVoiceProviderRecipientContractFromCredentialsV1,
    materializeRecipientOperationRequestV1FromOperation,
    PluginContributesV2Schema,
    type PluginRequestInterceptorContributionV1,
    type VoiceCredentialBindingIdentityV1,
    type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
    HttpService,
} from '@happier-dev/plugin-sdk/http';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
    TargetPluginInterceptorResult as PluginInterceptorResult,
} from '../lifecycle/contributions/targetRequestInterceptors';

import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    createVoiceCredentialResolver,
    type VoiceCredentialResolver,
} from '@/daemon/voice/credentials/resolver';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/factory';
import { createStablePluginHttpHost as createProductionStablePluginHttpHost } from './service';
import {
    createVoiceAccountPluginHttpCredentialBindingHost as createUnboundVoiceAccountPluginHttpCredentialBindingHost,
} from './voiceAccountCredentialBinding';

function createVoiceAccountPluginHttpCredentialBindingHost(
    params: Parameters<typeof createUnboundVoiceAccountPluginHttpCredentialBindingHost>[0],
) {
    return createUnboundVoiceAccountPluginHttpCredentialBindingHost({
        ...params,
        phase: 'prepare',
    });
}

type TestFetchRequest = Parameters<HttpService['request']>[0] & Readonly<{
    signal?: AbortSignal;
}>;
type TestFetchResponse = Awaited<ReturnType<HttpService['request']>>;

/** DNS is a system boundary; this fixture has one declared public origin. */
const resolveVoiceFixtureNetworkAddresses = async (
    hostname: string,
): Promise<readonly string[]> => (
    hostname === 'voice.example.test' ? ['93.184.216.34'] : []
);

function createStablePluginHttpHost(
    params: Omit<Parameters<typeof createProductionStablePluginHttpHost>[0], 'adapter'> & Readonly<{
        adapter: (request: TestFetchRequest) => Promise<TestFetchResponse>;
    }>,
) {
    return createProductionStablePluginHttpHost({
        resolveNetworkAddresses: resolveVoiceFixtureNetworkAddresses,
        ...params,
        adapter: Object.freeze({
            request: async (
                request: Parameters<HttpService['request']>[0],
                options: Parameters<HttpService['request']>[1] = {},
            ) => await params.adapter({
                ...request,
                signal: options.signal,
            }),
            async openWebSocket(): Promise<never> {
                throw new Error('WebSocket is unavailable in this HTTP request fixture');
            },
        }),
    });
}

const parsedDefinition = PluginContributesV2Schema.parse({
    voiceProviders: [{
        id: 'conversation',
        title: 'Credentialed conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
        },
        credentials: {
            slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
            requirement: { kind: 'always' },
            sources: [{
                kind: 'savedSecret',
                secretKinds: ['apiKey'],
                operationProjections: [{
                    kind: 'recipientCredential', operation: 'client-auth', phase: 'prepare', format: 'bearer',
                }, {
                    kind: 'recipientCredential', operation: 'list-voices', phase: 'prepare', format: 'bearer',
                }],
            }],
            hostMediated: { operations: [{
                    id: 'client-auth',
                    purpose: 'voice.client-auth',
                    credentialSlotId: 'api_key',
                    effect: 'read',
                    request: {
                        origin: 'https://voice.example.test',
                        pathTemplate: '/v1/session',
                        queryTemplate: [],
                        headerTemplate: [],
                        bodyTemplate: { kind: 'none' },
                        method: 'POST',
                        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                        redirect: 'error',
                        maxBodyBytes: 0,
                        contentTypes: [],
                    },
                    parameters: {
                        schema: { type: 'object', properties: {}, additionalProperties: false },
                        mapping: [],
                    },
                    response: { maxBytes: 32 * 1024, contentTypes: ['application/json'] },
                }, {
                    id: 'list-voices',
                    purpose: 'voice.catalog.voices',
                    credentialSlotId: 'api_key',
                    effect: 'read',
                    request: {
                        origin: 'https://voice.example.test',
                        pathTemplate: '/v1/voices',
                        queryTemplate: [],
                        headerTemplate: [],
                        bodyTemplate: { kind: 'none' },
                        method: 'GET',
                        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                        redirect: 'error',
                        maxBodyBytes: 0,
                        contentTypes: [],
                    },
                    parameters: {
                        schema: { type: 'object', properties: {}, additionalProperties: false },
                        mapping: [],
                    },
                    response: { maxBytes: 2 * 1024 * 1024, contentTypes: ['application/json'] },
                }] },
        },
        client: {
            artifactId: 'voice-runtime-web',
            modulePath: './voiceRuntime',
            exportName: 'activate',
        },
    }],
}).voiceProviders[0]!;
if (parsedDefinition.kind !== 'conversation') throw new Error('expected conversation Voice provider');
const definition = parsedDefinition;

function definitionWithClientAuthCredentialHeaderName(headerName: string) {
    const parsed = PluginContributesV2Schema.parse({
        voiceProviders: [{
            ...definition,
            credentials: {
                ...definition.credentials!,
                hostMediated: {
                    ...definition.credentials!.hostMediated!,
                    operations: definition.credentials!.hostMediated!.operations.map((operation) => (
                        operation.id === 'client-auth' && operation.request.credential.kind === 'httpHeader'
                            ? {
                                ...operation,
                                request: {
                                    ...operation.request,
                                    credential: {
                                        ...operation.request.credential,
                                        name: headerName,
                                    },
                                },
                            }
                            : operation
                    )),
                },
            },
        }],
    }).voiceProviders[0]!;
    if (parsed.kind !== 'conversation') throw new Error('expected conversation Voice provider');
    return parsed;
}

function response(
    request: TestFetchRequest,
    artifact: Readonly<Record<string, unknown>> = {
        kind: 'bearer_token',
        value: 'short-lived-artifact',
        expiresAtMs: Date.now() + 60_000,
        placement: 'authorization_header',
    },
    headers: Readonly<Record<string, string>> = { 'content-type': 'application/json' },
): TestFetchResponse {
    const body = new TextEncoder().encode(JSON.stringify(artifact));
    return Object.freeze({
        status: 200,
        finalUrl: request.url,
        headers: Object.freeze({ ...headers }),
        body,
    });
}

/** Mirrors the daemon's path-sourced recipient contract digest for a fixture binding. */
function pathSourcedRecipientContractDigest(
    contribution: Readonly<{ pluginId: string; localId: string }>,
    definitionForContract: typeof definition,
): string {
    return createRecipientContractDigestV1(
        createVoiceProviderRecipientContractFromCredentialsV1({
            package: {
                pluginId: contribution.pluginId,
                source: { kind: 'path', locator: contribution.pluginId },
            },
            publisher: {
                trust: 'verified',
                identity: `path:${contribution.pluginId}:committed-registry`,
            },
            contribution,
            credentials: {
                slot: definitionForContract.credentials!.slot,
                hostMediated: definitionForContract.credentials!.hostMediated!,
            },
            presentation: { title: definitionForContract.title },
        }),
    );
}

function publishCredential(
    providerId = 'acme.voice/conversation',
    settingsVersion = 1,
    approvedRecipientContractDigest?: string,
    definitionForContract = definition,
): void {
    const separator = providerId.lastIndexOf('/');
    if (separator <= 0 || separator === providerId.length - 1) throw new Error('qualified provider identity required');
    const contribution = {
        pluginId: providerId.slice(0, separator),
        localId: providerId.slice(separator + 1),
    };
    const defaultRecipientContractDigest = pathSourcedRecipientContractDigest(
        contribution,
        definitionForContract,
    );
    setActiveAccountSettingsSnapshot({
        source: 'network',
        scopeKey: 'account-scope',
        settingsVersion,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        settings: {
            secrets: [{
                id: 'account-voice-key',
                name: 'Account voice key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'long-lived-account-secret' },
            }],
            voiceSettingsV1: {
                credentialBindings: [{
                    contribution,
                    credentialSlotId: 'api_key',
                    credentialSource: { kind: 'savedSecret' },
                    approvedRecipientContractDigest:
                        approvedRecipientContractDigest ?? defaultRecipientContractDigest,
                    credentialBindings: {
                        account: { api_key: 'account-voice-key' },
                        byMachineId: {
                            machine_a: { api_key: 'machine-voice-key' },
                        },
                    },
                }],
            },
        } as never,
    });
}

function publishDormantCredentialSelection(
    selection: 'connectedAccount' | 'none',
    settingsVersion = 1,
): void {
    const contribution = {
        pluginId: 'acme.voice',
        localId: 'conversation',
    };
    setActiveAccountSettingsSnapshot({
        source: 'network',
        scopeKey: 'account-scope',
        settingsVersion,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        settings: {
            secrets: [{
                id: 'account-voice-key',
                name: 'Account voice key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'long-lived-account-secret' },
            }],
            voiceSettingsV1: {
                credentialBindings: [{
                    contribution,
                    credentialSlotId: 'api_key',
                    credentialSource: { kind: selection },
                    // A valid approved digest keeps the deselected-source
                    // assertion from passing on a recipient-contract mismatch.
                    approvedRecipientContractDigest: pathSourcedRecipientContractDigest(
                        contribution,
                        definitionWithConnectedAccountSource(),
                    ),
                    credentialBindings: {
                        account: { api_key: 'account-voice-key' },
                    },
                }],
            },
            connectedAccountPurposeBindingsV1: {
                v: 1,
                bindings: selection === 'connectedAccount'
                    ? [{
                        purpose: {
                            consumer: contribution,
                            purpose: 'voice.client-auth',
                        },
                        target: {
                            kind: 'account',
                            account: {
                                service: {
                                    pluginId: 'happier.agent.openai',
                                    localId: 'openai',
                                },
                                accountId: 'openai-account',
                            },
                        },
                    }]
                    : [],
            },
        } as never,
    });
}

function definitionWithConnectedAccountSource() {
    const parsed = PluginContributesV2Schema.parse({
        voiceProviders: [{
            ...definition,
            credentials: {
                ...definition.credentials!,
                sources: [
                    ...definition.credentials!.sources,
                    {
                        kind: 'connectedAccount',
                        service: {
                            pluginId: 'happier.agent.openai',
                            localId: 'openai',
                        },
                        operationProjections: [{
                            kind: 'materializedHttpHeaders',
                            operation: 'client-auth',
                            phase: 'prepare',
                            request: {
                                kind: 'httpHeaders',
                                origin: 'https://voice.example.test',
                                headerNames: ['authorization'],
                            },
                            requiredHeaderNames: ['authorization'],
                            allowedHeaderNames: ['authorization'],
                        }],
                    },
                ],
            },
        }],
    }).voiceProviders[0]!;
    if (parsed.kind !== 'conversation') throw new Error('expected conversation Voice provider');
    return parsed;
}

function networkBinding() {
    return createLoggerAndEventsAvailablePluginInvocationServiceBinding(
        'generation-7',
        'binding-voice',
        [{
            required: true,
            request: {
                id: 'voice-session-api',
                capability: 'network',
                reason: 'Mint a short-lived Voice session artifact',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
                    methods: ['POST'],
                },
            },
        }],
    );
}

function catalogNetworkBinding() {
    return createLoggerAndEventsAvailablePluginInvocationServiceBinding(
        'generation-7',
        'binding-voice-catalog',
        [{
            required: true,
            request: {
                id: 'voice-catalog-api',
                capability: 'network',
                reason: 'Read the bounded Voice catalog',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
                    methods: ['GET'],
                },
            },
        }],
    );
}

function catalogRequest(
    provider: Readonly<{ pluginId: string; localId: string }> = {
        pluginId: 'acme.voice',
        localId: 'conversation',
    },
) {
    return {
        url: 'https://voice.example.test/v1/voices',
        method: 'GET' as const,
        credentialBinding: {
            kind: 'voiceAccountOperation' as const,
            provider,
            operation: 'list-voices' as const,
            parameters: {},
        },
        redirect: 'error' as const,
    };
}

function createCatalogService(
    adapter: (request: TestFetchRequest) => Promise<TestFetchResponse>,
    lifecycle: Readonly<{
        signal: AbortSignal;
        isGenerationCurrent: () => boolean;
    }> = {
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
    },
    voiceProviders: Parameters<
        typeof createVoiceAccountPluginHttpCredentialBindingHost
    >[0]['voiceProviders'] = [{
        pluginId: 'acme.voice',
        identity: { pluginId: 'acme.voice', localId: 'conversation' },
        definition,
    }],
    invocationPluginId = 'acme.voice',
) {
    return createStablePluginHttpHost({
        adapter,
        credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders,
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        }),
    }).bind({
        plugin: { id: invocationPluginId, version: '1.0.0' },
        contribution: {
            id: 'list-voices',
            qualifiedId: `${invocationPluginId}/actions/list-voices`,
        },
        generation: 'generation-7',
        correlationId: 'voice-catalog-operation',
        surface: 'ui',
        signal: lifecycle.signal,
        isGenerationCurrent: lifecycle.isGenerationCurrent,
    }, catalogNetworkBinding());
}

describe('Voice account Plugin fetch credential binding', () => {
  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('fails closed before credential materialization when the generic host has no Voice phase authority', async () => {
    publishCredential();
    const adapter = vi.fn(async (request: TestFetchRequest) => response(request, { voices: [] }));
    const service = createStablePluginHttpHost({
        adapter,
        credentialBindingHost: createUnboundVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders: [{
                pluginId: 'acme.voice',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                definition,
            }],
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        }),
    }).bind({
        plugin: { id: 'acme.voice', version: '1.0.0' },
        contribution: { id: 'list-voices', qualifiedId: 'acme.voice/actions/list-voices' },
        generation: 'generation-7',
        correlationId: 'voice-catalog-operation',
        surface: 'ui',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
    }, catalogNetworkBinding());

    await expect(service.request(catalogRequest())).rejects.toMatchObject({
      code: 'plugin_fetch_voice_account_operation_phase_authority_unavailable',
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('resolves the exact qualified ElevenLabs binding by the canonical recipient contract digest', async () => {
        const identity = {
            pluginId: 'happier.voice.elevenlabs',
            localId: 'realtime-elevenlabs',
        } as const;
        const elevenLabsDefinition = {
            ...definition,
            id: identity.localId,
            title: 'ElevenLabs Voice',
        };
        const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
            package: {
                pluginId: identity.pluginId,
                source: { kind: 'bundled', locator: identity.pluginId },
            },
            publisher: {
                trust: 'bundled',
                identity: 'happier.dev:first-party-bundle',
            },
            contribution: identity,
            credentials: {
                slot: elevenLabsDefinition.credentials!.slot,
                hostMediated: elevenLabsDefinition.credentials!.hostMediated!,
            },
            presentation: { title: elevenLabsDefinition.title },
        });
        const recipientContractDigest =
            createRecipientContractDigestV1(recipientContract);
        publishCredential(
            'happier.voice.elevenlabs/realtime-elevenlabs',
            1,
            recipientContractDigest,
        );
        const adapter = vi.fn(async (request: TestFetchRequest) =>
            response(request, { voices: [] }));
        const service = createCatalogService(adapter, {
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, [{
            pluginId: identity.pluginId,
            identity,
            definition: elevenLabsDefinition,
            provenance: 'first_party',
            source: { kind: 'bundled' },
        }], identity.pluginId);

        await expect(service.request(catalogRequest(identity))).resolves.toMatchObject({
            status: 200,
        });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('materializes the declared account slot only inside the exact action request', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: TestFetchRequest) => (
            request.url.endsWith('/v1/voices')
                ? response(request, {
                    voices: [{
                        voice_id: 'fixture-voice',
                        name: 'Fixture Voice',
                        language: 'en',
                        provider_only: true,
                    }],
                    provider_only: true,
                })
                : response(request, {
                    client_secret: {
                        value: 'short-lived-artifact',
                        expires_at_ms: Date.now() + 60_000,
                    },
                    provider_only: true,
                })
        ));
        const credentialBindingHost = createVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders: [{
                pluginId: 'acme.voice',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                definition,
            }],
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        });
        const host = createStablePluginHttpHost({
            adapter,
            credentialBindingHost,
        });
        const service = host.bind({
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: { id: 'mint-session', qualifiedId: 'acme.voice/actions/mint-session' },
            generation: 'generation-7',
            correlationId: 'voice-account-operation',
            surface: 'ui',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, networkBinding());
        const pluginRequest = {
            url: 'https://voice.example.test/v1/session',
            method: 'POST' as const,
            credentialBinding: {
                kind: 'voiceAccountOperation' as const,
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth' as const,
                parameters: {},
            },
            redirect: 'error' as const,
        };

        const result = await service.request(pluginRequest);
        expect(result).toMatchObject({
            status: 200,
        });
        expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
            client_secret: {
                value: 'short-lived-artifact',
                expires_at_ms: expect.any(Number),
            },
            provider_only: true,
        });
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            url: pluginRequest.url,
            method: 'POST',
            headers: {
                authorization: 'Bearer long-lived-account-secret',
            },
        }));
        expect(JSON.stringify(pluginRequest)).not.toContain('long-lived-account-secret');
    });

    it.each(['connectedAccount', 'none'] as const)(
        'does not use a dormant SavedSecret when the selected source is %s',
        async (selection) => {
            publishDormantCredentialSelection(selection);
            const decrypt = vi.spyOn(protocol, 'decryptSecretValueWithKeysV1');
            const adapter = vi.fn(async (request: TestFetchRequest) => response(request, { voices: [] }));
            try {
                const service = createCatalogService(adapter, undefined, [{
                    pluginId: 'acme.voice',
                    identity: { pluginId: 'acme.voice', localId: 'conversation' },
                    definition: definitionWithConnectedAccountSource(),
                }]);

                await expect(service.request(catalogRequest())).rejects.toMatchObject({
                    code: 'plugin_voice_credential_unavailable',
                });
                expect(adapter).not.toHaveBeenCalled();
                expect(decrypt).not.toHaveBeenCalled();
            } finally {
                decrypt.mockRestore();
            }
        },
    );

    it('fails closed for an unknown operation, different target, or caller cancellation', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: TestFetchRequest) => response(request, {
            client_secret: {
                value: 'short-lived-artifact',
                expires_at_ms: Date.now() + 60_000,
            },
        }));
        const host = createStablePluginHttpHost({
            adapter,
            credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.voice',
                    identity: { pluginId: 'acme.voice', localId: 'conversation' },
                    definition,
                }],
                credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            }),
        });
        const bind = (
            actionId: string,
            signal = new AbortController().signal,
            isGenerationCurrent: () => boolean = () => true,
        ) => host.bind({
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: { id: actionId, qualifiedId: `acme.voice/actions/${actionId}` },
            generation: 'generation-7',
            correlationId: 'voice-account-operation',
            surface: 'ui',
            signal,
            isGenerationCurrent,
        }, networkBinding());
        const request = {
            url: 'https://voice.example.test/v1/session',
            method: 'POST' as const,
            credentialBinding: {
                kind: 'voiceAccountOperation' as const,
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth' as const,
                parameters: {},
            },
            redirect: 'error' as const,
        };

        await expect(bind('mint-session').request({
            ...request,
            credentialBinding: {
                ...request.credentialBinding,
                operation: 'unknown-operation',
            },
        })).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_unauthorized',
        });
        await expect(bind('mint-session').request({
            ...request,
            url: 'https://voice.example.test/v1/other',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_unauthorized',
        });
        const caller = new AbortController();
        caller.abort();
        await expect(bind('mint-session', caller.signal).request(request)).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_cancelled',
        });
        await expect(bind(
            'mint-session',
            new AbortController().signal,
            () => false,
        ).request(request)).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rechecks the exact declared origin after secret resolution and before execute', async () => {
        const mutableDefinition = structuredClone(definition);
        const operation = mutableDefinition.credentials!.hostMediated!.operations[0]!;
        const adapter = vi.fn(async (request: TestFetchRequest) => response(request));
        const credentialResolver: VoiceCredentialResolver = Object.freeze({
            resolveSelectedSource: () => ({ kind: 'savedSecret' as const }),
            status: () => ({ available: true, source: 'account' as const }),
            async withSecret<T>(input: Readonly<{
                identity: VoiceCredentialBindingIdentityV1;
                recipientContractDigest?: string;
                use: (secret: string) => Promise<T>;
            }>): Promise<T> {
                Object.defineProperty(operation.request, 'origin', {
                    configurable: true,
                    value: 'https://attacker.example.test',
                });
                return await input.use('long-lived-account-secret');
            },
        });
        const service = createStablePluginHttpHost({
            adapter,
            credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.voice',
                    identity: { pluginId: 'acme.voice', localId: 'conversation' },
                    definition: mutableDefinition,
                }],
                credentialResolver,
            }),
        }).bind({
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: { id: 'mint-session', qualifiedId: 'acme.voice/actions/mint-session' },
            generation: 'generation-7',
            correlationId: 'voice-account-operation-origin-race',
            surface: 'ui',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, networkBinding());

        await expect(service.request({
            url: 'https://voice.example.test/v1/session',
            method: 'POST',
            credentialBinding: {
                kind: 'voiceAccountOperation',
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth',
                parameters: {},
            },
            redirect: 'error',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_unauthorized',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not return reflected source credentials in response headers or client artifacts', async () => {
        publishCredential();
        const createService = (adapter: (request: TestFetchRequest) => Promise<TestFetchResponse>) => (
            createStablePluginHttpHost({
                adapter,
                credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
                    voiceProviders: [{
                        pluginId: 'acme.voice',
                        identity: { pluginId: 'acme.voice', localId: 'conversation' },
                        definition,
                    }],
                    credentialResolver: createVoiceCredentialResolver({ machineId: null }),
                }),
            }).bind({
                plugin: { id: 'acme.voice', version: '1.0.0' },
                contribution: { id: 'mint-session', qualifiedId: 'acme.voice/actions/mint-session' },
                generation: 'generation-7',
                correlationId: 'voice-account-operation',
                surface: 'ui',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }, networkBinding())
        );
        const request = {
            url: 'https://voice.example.test/v1/session',
            method: 'POST' as const,
            credentialBinding: {
                kind: 'voiceAccountOperation' as const,
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth' as const,
                parameters: {},
            },
            redirect: 'error' as const,
        };
        const reflectedHeaderService = createService(async (input) => response(input, undefined, {
            'content-type': 'application/json',
            'x-provider-debug': 'long-lived-account-secret',
        }));

        const reflectedHeaderResponse = await reflectedHeaderService.request(request);
        expect(reflectedHeaderResponse.headers).toEqual({ 'content-type': 'application/json' });
        expect(JSON.stringify(reflectedHeaderResponse)).not.toContain('long-lived-account-secret');

        const reflectedArtifactService = createService(async (input) => response(input, {
            kind: 'signed_url',
            value: 'https://voice.example.test/connect?token=long-lived-account-secret',
            expiresAtMs: Date.now() + 60_000,
            placement: 'request_url',
        }));
        await expect(reflectedArtifactService.request(request)).rejects.toMatchObject({
            code: 'plugin_fetch_voice_client_auth_artifact_invalid',
        });

        const escapedReflectedArtifactService = createService(async (input) => {
            const base = response(input);
            const body = new TextEncoder().encode(
                String.raw`{"nested":{"token":"long-lived-account-\u0073ecret"}}`,
            );
            return Object.freeze({
                ...base,
                body,
                arrayBuffer: async () => body.slice().buffer,
            });
        });
        await expect(escapedReflectedArtifactService.request(request)).rejects.toMatchObject({
            code: 'plugin_fetch_voice_client_auth_artifact_invalid',
        });
    });

    it('refuses an external provider when its declared recipient operations changed after approval', async () => {
        const sourceSpec = {
            kind: 'path',
            locator: '/plugins/acme.voice',
            trustPolicy: 'local_trusted',
        } as const;
        const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
            package: {
                pluginId: 'acme.voice',
                source: { kind: sourceSpec.kind, locator: sourceSpec.locator },
            },
            publisher: {
                trust: 'verified',
                identity: `${sourceSpec.kind}:${sourceSpec.locator}:${sourceSpec.trustPolicy}`,
            },
            contribution: { pluginId: 'acme.voice', localId: 'conversation' },
            credentials: {
                slot: definition.credentials!.slot,
                hostMediated: definition.credentials!.hostMediated!,
            },
            presentation: { title: definition.title },
        });
        publishCredential(
            'acme.voice/conversation',
            1,
            createRecipientContractDigestV1(recipientContract),
        );
        const changedDefinition = {
            ...definition,
            credentials: {
                ...definition.credentials!,
                hostMediated: {
                    operations: [
                        ...definition.credentials!.hostMediated!.operations,
                        {
                            ...definition.credentials!.hostMediated!.operations[0]!,
                            id: 'new-operation',
                            purpose: 'voice.new-operation',
                        },
                    ],
                },
            },
        };
        const adapter = vi.fn(async (request: TestFetchRequest) => response(request, { voices: [] }));
        const service = createCatalogService(adapter, {
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, [{
            pluginId: 'acme.voice',
            identity: { pluginId: 'acme.voice', localId: 'conversation' },
            definition: changedDefinition,
            provenance: 'external',
            source: { kind: sourceSpec.kind },
            sourceSpec,
        }]);

        await expect(service.request(catalogRequest())).rejects.toMatchObject({
            code: 'plugin_voice_credential_unavailable',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('admits a bundled first-party provider whose declared recipient operations changed after approval', async () => {
        const identity = {
            pluginId: 'happier.voice.elevenlabs',
            localId: 'realtime-elevenlabs',
        } as const;
        const approvedDefinition = {
            ...definition,
            id: identity.localId,
            title: 'ElevenLabs Voice',
        };
        // The approval the user gave before the release that changed the
        // bundled provider's mediated operations.
        publishCredential(
            'happier.voice.elevenlabs/realtime-elevenlabs',
            1,
            createRecipientContractDigestV1(createVoiceProviderRecipientContractFromCredentialsV1({
                package: {
                    pluginId: identity.pluginId,
                    source: { kind: 'bundled', locator: identity.pluginId },
                },
                publisher: { trust: 'bundled', identity: 'happier.dev:first-party-bundle' },
                contribution: identity,
                credentials: {
                    slot: approvedDefinition.credentials!.slot,
                    hostMediated: approvedDefinition.credentials!.hostMediated!,
                },
                presentation: { title: approvedDefinition.title },
            })),
        );
        const changedDefinition = {
            ...approvedDefinition,
            credentials: {
                ...approvedDefinition.credentials!,
                hostMediated: {
                    operations: [
                        ...approvedDefinition.credentials!.hostMediated!.operations,
                        {
                            ...approvedDefinition.credentials!.hostMediated!.operations[0]!,
                            id: 'new-operation',
                            purpose: 'voice.new-operation',
                        },
                    ],
                },
            },
        };
        const adapter = vi.fn(async (request: TestFetchRequest) => response(request, { voices: [] }));
        const service = createCatalogService(adapter, {
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, [{
            pluginId: identity.pluginId,
            identity,
            definition: changedDefinition,
            provenance: 'first_party',
            source: { kind: 'bundled' },
        }], identity.pluginId);

        await expect(service.request(catalogRequest(identity))).resolves.toMatchObject({
            status: 200,
        });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('redacts the materialized credential from interceptors and sanitizes adapter failures', async () => {
        publishCredential();
        const observedRequest = vi.fn(async (
            request: PluginInterceptedRequest,
        ): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request,
        }));
        const declaration: Readonly<{
            pluginId: string;
            contribution: PluginRequestInterceptorContributionV1;
        }> = {
            pluginId: 'acme.policy',
            contribution: {
                id: 'observe',
                origins: ['https://voice.example.test'],
                methods: ['POST'],
            },
        };
        const createService = (
            adapter: (request: TestFetchRequest) => Promise<TestFetchResponse>,
        ) => createStablePluginHttpHost({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: observedRequest,
                }],
            },
            credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.voice',
                    identity: { pluginId: 'acme.voice', localId: 'conversation' },
                    definition,
                }],
                credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            }),
        }).bind({
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: { id: 'mint-session', qualifiedId: 'acme.voice/actions/mint-session' },
            generation: 'generation-7',
            correlationId: 'voice-account-operation',
            surface: 'ui',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, networkBinding());
        const request = {
            url: 'https://voice.example.test/v1/session',
            method: 'POST' as const,
            credentialBinding: {
                kind: 'voiceAccountOperation' as const,
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth' as const,
                parameters: {},
            },
            redirect: 'error' as const,
        };
        const successfulAdapter = vi.fn(async (input: TestFetchRequest) => response(input));

        await expect(createService(successfulAdapter).request(request)).resolves.toMatchObject({
            status: 200,
        });
        expect(observedRequest).toHaveBeenCalledWith(expect.objectContaining({
            headers: { authorization: '[redacted]' },
        }), expect.anything());
        expect(JSON.stringify(observedRequest.mock.calls)).not.toContain('long-lived-account-secret');
        expect(successfulAdapter).toHaveBeenCalledWith(expect.objectContaining({
            headers: { authorization: 'Bearer long-lived-account-secret' },
        }));

        const failingAdapter = vi.fn(async (input: TestFetchRequest): Promise<TestFetchResponse> => {
            throw new Error(`provider echoed ${input.headers?.authorization}`);
        });
        const failure = await createService(failingAdapter).request(request).catch((error: unknown) => error);
        expect(failure).toMatchObject({
            code: 'plugin_fetch_voice_account_operation_failed',
        });
        expect(JSON.stringify(failure)).not.toContain('long-lived-account-secret');
        expect(String(failure)).not.toContain('long-lived-account-secret');
    });

    it('keeps a host-materialized credential header redacted and immutable regardless of its spelling', async () => {
        const dynamicDefinition = definitionWithClientAuthCredentialHeaderName('x-license-key');
        publishCredential('acme.voice/conversation', 1, undefined, dynamicDefinition);
        const declaration: Readonly<{
            pluginId: string;
            contribution: PluginRequestInterceptorContributionV1;
        }> = {
            pluginId: 'acme.policy',
            contribution: {
                id: 'protect-api',
                origins: ['https://voice.example.test'],
                methods: ['POST'],
            },
        };
        const request = {
            url: 'https://voice.example.test/v1/session',
            method: 'POST' as const,
            credentialBinding: {
                kind: 'voiceAccountOperation' as const,
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth' as const,
                parameters: {},
            },
            redirect: 'error' as const,
        };
        const createService = (
            invoke: (request: PluginInterceptedRequest) => Promise<PluginInterceptorResult>,
            adapter: (request: TestFetchRequest) => Promise<TestFetchResponse>,
        ) => createStablePluginHttpHost({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (interceptedRequest) => await invoke(interceptedRequest),
                }],
            },
            credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.voice',
                    identity: { pluginId: 'acme.voice', localId: 'conversation' },
                    definition: dynamicDefinition,
                }],
                credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            }),
        }).bind({
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: { id: 'mint-session', qualifiedId: 'acme.voice/actions/mint-session' },
            generation: 'generation-7',
            correlationId: 'voice-account-dynamic-credential-header',
            surface: 'ui',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, networkBinding());

        const observed = vi.fn(async (
            interceptedRequest: PluginInterceptedRequest,
        ): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request: interceptedRequest,
        }));
        const successfulAdapter = vi.fn(async (input: TestFetchRequest) => response(input));
        const successfulService = createService(observed, successfulAdapter);

        const successfulResponse = await successfulService.request(request);
        expect(successfulResponse).toMatchObject({
            status: 200,
        });
        expect(observed).toHaveBeenCalledWith(expect.objectContaining({
            headers: { 'x-license-key': '[redacted]' },
        }));
        expect(JSON.stringify(observed.mock.calls)).not.toContain('long-lived-account-secret');
        expect(successfulAdapter).toHaveBeenCalledWith(expect.objectContaining({
            headers: { 'x-license-key': 'Bearer long-lived-account-secret' },
        }));

        await successfulService.request({
            url: 'https://voice.example.test/v1/session',
            method: 'POST',
            headers: { 'x-license-key': 'caller-visible-value' },
            redirect: 'error',
        });
        expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({
            headers: { 'x-license-key': 'caller-visible-value' },
        }));
        expect(successfulAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
            headers: { 'x-license-key': 'caller-visible-value' },
        }));

        const mutatingAdapter = vi.fn(async (input: TestFetchRequest) => response(input));
        await expect(createService(async (interceptedRequest) => ({
            decision: 'continue',
            request: {
                ...interceptedRequest,
                headers: {
                    ...interceptedRequest.headers,
                    'x-license-key': 'interceptor-replacement',
                },
            },
        }), mutatingAdapter).request(request)).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_failed',
        });
        expect(mutatingAdapter).not.toHaveBeenCalled();
    });

    it('reconstructs the public result without provider response fields or helper methods', async () => {
        publishCredential();
        const credentialBindingHost = createVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders: [{
                pluginId: 'acme.voice',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                definition,
            }],
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        });
        const seed = {
            plugin: { id: 'acme.voice', version: '1.0.0' },
            contribution: {
                id: 'mint-session',
                qualifiedId: 'acme.voice/actions/mint-session',
            },
            generation: 'generation-7',
            correlationId: 'voice-account-operation',
            surface: 'ui' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const body = new TextEncoder().encode(JSON.stringify({
            kind: 'bearer_token',
            value: 'short-lived-artifact',
            expiresAtMs: Date.now() + 60_000,
            placement: 'authorization_header',
        }));

        const result = await credentialBindingHost.request({
            seed,
            serviceBinding: networkBinding(),
            credentialBinding: {
                kind: 'voiceAccountOperation',
                provider: { pluginId: 'acme.voice', localId: 'conversation' },
                operation: 'client-auth',
                parameters: {},
            },
            request: {
                url: 'https://voice.example.test/v1/session',
                method: 'POST',
                redirect: 'error',
            },
            signal: undefined,
            execute: async (injection) => Object.assign({
                status: 200,
                finalUrl: 'https://voice.example.test/v1/session',
                headers: { 'content-type': 'application/json' },
                body,
            }, {
                statusText: `provider echoed ${injection.headers.authorization}`,
                text: async () => injection.headers.authorization,
                json: async () => ({ reflected: injection.headers.authorization }),
                arrayBuffer: async () => new TextEncoder().encode(injection.headers.authorization).buffer,
            }),
        });
        expect(Object.keys(result).sort()).toEqual([
            'body',
            'finalUrl',
            'headers',
            'status',
        ]);
        expect(JSON.stringify(result)).not.toContain('long-lived-account-secret');
        expect(result).not.toHaveProperty('statusText');
        expect(result).not.toHaveProperty('text');
        expect(result).not.toHaveProperty('json');
        expect(result).not.toHaveProperty('arrayBuffer');
    });

    it('diagnoses a rejected provider response without retaining response-derived or secret text', async () => {
        publishCredential();
        const recordResponseDiagnostic = vi.fn(() => {
            throw new Error('diagnostic sink unavailable');
        });
        const credentialBindingHost = createVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders: [{
                pluginId: 'acme.voice',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                definition,
            }],
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            recordResponseDiagnostic,
        });
        const rejectedBody = new TextEncoder().encode(JSON.stringify({
            detail: 'provider-only rejection',
            reflected: 'long-lived-account-secret',
        }));

        await expect(credentialBindingHost.request({
            seed: {
                plugin: { id: 'acme.voice', version: '1.0.0' },
                contribution: {
                    id: 'list-voices',
                    qualifiedId: 'acme.voice/actions/list-voices',
                },
                generation: 'generation-7',
                correlationId: 'voice-account-operation-rejected-response',
                surface: 'ui',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            serviceBinding: catalogNetworkBinding(),
            credentialBinding: catalogRequest().credentialBinding,
            request: {
                url: 'https://voice.example.test/v1/voices',
                method: 'GET',
                redirect: 'error',
            },
            signal: undefined,
            execute: async () => ({
                status: 422,
                finalUrl: 'https://voice.example.test/v1/voices',
                headers: {
                    'content-type': 'application/problem+json; boundary=provider-only',
                    'x-provider-error': 'provider-only rejection',
                },
                body: rejectedBody,
            }),
        })).rejects.toMatchObject({
            code: 'plugin_fetch_voice_account_operation_failed',
        });

        expect(recordResponseDiagnostic).toHaveBeenCalledOnce();
        expect(recordResponseDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({
                correlationId: 'voice-account-operation-rejected-response',
            }),
            {
                operationPurpose: 'voice.catalog.voices',
                status: 422,
                contentType: 'undeclared',
                responseBodyBytes: rejectedBody.byteLength,
                finalUrlMatches: true,
                responseContractMatches: false,
                bodyPolicyAccepted: null,
            },
        );
        const serializedDiagnostic = JSON.stringify(recordResponseDiagnostic.mock.calls);
        expect(serializedDiagnostic).not.toContain('long-lived-account-secret');
        expect(serializedDiagnostic).not.toContain('provider-only');
        expect(serializedDiagnostic).not.toContain('application/problem+json');
        expect(serializedDiagnostic).not.toContain('boundary=');
        expect(serializedDiagnostic).not.toContain('https://');
    });

    it('returns bounded provider-shaped catalog material only through the exact declared GET action', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: TestFetchRequest) => response(request, {
            voices: [{
                voice_id: 'fixture-voice',
                name: 'Fixture Voice',
                language: 'en',
                provider_only: true,
            }],
        }, {
            'content-type': 'application/json',
            'x-provider-debug': 'provider-only',
        }));
        const result = await createCatalogService(adapter).request(catalogRequest());

        expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
            voices: [{
                voice_id: 'fixture-voice',
                name: 'Fixture Voice',
                language: 'en',
                provider_only: true,
            }],
        });
        expect(result.headers).toEqual({ 'content-type': 'application/json' });
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://voice.example.test/v1/voices',
            method: 'GET',
            headers: {
                authorization: 'Bearer long-lived-account-secret',
            },
        }));
        expect(JSON.stringify(result)).not.toContain('x-provider-debug');
    });

    it('rejects oversized, malformed, or source-reflecting catalog material', async () => {
        publishCredential();
        const invalidBodies = [
            new Uint8Array((2 * 1024 * 1024) + 1).fill(0x20),
            new TextEncoder().encode('{not-json'),
            new TextEncoder().encode(JSON.stringify({
                voices: [{ voice_id: 'fixture-voice', name: 'long-lived-account-secret' }],
            })),
        ];

        for (const body of invalidBodies) {
            const adapter = vi.fn(async (request: TestFetchRequest) => {
                const base = response(request, { ok: true, items: [] });
                return Object.freeze({
                    ...base,
                    body,
                    arrayBuffer: async () => body.slice().buffer,
                });
            });
            await expect(createCatalogService(adapter).request(catalogRequest())).rejects.toMatchObject({
                code: 'plugin_fetch_voice_catalog_artifact_invalid',
            });
        }
    });

    it('preserves cancellation, generation retirement, and account-switch truth in flight', async () => {
        const runInFlightChange = async (
            change: (input: Readonly<{
                caller: AbortController;
                retire: () => void;
            }>) => void,
            expectedCode: string,
        ) => {
            publishCredential();
            let release!: () => void;
            let markStarted!: () => void;
            let current = true;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            const waiting = new Promise<void>((resolve) => {
                release = resolve;
            });
            const adapter = vi.fn(async (request: TestFetchRequest) => {
                markStarted();
                await waiting;
                return response(request, {
                    ok: true,
                    items: [{ id: 'fixture-voice', name: 'Fixture Voice' }],
                });
            });
            const caller = new AbortController();
            const pending = createCatalogService(adapter, {
                signal: caller.signal,
                isGenerationCurrent: () => current,
            }).request(catalogRequest());
            await started;
            change({
                caller,
                retire: () => {
                    current = false;
                },
            });
            release();
            await expect(pending).rejects.toMatchObject({ code: expectedCode });
        };

        await runInFlightChange(({ caller }) => caller.abort(), 'plugin_fetch_voice_account_operation_cancelled');
        await runInFlightChange(({ retire }) => retire(), 'plugin_final_generation_retired');
        await runInFlightChange(
            () => publishDormantCredentialSelection('none', 2),
            'plugin_voice_credential_unavailable',
        );
    });

    it('materializes every packed public recipient operation without a daemon action bypass', async () => {
        const fixtureRoot = new URL(
            '../../testkit/fixtures/packed-external-voice-provider/',
            import.meta.url,
        );
        const manifest = JSON.parse(await readFile(
            new URL('.happier-plugin/plugin.json', fixtureRoot),
            'utf8',
        )) as Readonly<{ contributes?: unknown }>;
        const contributes = PluginContributesV2Schema.parse(manifest.contributes);
        const packedDefinition = contributes.voiceProviders.find(
            (candidate) => candidate.id === 'conversation-mediated',
        );
        if (packedDefinition?.kind !== 'conversation') {
            throw new Error('packed_voice_conversation_declaration_required');
        }
        const packedIdentity = {
            pluginId: 'acme.packed-voice',
            localId: packedDefinition.id,
        } as const;
        publishCredential(
            `acme.packed-voice/${packedDefinition.id}`,
            1,
            createRecipientContractDigestV1(
                createVoiceProviderRecipientContractFromCredentialsV1({
                    package: {
                        pluginId: packedIdentity.pluginId,
                        source: { kind: 'path', locator: packedIdentity.pluginId },
                    },
                    publisher: {
                        trust: 'verified',
                        identity: `path:${packedIdentity.pluginId}:committed-registry`,
                    },
                    contribution: packedIdentity,
                    credentials: {
                        slot: packedDefinition.credentials!.slot,
                        hostMediated: packedDefinition.credentials!.hostMediated!,
                    },
                    presentation: { title: packedDefinition.title },
                }),
            ),
        );
        const adapter = vi.fn(async (request: TestFetchRequest) => (
            request.method === 'GET'
                ? response(request, {
                    voices: [{
                        voice_id: 'fixture-voice',
                        name: 'Fixture Voice',
                        language: 'en',
                        provider_only: true,
                    }],
                    provider_only: true,
                })
                : request.method === 'PATCH'
                  ? response(request, {
                    provisioned_voice_id: 'fixture-voice',
                    profile: 'balanced',
                  })
                  : response(request, {
                    client_secret: {
                        value: 'short-lived-artifact',
                        expires_at_ms: Date.now() + 60_000,
                    },
                    provider_only: true,
                })
        ));
        const signal = new AbortController().signal;
        const bindForHostPhase = (phase: 'settings' | 'prepare') => createStablePluginHttpHost({
            adapter,
            credentialBindingHost: createUnboundVoiceAccountPluginHttpCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.packed-voice',
                    identity: { pluginId: 'acme.packed-voice', localId: packedDefinition.id },
                    definition: packedDefinition,
                }],
                credentialResolver: createVoiceCredentialResolver({ machineId: null }),
                phase,
            }),
        }).bind({
            plugin: { id: 'acme.packed-voice', version: '1.0.0' },
            contribution: {
                id: packedDefinition.id,
                qualifiedId: `acme.packed-voice/voiceProviders/${packedDefinition.id}`,
            },
            generation: 'generation-7',
            correlationId: `packed-voice-account-operation:${phase}`,
            surface: 'ui' as const,
            signal,
            isGenerationCurrent: () => true,
        }, createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            `binding-packed-voice:${phase}`,
            [{
                required: true,
                request: {
                    id: 'voice-provider-api',
                    capability: 'network',
                    reason: 'Read, provision, and authenticate a bounded Voice session',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://voice.example.test' }],
                        methods: ['GET', 'POST', 'PATCH'],
                    },
                },
            }],
        ));
        const services = Object.freeze({
            settings: bindForHostPhase('settings'),
            prepare: bindForHostPhase('prepare'),
        });
        const request = async (
            operation: 'list-voices' | 'provision-voice' | 'client-auth',
            parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>,
        ) => {
            const declaration = packedDefinition.credentials?.hostMediated?.operations.find(
                (candidate) => candidate.id === operation,
            );
            if (!declaration) throw new Error(`missing packed operation ${operation}`);
            const materialized = materializeRecipientOperationRequestV1FromOperation({
                operation: declaration,
                parameters,
            });
            const service = operation === 'client-auth'
                ? services.prepare
                : services.settings;
            return await service.request({
                url: materialized.url,
                method: materialized.method,
                headers: materialized.headers,
                ...(materialized.body ? { body: materialized.body } : {}),
                credentialBinding: {
                    kind: 'voiceAccountOperation',
                    provider: { pluginId: 'acme.packed-voice', localId: packedDefinition.id },
                    operation,
                    parameters,
                },
                redirect: materialized.redirect,
            });
        };

        await expect(request(
            'list-voices',
            {},
        )).resolves.toMatchObject({ status: 200 });
        await expect(request(
            'provision-voice',
            { voiceId: 'fixture-voice', body: { profile: 'balanced' } },
        )).resolves.toMatchObject({ status: 200 });
        await expect(request(
            'client-auth',
            { body: { audience: 'realtime', voiceId: 'fixture-voice' } },
        )).resolves.toMatchObject({ status: 200 });
        expect(adapter.mock.calls.map(([request]) => ({
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: request.body instanceof Uint8Array
                ? JSON.parse(new TextDecoder().decode(request.body))
                : request.body ?? null,
        }))).toEqual([
            {
                url: 'https://voice.example.test/v1/voices',
                method: 'GET',
                headers: { authorization: 'Bearer long-lived-account-secret' },
                body: null,
            },
            {
                url: 'https://voice.example.test/v1/voices/fixture-voice',
                method: 'PATCH',
                headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer long-lived-account-secret',
                },
                body: { profile: 'balanced' },
            },
            {
                url: 'https://voice.example.test/v1/session',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer long-lived-account-secret',
                },
                body: { audience: 'realtime', voiceId: 'fixture-voice' },
            },
        ]);
        expect(JSON.stringify({ packedDefinition })).not.toContain('long-lived-account-secret');
    });
});
