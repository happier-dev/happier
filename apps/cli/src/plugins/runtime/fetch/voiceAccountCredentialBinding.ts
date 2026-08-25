import {
    containsProviderRegisteredSensitiveValue,
    deriveVoiceCredentialBindingIdentityV1,
    materializeRecipientOperationRequestV1FromOperation,
    resolveVoiceCredentialOperationAuthorization,
    resolveRequiredRecipientContractApprovalDigestV1,
    type RecipientOperationV1,
    type VoiceCredentialAccessPhase,
    type VoiceCredentialBindingIdentityV1,
    type VoiceCredentialOperationSelectedSource,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
    HttpService,
    PluginFetchCredentialBinding,
} from '@happier-dev/plugin-sdk/http';
import type { VoiceAccountOperationService } from '@happier-dev/plugin-sdk/voice';

import type { VoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import type {
    StablePluginHttpCredentialBindingHost,
} from './service';
import { createVoiceProviderRecipientContract } from '@/plugins/voiceProviderRecipientContract';

type VoiceProviderDeclaration = Readonly<{
    pluginId: string;
    identity: PluginContributionRef;
    definition: VoiceProviderContribution;
    provenance?: 'first_party' | 'external';
    source?: Readonly<{ kind: string }>;
    sourceSpec?: Readonly<{ kind: string; locator: string; trustPolicy?: string }>;
}>;

type VoiceAccountOperationResponse = Awaited<ReturnType<
    Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['execute']
>>;

type VoiceAccountOperationExecute = Parameters<
    StablePluginHttpCredentialBindingHost['request']
>[0]['execute'];

/**
 * Invocation-scoped currentness and cancellation truth for one mediated Voice
 * Account operation. The plugin-fetch seam projects it from the invocation
 * seed; the daemon speech seam projects it from the runtime lease. Neither
 * owns a second decision about whether the contributor generation is still
 * the admitted one.
 */
type VoiceAccountOperationAuthority = Readonly<{
    isCurrent(): boolean;
    isCancelled(): boolean;
}>;

/**
 * The credential-access phases in which a contribution kind may reach a
 * host-mediated Account operation. Client conversation runtimes disclose
 * mediated access across their settings, prepare and connection phases;
 * daemon speech runtimes use settings for declared settings actions and
 * speech for batch audio operations. The manifest still decides which
 * operations are projected into those phases.
 */
const ADMITTED_OPERATION_PHASES_BY_KIND: Readonly<Record<
    VoiceProviderContribution['kind'],
    readonly VoiceCredentialAccessPhase[]
>> = Object.freeze({
    conversation: Object.freeze<VoiceCredentialAccessPhase[]>(['settings', 'prepare', 'connection']),
    speech: Object.freeze<VoiceCredentialAccessPhase[]>(['settings', 'speech']),
});

/**
 * Whether a contribution declares at least one host-mediated operation its own
 * kind may reach, using the same phase admission the authorization owner
 * applies per operation. Hosts use it to decide whether to build a mediated
 * service at all; it never authorizes a particular operation.
 */
export function declaresAdmittedMediatedOperations(
    contribution: VoiceProviderContribution,
    phase?: VoiceCredentialAccessPhase,
): boolean {
    const credentials = contribution.credentials;
    if (!credentials?.hostMediated) return false;
    const admittedPhases = ADMITTED_OPERATION_PHASES_BY_KIND[contribution.kind];
    const declaredOperationIds = new Set(
        credentials.hostMediated.operations.map((operation) => operation.id),
    );
    return credentials.sources.some((source) => source.operationProjections?.some((projection) => (
        declaredOperationIds.has(projection.operation)
        && admittedPhases.includes(projection.phase)
        && (phase === undefined || projection.phase === phase)
    )) === true);
}

function unauthorized(): PluginError {
    return new PluginError({
        code: 'plugin_fetch_voice_account_operation_unauthorized',
        message: 'The Voice account operation is not authorized for this invocation',
    });
}

function phaseAuthorityUnavailable(): PluginError {
    return new PluginError({
        code: 'plugin_fetch_voice_account_operation_phase_authority_unavailable',
        message: 'The Voice account operation has no host-owned phase authority',
    });
}

function credentialUnavailable(): PluginError {
    return new PluginError({
        code: 'plugin_voice_credential_unavailable',
        message: 'The required Voice account credential is unavailable',
    });
}

function cancelled(): PluginError {
    return new PluginError({
        code: 'plugin_fetch_voice_account_operation_cancelled',
        message: 'The Voice account operation was cancelled',
    });
}

function retired(): PluginError {
    return new PluginError({
        code: 'plugin_final_generation_retired',
        message: 'Plugin generation is no longer current',
    });
}

function assertCurrent(authority: VoiceAccountOperationAuthority): void {
    if (!authority.isCurrent()) throw retired();
    if (authority.isCancelled()) throw cancelled();
}

function seedAuthority(input: Readonly<{
    seed: Parameters<StablePluginHttpCredentialBindingHost['request']>[0]['seed'];
    signal: AbortSignal | undefined;
}>): VoiceAccountOperationAuthority {
    return Object.freeze({
        isCurrent: () => input.seed.isGenerationCurrent(),
        isCancelled: () => input.seed.signal.aborted || input.signal?.aborted === true,
    });
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

function selectedSavedSecretSource(
    credentialResolver: VoiceCredentialResolver,
    identity: VoiceCredentialBindingIdentityV1,
): VoiceCredentialOperationSelectedSource {
    let selection: ReturnType<VoiceCredentialResolver['resolveSelectedSource']>;
    try {
        selection = credentialResolver.resolveSelectedSource(identity);
    } catch {
        throw unauthorized();
    }
    if (selection?.kind !== 'savedSecret') throw credentialUnavailable();
    return Object.freeze({ kind: 'savedSecret' });
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
    response: VoiceAccountOperationResponse;
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

function recordResponseDiagnosticBestEffort(
    record: ((diagnostic: VoiceAccountOperationResponseDiagnostic) => void) | undefined,
    diagnostic: VoiceAccountOperationResponseDiagnostic,
): void {
    if (!record) return;
    try {
        record(diagnostic);
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

function sanitizeFailure(error: unknown, authority: VoiceAccountOperationAuthority): PluginError {
    if (!authority.isCurrent()) return retired();
    if (authority.isCancelled()) return cancelled();
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

type AuthorizedVoiceAccountOperation = Readonly<{
    declaration: VoiceProviderDeclaration;
    operation: RecipientOperationV1;
    materialized: ReturnType<typeof materializeRecipientOperationRequestV1FromOperation>;
    credentialIdentity: VoiceCredentialBindingIdentityV1;
    /**
     * The stored approval this call must still match, or `null` when the
     * recipient carries no re-approval fence (a first-party bundled
     * publisher — see the protocol owner).
     */
    requiredRecipientApprovalDigest: string | null;
}>;

/**
 * One authorization owner for every host-mediated Voice Account operation.
 *
 * It resolves the exact declaration, the declared operation, the phase that
 * contribution kind may use it in, the declared origin, the persisted
 * selection identity and the approved recipient contract digest. Both the
 * plugin-fetch seam and the daemon speech seam consume this decision; neither
 * re-derives any part of it.
 */
function authorizeVoiceAccountOperation(input: Readonly<{
    declarations: readonly VoiceProviderDeclaration[];
    provider: PluginContributionRef;
    kind: VoiceProviderContribution['kind'];
    phase: VoiceCredentialAccessPhase;
    credentialResolver: VoiceCredentialResolver;
    operationId: string;
    parameters: unknown;
}>): AuthorizedVoiceAccountOperation {
    const declaration = findVoiceProviderDeclaration(input.declarations, input.provider);
    if (!declaration || declaration.definition.kind !== input.kind) throw unauthorized();
    const credentials = declaration.definition.credentials;
    const operation = credentials?.hostMediated?.operations.find(
        (candidate) => candidate.id === input.operationId,
    );
    if (!credentials || !operation) throw unauthorized();
    let materialized: ReturnType<typeof materializeRecipientOperationRequestV1FromOperation>;
    try {
        materialized = materializeRecipientOperationRequestV1FromOperation({
            operation,
            parameters: input.parameters,
        });
    } catch {
        throw unauthorized();
    }
    if (!hasExactDeclaredOrigin(materialized.url, operation.request.origin)) throw unauthorized();
    const recipientContract = createVoiceProviderRecipientContract(declaration);
    if (!recipientContract) throw unauthorized();
    const requiredRecipientApprovalDigest =
        resolveRequiredRecipientContractApprovalDigestV1(recipientContract);
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
    const selectedSource = selectedSavedSecretSource(input.credentialResolver, credentialIdentity);
    const credentialAuthorization = resolveVoiceCredentialOperationAuthorization({
        pluginId: declaration.pluginId,
        contributionId: declaration.identity.localId,
        contribution: declaration.definition,
        selectedSource,
        phase: input.phase,
        operationId: operation.id,
    });
    if (!credentialAuthorization || credentialAuthorization.projection.kind !== 'recipientCredential') {
        throw unauthorized();
    }
    return Object.freeze({
        declaration,
        operation,
        materialized,
        credentialIdentity,
        requiredRecipientApprovalDigest,
    });
}

/**
 * Resolves the Account-selected secret for one authorized operation, injects
 * it only for the exact declared request, and returns provider material only
 * after the declared response contract holds. The secret never reaches the
 * caller.
 */
async function executeVoiceAccountOperation(input: Readonly<{
    authorized: AuthorizedVoiceAccountOperation;
    authority: VoiceAccountOperationAuthority;
    credentialResolver: VoiceCredentialResolver;
    execute: VoiceAccountOperationExecute;
    recordResponseDiagnostic?: (diagnostic: VoiceAccountOperationResponseDiagnostic) => void;
}>): Promise<VoiceAccountOperationResponse> {
    const {
        operation,
        materialized,
        credentialIdentity,
        requiredRecipientApprovalDigest,
    } = input.authorized;
    try {
        return await input.credentialResolver.withSecret({
            identity: credentialIdentity,
            ...(requiredRecipientApprovalDigest
                ? { recipientContractDigest: requiredRecipientApprovalDigest }
                : {}),
            use: async (sourceCredential) => {
                assertCurrent(input.authority);
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
                assertCurrent(input.authority);
                const responseDiagnostic = responseContractDiagnostic({
                    operationPurpose: operation.purpose,
                    declaredContentTypes: operation.response.contentTypes,
                    expectedFinalUrl: materialized.url,
                    response,
                    bodyPolicyAccepted: null,
                });
                if (!responseDiagnostic.responseContractMatches) {
                    recordResponseDiagnosticBestEffort(
                        input.recordResponseDiagnostic,
                        responseDiagnostic,
                    );
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
                    recordResponseDiagnosticBestEffort(
                        input.recordResponseDiagnostic,
                        Object.freeze({
                            ...responseDiagnostic,
                            bodyPolicyAccepted: false,
                        }),
                    );
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
        throw sanitizeFailure(error, input.authority);
    }
}

export function createVoiceAccountPluginHttpCredentialBindingHost(params: Readonly<{
    voiceProviders: readonly VoiceProviderDeclaration[];
    credentialResolver: VoiceCredentialResolver;
    /**
     * Bound only by a host Voice lifecycle owner. Generic plugin invocations
     * have no truthful phase and therefore fail closed below.
     */
    phase?: Exclude<VoiceCredentialAccessPhase, 'speech'>;
    recordResponseDiagnostic?: VoiceAccountResponseDiagnosticRecorder;
}>): StablePluginHttpCredentialBindingHost {
    return Object.freeze({
        async request(input) {
            const authority = seedAuthority(input);
            assertCurrent(authority);
            const binding: PluginFetchCredentialBinding = input.credentialBinding;
            if (
                binding.kind !== 'voiceAccountOperation'
                || binding.provider.pluginId !== input.seed.plugin.id
            ) {
                throw unauthorized();
            }
            if (!params.phase) throw phaseAuthorityUnavailable();
            const authorized = authorizeVoiceAccountOperation({
                declarations: params.voiceProviders,
                provider: binding.provider,
                kind: 'conversation',
                phase: params.phase,
                credentialResolver: params.credentialResolver,
                operationId: binding.operation,
                parameters: binding.parameters,
            });
            const materialized = authorized.materialized;
            const operation = authorized.operation;
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
            return await executeVoiceAccountOperation({
                authorized,
                authority,
                credentialResolver: params.credentialResolver,
                execute: input.execute,
                ...(params.recordResponseDiagnostic
                    ? {
                        recordResponseDiagnostic: (diagnostic: VoiceAccountOperationResponseDiagnostic) => {
                            params.recordResponseDiagnostic?.(input.seed, diagnostic);
                        },
                    }
                    : {}),
            });
        },
    });
}

/**
 * Invocation-scoped host-mediated Account operations for a runtime that the
 * host itself calls, rather than one issuing its own bounded fetch.
 *
 * It is the same Account-operation owner the plugin-fetch seam uses: the same
 * declaration lookup, phase projection, recipient contract digest, credential
 * selection, currentness, cancellation and response contract. Only the
 * transport differs, because the host — not the contributor — issues the
 * request for these phases.
 */
export function createVoiceAccountOperationService(params: Readonly<{
    voiceProviders: readonly VoiceProviderDeclaration[];
    provider: PluginContributionRef;
    kind: VoiceProviderContribution['kind'];
    /** Exact lifecycle phase owned by the host calling this operation service. */
    phase: VoiceCredentialAccessPhase;
    credentialResolver: VoiceCredentialResolver;
    isCurrent(): boolean;
    signal: AbortSignal;
    /**
     * Host-owned transport. These phases are ones the host itself calls, so
     * the mediated request never passes through the contributor's own bounded
     * network service or its request policy.
     */
    transport: Pick<HttpService, 'request'>;
    recordResponseDiagnostic?(diagnostic: VoiceAccountOperationResponseDiagnostic): void;
}>): VoiceAccountOperationService {
    return Object.freeze({
        async request(request) {
            const authority: VoiceAccountOperationAuthority = Object.freeze({
                isCurrent: () => params.isCurrent(),
                isCancelled: () => params.signal.aborted || request.signal.aborted,
            });
            assertCurrent(authority);
            const authorized = authorizeVoiceAccountOperation({
                declarations: params.voiceProviders,
                provider: params.provider,
                kind: params.kind,
                phase: params.phase,
                credentialResolver: params.credentialResolver,
                operationId: request.operationId,
                parameters: request.parameters,
            });
            const materialized = authorized.materialized;
            return await executeVoiceAccountOperation({
                authorized,
                authority,
                credentialResolver: params.credentialResolver,
                execute: async (injection) => await params.transport.request(
                    Object.freeze({
                        url: materialized.url,
                        method: materialized.method,
                        headers: Object.freeze({
                            ...materialized.headers,
                            ...injection.headers,
                        }),
                        ...(materialized.body ? { body: materialized.body } : {}),
                        redirect: materialized.redirect,
                    }),
                    Object.freeze({ signal: request.signal }),
                ),
                ...(params.recordResponseDiagnostic
                    ? { recordResponseDiagnostic: params.recordResponseDiagnostic }
                    : {}),
            });
        },
    });
}
