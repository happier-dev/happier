import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    materializeRecipientOperationRequestV1FromOperation,
    PluginContributesV2Schema,
    type PluginRequestInterceptorContributionV1,
    type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
} from '@/plugins/runtime/exec/privateContract';
import type {
    PluginInterceptedRequest,
    PluginInterceptorResult,
} from '@happier-dev/plugin-sdk/runtime';

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
import { createStablePluginFetchHost } from './service';
import { createVoiceAccountPluginFetchCredentialBindingHost } from './voiceAccountCredentialBinding';

const parsedDefinition = PluginContributesV2Schema.parse({
    voiceProviders: [{
        id: 'conversation',
        title: 'Credentialed conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
            readiness: { requirements: ['credential'] },
            turn: { cancelResponse: true, bargeIn: false },
        },
        accountMediation: {
            credentialSlots: [{ id: 'api_key', scope: 'account' }],
            operations: [{
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
                }],
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

function response(
    request: FetchRuntimeRequestV1,
    artifact: Readonly<Record<string, unknown>> = {
        kind: 'bearer_token',
        value: 'short-lived-artifact',
        expiresAtMs: Date.now() + 60_000,
        placement: 'authorization_header',
    },
    headers: Readonly<Record<string, string>> = { 'content-type': 'application/json' },
): FetchRuntimeResponseV1 {
    const body = new TextEncoder().encode(JSON.stringify(artifact));
    return Object.freeze({
        ok: true,
        status: 200,
        statusText: 'OK',
        finalUrl: request.url,
        headers: Object.freeze({ ...headers }),
        body,
        text: async () => new TextDecoder().decode(body),
        json: async () => JSON.parse(new TextDecoder().decode(body)),
        arrayBuffer: async () => body.slice().buffer,
    });
}

function publishCredential(
    providerId = 'acme.voice/conversation',
    settingsVersion = 1,
): void {
    setActiveAccountSettingsSnapshot({
        source: 'network',
        scopeKey: 'account-scope',
        settingsVersion,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        settings: {
            secrets: [{
                id: 'account-voice-key',
                encryptedValue: { _isSecretValue: true, value: 'long-lived-account-secret' },
            }],
            voice: {
                credentialBindings: [{
                    providerId,
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

function catalogRequest() {
    return {
        url: 'https://voice.example.test/v1/voices',
        method: 'GET' as const,
        credentialBinding: {
            kind: 'voiceAccountOperation' as const,
            provider: { pluginId: 'acme.voice', localId: 'conversation' },
            operation: 'list-voices' as const,
            parameters: {},
        },
        redirect: 'error' as const,
    };
}

function createCatalogService(
    adapter: (request: FetchRuntimeRequestV1) => Promise<FetchRuntimeResponseV1>,
    lifecycle: Readonly<{
        signal: AbortSignal;
        isGenerationCurrent: () => boolean;
    }> = {
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
    },
) {
    return createStablePluginFetchHost({
        adapter,
        credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
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
        signal: lifecycle.signal,
        isGenerationCurrent: lifecycle.isGenerationCurrent,
    }, catalogNetworkBinding());
}

describe('Voice account Plugin fetch credential binding', () => {
    afterEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('materializes the declared account slot only inside the exact action request', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => (
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
        const credentialBindingHost = createVoiceAccountPluginFetchCredentialBindingHost({
            voiceProviders: [{
                pluginId: 'acme.voice',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                definition,
            }],
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        });
        const host = createStablePluginFetchHost({
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

    it('fails closed for an unknown operation, different target, or caller cancellation', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => response(request, {
            client_secret: {
                value: 'short-lived-artifact',
                expires_at_ms: Date.now() + 60_000,
            },
        }));
        const host = createStablePluginFetchHost({
            adapter,
            credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
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
        const operation = mutableDefinition.accountMediation!.operations[0]!;
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => response(request));
        const credentialResolver: VoiceCredentialResolver = Object.freeze({
            status: () => ({ available: true, source: 'account' as const }),
            async withSecret<T>(input: Readonly<{
                providerId: string;
                credentialSlotId: string;
                use: (secret: string) => Promise<T>;
            }>): Promise<T> {
                Object.defineProperty(operation.request, 'origin', {
                    configurable: true,
                    value: 'https://attacker.example.test',
                });
                return await input.use('long-lived-account-secret');
            },
        });
        const service = createStablePluginFetchHost({
            adapter,
            credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
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
        const createService = (adapter: (request: FetchRuntimeRequestV1) => Promise<FetchRuntimeResponseV1>) => (
            createStablePluginFetchHost({
                adapter,
                credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
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
            adapter: (request: FetchRuntimeRequestV1) => Promise<FetchRuntimeResponseV1>,
        ) => createStablePluginFetchHost({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: observedRequest,
                }],
            },
            credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
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
        const successfulAdapter = vi.fn(async (input: FetchRuntimeRequestV1) => response(input));

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

        const failingAdapter = vi.fn(async (input: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
            throw new Error(`provider echoed ${input.headers?.authorization}`);
        });
        const failure = await createService(failingAdapter).request(request).catch((error: unknown) => error);
        expect(failure).toMatchObject({
            code: 'plugin_fetch_voice_account_operation_failed',
        });
        expect(JSON.stringify(failure)).not.toContain('long-lived-account-secret');
        expect(String(failure)).not.toContain('long-lived-account-secret');
    });

    it('reconstructs the public result without provider response fields or helper methods', async () => {
        publishCredential();
        const credentialBindingHost = createVoiceAccountPluginFetchCredentialBindingHost({
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
            execute: async (headers) => Object.assign({
                status: 200,
                finalUrl: 'https://voice.example.test/v1/session',
                headers: { 'content-type': 'application/json' },
                body,
            }, {
                statusText: `provider echoed ${headers.authorization}`,
                text: async () => headers.authorization,
                json: async () => ({ reflected: headers.authorization }),
                arrayBuffer: async () => new TextEncoder().encode(headers.authorization).buffer,
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

    it('returns bounded provider-shaped catalog material only through the exact declared GET action', async () => {
        publishCredential();
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => response(request, {
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
            const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => {
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
            const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => {
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
            () => publishCredential('acme.voice/conversation', 2),
            'plugin_voice_credential_unavailable',
        );
    });

    it('materializes every packed public recipient operation without a daemon action bypass', async () => {
        publishCredential('acme.packed-voice/conversation');
        const fixtureRoot = new URL(
            '../../testkit/fixtures/packed-external-voice-provider/',
            import.meta.url,
        );
        const manifest = JSON.parse(await readFile(
            new URL('.happier-plugin/plugin.json', fixtureRoot),
            'utf8',
        )) as Readonly<{ contributes?: unknown }>;
        const contributes = PluginContributesV2Schema.parse(manifest.contributes);
        const packedDefinition = contributes.voiceProviders[0]!;
        if (packedDefinition.kind !== 'conversation') {
            throw new Error('packed_voice_conversation_declaration_required');
        }
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => (
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
        const fetch = createStablePluginFetchHost({
            adapter,
            credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
                voiceProviders: [{
                    pluginId: 'acme.packed-voice',
                    identity: { pluginId: 'acme.packed-voice', localId: 'conversation' },
                    definition: packedDefinition,
                }],
                credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            }),
        });
        const signal = new AbortController().signal;
        const service = fetch.bind({
            plugin: { id: 'acme.packed-voice', version: '1.0.0' },
            contribution: {
                id: 'conversation',
                qualifiedId: 'acme.packed-voice/voiceProviders/conversation',
            },
            generation: 'generation-7',
            correlationId: 'packed-voice-account-operation',
            surface: 'ui' as const,
            signal,
            isGenerationCurrent: () => true,
        }, createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            'binding-packed-voice',
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
        const request = async (
            operation: 'list-voices' | 'provision-voice' | 'client-auth',
            parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>,
        ) => {
            const declaration = packedDefinition.accountMediation?.operations.find(
                (candidate) => candidate.id === operation,
            );
            if (!declaration) throw new Error(`missing packed operation ${operation}`);
            const materialized = materializeRecipientOperationRequestV1FromOperation({
                operation: declaration,
                parameters,
            });
            return await service.request({
                url: materialized.url,
                method: materialized.method,
                headers: materialized.headers,
                ...(materialized.body ? { body: materialized.body } : {}),
                credentialBinding: {
                    kind: 'voiceAccountOperation',
                    provider: { pluginId: 'acme.packed-voice', localId: 'conversation' },
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
