import {
    buildQualifiedPluginContributionKey,
    containsProviderRegisteredSensitiveValue,
    createPluginContributionIdentity,
    materializeRecipientOperationRequestV1FromOperation,
    type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginContributionRef,
    PluginFetchCredentialBinding,
} from '@happier-dev/plugin-sdk/runtime';

import type { VoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import type {
    StablePluginFetchCredentialBindingHost,
} from './service';

type VoiceProviderDeclaration = Readonly<{
    pluginId: string;
    identity: PluginContributionRef;
    definition: PluginVoiceProviderContributionV1;
}>;

function unauthorized(): PluginError {
    return new PluginError({
        code: 'plugin_fetch_voice_account_operation_unauthorized',
        message: 'The Voice account operation is not authorized for this invocation',
    });
}

function retired(): PluginError {
    return new PluginError({
        code: 'plugin_final_generation_retired',
        message: 'Plugin generation is no longer current',
    });
}

function assertCurrent(input: Readonly<{
    seed: Parameters<StablePluginFetchCredentialBindingHost['request']>[0]['seed'];
    signal: AbortSignal | undefined;
}>): void {
    if (!input.seed.isGenerationCurrent()) throw retired();
    if (input.seed.signal.aborted || input.signal?.aborted) {
        throw new PluginError({
            code: 'plugin_fetch_voice_account_operation_cancelled',
            message: 'The Voice account operation was cancelled',
        });
    }
}

function findVoiceProviderDeclaration(
    declarations: readonly VoiceProviderDeclaration[],
    ref: PluginContributionRef,
): VoiceProviderDeclaration | null {
    const matching = declarations.filter((candidate) => (
        candidate.pluginId === ref.pluginId
        && candidate.identity.pluginId === ref.pluginId
        && candidate.identity.localId === ref.localId
        && candidate.definition.id === ref.localId
    ));
    return matching.length === 1 ? matching[0]! : null;
}

function hasExactNetworkScope(input: Readonly<{
    serviceBinding: Parameters<StablePluginFetchCredentialBindingHost['request']>[0]['serviceBinding'];
    url: string;
    method: string;
}>): boolean {
    let origin: string;
    try {
        origin = new URL(input.url).origin;
    } catch {
        return false;
    }
    return input.serviceBinding.availability.fetch === 'available'
        && (input.serviceBinding.networkScopes ?? []).some((scope) => (
            scope.origins.includes(origin)
            && (scope.methods === undefined || scope.methods.includes(input.method as never))
        ));
}

function hasHeader(
    headers: Readonly<Record<string, string>> | undefined,
    name: string,
): boolean {
    const normalized = name.toLowerCase();
    return Object.keys(headers ?? {}).some((candidate) => candidate.toLowerCase() === normalized);
}

function hasExactHeaders(
    actual: Readonly<Record<string, string>> | undefined,
    expected: Readonly<Record<string, string>>,
): boolean {
    const normalize = (headers: Readonly<Record<string, string>> | undefined) => Object.entries(headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function hasExactBody(actual: Uint8Array | undefined, expected: Uint8Array | null): boolean {
    if (expected === null) return actual === undefined || actual.byteLength === 0;
    if (!actual || actual.byteLength !== expected.byteLength) return false;
    return expected.every((byte, index) => actual[index] === byte);
}

function hasExactDeclaredOrigin(url: string, declaredOrigin: string): boolean {
    try {
        return new URL(url).origin === declaredOrigin;
    } catch {
        return false;
    }
}

function normalizedContentType(headers: Readonly<Record<string, string>>): string | null {
    const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    return typeof value === 'string' ? value.split(';', 1)[0]!.trim().toLowerCase() : null;
}

function projectJsonResponseMaterial(
    body: Uint8Array,
    maxBytes: number,
    sourceCredential: string,
): Uint8Array | null {
    if (body.byteLength > maxBytes) return null;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        const parsed: unknown = JSON.parse(text);
        const projectedText = JSON.stringify(parsed);
        if (
            projectedText === undefined
            || containsProviderRegisteredSensitiveValue(projectedText, [sourceCredential])
        ) return null;
        const projected = new TextEncoder().encode(projectedText);
        return projected.byteLength <= maxBytes ? projected : null;
    } catch {
        return null;
    }
}

function sanitizeFailure(error: unknown, input: Readonly<{
    seed: Parameters<StablePluginFetchCredentialBindingHost['request']>[0]['seed'];
    signal: AbortSignal | undefined;
}>): PluginError {
    if (!input.seed.isGenerationCurrent()) return retired();
    if (input.seed.signal.aborted || input.signal?.aborted) {
        return new PluginError({
            code: 'plugin_fetch_voice_account_operation_cancelled',
            message: 'The Voice account operation was cancelled',
        });
    }
    if (
        error instanceof Error
        && (error as Error & { code?: unknown }).code === 'credential_unavailable'
    ) {
        return new PluginError({
            code: 'plugin_voice_credential_unavailable',
            message: 'The required Voice account credential is unavailable',
        });
    }
    return new PluginError({
        code: 'plugin_fetch_voice_account_operation_failed',
        message: 'The Voice account operation failed',
    });
}

export function createVoiceAccountPluginFetchCredentialBindingHost(params: Readonly<{
    voiceProviders: readonly VoiceProviderDeclaration[];
    credentialResolver: VoiceCredentialResolver;
}>): StablePluginFetchCredentialBindingHost {
    return Object.freeze({
        async request(input) {
            assertCurrent(input);
            const binding: PluginFetchCredentialBinding = input.credentialBinding;
            if (
                binding.kind !== 'voiceAccountOperation'
                || binding.provider.pluginId !== input.seed.plugin.id
            ) {
                throw unauthorized();
            }
            const declaration = findVoiceProviderDeclaration(params.voiceProviders, binding.provider);
            if (!declaration || declaration.definition.kind !== 'conversation') throw unauthorized();
            const operation = declaration.definition.accountMediation?.operations.find(
                (candidate) => candidate.id === binding.operation,
            );
            if (!operation) throw unauthorized();
            let materialized: ReturnType<typeof materializeRecipientOperationRequestV1FromOperation>;
            try {
                materialized = materializeRecipientOperationRequestV1FromOperation({
                    operation,
                    parameters: binding.parameters,
                });
            } catch {
                throw unauthorized();
            }
            const method = input.request.method ?? 'GET';
            if (
                input.seed.surface !== 'ui'
                || materialized.url !== input.request.url
                || materialized.method !== method
                || materialized.redirect !== input.request.redirect
                || !hasExactHeaders(input.request.headers, materialized.headers)
                || !hasExactBody(input.request.body, materialized.body)
                || hasHeader(input.request.headers, operation.request.credential.name)
                || !hasExactNetworkScope({
                    serviceBinding: input.serviceBinding,
                    url: materialized.url,
                    method: materialized.method,
                })
            ) {
                throw unauthorized();
            }
            const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity(binding.provider));
            try {
                return await params.credentialResolver.withSecret({
                    providerId,
                    credentialSlotId: operation.credentialSlotId,
                    use: async (sourceCredential) => {
                        assertCurrent(input);
                        if (!hasExactDeclaredOrigin(materialized.url, operation.request.origin)) {
                            throw unauthorized();
                        }
                        const credentialValue = operation.request.credential.format === 'bearer'
                            ? `Bearer ${sourceCredential}`
                            : sourceCredential;
                        const response = await input.execute(Object.freeze({
                            [operation.request.credential.name]: credentialValue,
                        }));
                        assertCurrent(input);
                        if (
                            response.status < 200
                            || response.status >= 300
                            || response.finalUrl !== materialized.url
                            || !operation.response.contentTypes.includes(
                                normalizedContentType(response.headers) ?? '',
                            )
                        ) {
                            throw new PluginError({
                                code: 'plugin_fetch_voice_account_operation_failed',
                                message: 'The Voice account operation failed',
                            });
                        }
                        const projectedBody = projectJsonResponseMaterial(
                            response.body,
                            operation.response.maxBytes,
                            sourceCredential,
                        );
                        if (!projectedBody) {
                            const isClientAuth = operation.purpose.startsWith('voice.client-auth');
                            throw new PluginError({
                                code: isClientAuth
                                    ? 'plugin_fetch_voice_client_auth_artifact_invalid'
                                    : 'plugin_fetch_voice_catalog_artifact_invalid',
                                message: isClientAuth
                                    ? 'The Voice provider returned invalid client authentication response material'
                                    : 'The Voice provider returned invalid catalog response material',
                            });
                        }
                        return Object.freeze({
                            status: 200,
                            finalUrl: materialized.url,
                            headers: Object.freeze({
                                'content-type': 'application/json',
                            }),
                            body: projectedBody,
                        });
                    },
                });
            } catch (error) {
                if (error instanceof PluginError && (
                    error.code === 'plugin_fetch_voice_account_operation_unauthorized'
                    || error.code === 'plugin_fetch_voice_client_auth_artifact_invalid'
                    || error.code === 'plugin_fetch_voice_catalog_artifact_invalid'
                    || error.code === 'plugin_fetch_voice_account_operation_failed'
                )) {
                    throw error;
                }
                throw sanitizeFailure(error, input);
            }
        },
    });
}
