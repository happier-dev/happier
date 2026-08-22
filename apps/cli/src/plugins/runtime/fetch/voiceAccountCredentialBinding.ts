import {
    containsProviderRegisteredSensitiveValue,
    deriveVoiceCredentialBindingIdentityV1,
    materializeRecipientOperationRequestV1FromOperation,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
    PluginFetchCredentialBinding,
} from '@happier-dev/plugin-sdk/http';

import type { VoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import type {
    StablePluginHttpCredentialBindingHost,
} from './service';
import { createVoiceProviderRecipientContractDigest } from '@/plugins/voiceProviderRecipientContract';

type VoiceProviderDeclaration = Readonly<{
    pluginId: string;
    identity: PluginContributionRef;
    definition: VoiceProviderContribution;
    provenance?: 'first_party' | 'external';
    source?: Readonly<{ kind: string }>;
    sourceSpec?: Readonly<{ kind: string; locator: string; trustPolicy?: string }>;
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
    seed: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['seed'];
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
    serviceBinding: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['serviceBinding'];
    url: string;
    method: string;
}>): boolean {
    let origin: string;
    try {
        origin = new URL(input.url).origin;
    } catch {
        return false;
    }
    return input.serviceBinding.availability.http === 'available'
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

type VoiceAccountOperationResponseDiagnostic = Readonly<{
    operationPurpose: string;
    status: number;
    contentType: 'declared' | 'missing' | 'undeclared';
    responseBodyBytes: number;
    finalUrlMatches: boolean;
    responseContractMatches: boolean;
    bodyPolicyAccepted: boolean | null;
}>;

type VoiceAccountResponseDiagnosticRecorder = (
    seed: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['seed'],
    diagnostic: VoiceAccountOperationResponseDiagnostic,
) => void;

function responseContractDiagnostic(input: Readonly<{
    operationPurpose: string;
    declaredContentTypes: readonly string[];
    expectedFinalUrl: string;
    response: Awaited<ReturnType<
        Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['execute']
    >>;
    bodyPolicyAccepted: boolean | null;
}>): VoiceAccountOperationResponseDiagnostic {
    const contentType = normalizedContentType(input.response.headers);
    const contentTypeClassification = contentType === null
        ? 'missing'
        : input.declaredContentTypes.includes(contentType)
            ? 'declared'
            : 'undeclared';
    const finalUrlMatches = input.response.finalUrl === input.expectedFinalUrl;
    return Object.freeze({
        operationPurpose: input.operationPurpose,
        status: input.response.status,
        contentType: contentTypeClassification,
        responseBodyBytes: input.response.body.byteLength,
        finalUrlMatches,
        responseContractMatches: input.response.status >= 200
            && input.response.status < 300
            && finalUrlMatches
            && contentTypeClassification === 'declared',
        bodyPolicyAccepted: input.bodyPolicyAccepted,
    });
}

function recordResponseDiagnosticBestEffort(input: Readonly<{
    record: VoiceAccountResponseDiagnosticRecorder;
    seed: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['seed'];
    diagnostic: VoiceAccountOperationResponseDiagnostic;
}>): void {
    try {
        input.record(input.seed, input.diagnostic);
    } catch {
        // Host diagnostics must not change the mediated provider operation.
    }
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
    seed: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['seed'];
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

export function createVoiceAccountPluginHttpCredentialBindingHost(params: Readonly<{
    voiceProviders: readonly VoiceProviderDeclaration[];
    credentialResolver: VoiceCredentialResolver;
    recordResponseDiagnostic?: VoiceAccountResponseDiagnosticRecorder;
}>): StablePluginHttpCredentialBindingHost {
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
            const operation = declaration.definition.credentials?.hostMediated?.operations.find(
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
            const recipientContractDigest = createVoiceProviderRecipientContractDigest(declaration);
            if (!recipientContractDigest) throw unauthorized();
            // The persisted selection identity (contribution, slot and purpose)
            // is projected from manifest truth so the credential resolver can
            // consult the Account-owned source selection for this exact target.
            let credentialIdentity: ReturnType<typeof deriveVoiceCredentialBindingIdentityV1>;
            try {
                credentialIdentity = deriveVoiceCredentialBindingIdentityV1({
                    pluginId: declaration.pluginId,
                    contribution: declaration.definition,
                });
            } catch {
                throw unauthorized();
            }
            if (!credentialIdentity || credentialIdentity.credentialSlotId !== operation.credentialSlotId) {
                throw unauthorized();
            }
            try {
                return await params.credentialResolver.withSecret({
                    identity: credentialIdentity,
                    recipientContractDigest,
                    use: async (sourceCredential) => {
                        assertCurrent(input);
                        if (!hasExactDeclaredOrigin(materialized.url, operation.request.origin)) {
                            throw unauthorized();
                        }
                        const credentialValue = operation.request.credential.format === 'bearer'
                            ? `Bearer ${sourceCredential}`
                            : sourceCredential;
                        const response = await input.execute(Object.freeze({
                            headers: Object.freeze({
                                [operation.request.credential.name]: credentialValue,
                            }),
                            secretHeaderNames: Object.freeze([operation.request.credential.name]),
                        }));
                        assertCurrent(input);
                        const responseDiagnostic = responseContractDiagnostic({
                            operationPurpose: operation.purpose,
                            declaredContentTypes: operation.response.contentTypes,
                            expectedFinalUrl: materialized.url,
                            response,
                            bodyPolicyAccepted: null,
                        });
                        if (!responseDiagnostic.responseContractMatches) {
                            if (params.recordResponseDiagnostic) {
                                recordResponseDiagnosticBestEffort({
                                    record: params.recordResponseDiagnostic,
                                    seed: input.seed,
                                    diagnostic: responseDiagnostic,
                                });
                            }
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
                            if (params.recordResponseDiagnostic) {
                                recordResponseDiagnosticBestEffort({
                                    record: params.recordResponseDiagnostic,
                                    seed: input.seed,
                                    diagnostic: Object.freeze({
                                        ...responseDiagnostic,
                                        bodyPolicyAccepted: false,
                                    }),
                                });
                            }
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
                if (isPluginError(error) && (
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
