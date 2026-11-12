import { isPluginError, PluginError } from '../errors.js';
import { readPluginActionError, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ConnectedAccountMaterialization } from '../../connectedAccounts/establishedRuntimeTypes.js';
import { ConnectedAccountHttpHeadersRequestSchema, type ConnectedAccountMaterializationRequest } from '@happier-dev/protocol/connect/connected-account-purposes';
import { CredentialRequestRedirectError } from '../../homeTarget/index.js';
import { createProviderRedactionLease, redactPluginHttpResponse } from './redaction.js';
import { readCredentialRedactionValues } from './credentialRedactionValues.js';
import { mergeAbortSignals, raceWithAbort, type PluginHttpInvocationSeed, type PluginHttpServiceBinding, type StablePluginHttpPurposeHost, type PluginHttpPurposeInjection } from './service.js';

function refused(): never {
    throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
        message: 'The request does not match the admitted credential purpose' });
}

/** Credential issuance scope, shared by purpose and mediated-operation HTTP. */
export function hasExactPluginHttpCredentialScope(input: Readonly<{
    url: string; method: string; issued: Readonly<{ origin: string; method: string }>;
}>): boolean {
    try { return new URL(input.url).origin === input.issued.origin && input.method === input.issued.method; }
    catch { return false; }
}

/** Both physical hosts spend their existing admitted purpose service here. */
export function createConnectedAccountHttpPurposeHost<
    Seed extends PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding,
>(params: Readonly<{
    bind(input: Readonly<{ seed: Seed; serviceBinding: Binding; purpose: string }>): Readonly<{
        materialize(
            purpose: string,
            request: ConnectedAccountMaterializationRequest,
            options: Readonly<{ signal: AbortSignal }>,
        ): Promise<ConnectedAccountMaterialization>;
    }>;
    captureSubject?(binding: Binding): string | undefined;
    sanitizeFailure?(error: unknown, entered: boolean, containsSensitiveValue: (value: string) => boolean,
        publicFailure: PluginError): never;
}>): StablePluginHttpPurposeHost<Seed, Binding> {
    type RequestContext = Parameters<StablePluginHttpPurposeHost<Seed, Binding>['request']>[0];
    const sanitizeFailure = (error: unknown, entered: boolean,
        containsSensitiveValue: (value: string) => boolean): never => {
        if (error instanceof CredentialRequestRedirectError) throw error;
        const pluginFailure = isPluginError(error) ? error : undefined;
        const code = pluginFailure && !containsSensitiveValue(pluginFailure.code)
            ? pluginFailure.code : entered ? 'outcome_unknown' : 'credential_unavailable';
        const authored = pluginFailure && code === pluginFailure.code
            ? readPluginActionFailureAuthorPayload(readPluginActionError(pluginFailure)?.data) : {};
        // Credential registration includes JSON-escaped values. Admit each public
        // field independently; private diagnostics and raw Error causes stay local.
        const safeField = <T>(value: T | undefined): T | undefined => value === undefined
            || containsSensitiveValue(JSON.stringify(value)) ? undefined : value;
        const message = pluginFailure && code === pluginFailure.code && pluginFailure.data.message !== undefined
            && !containsSensitiveValue(pluginFailure.data.message) ? pluginFailure.data.message : undefined;
        const details = safeField(authored.details);
        const remediation = safeField(authored.remediation);
        let failureCause = pluginFailure?.data.failureCause === undefined
            ? undefined : readActionFailureCauseV1(pluginFailure.data.failureCause);
        if (failureCause && 'nativeErrorCode' in failureCause && failureCause.nativeErrorCode !== undefined
            && containsSensitiveValue(failureCause.nativeErrorCode)) {
            const { nativeErrorCode: _nativeErrorCode, ...safeCause } = failureCause;
            failureCause = safeCause;
        }
        const publicFailure = new PluginError({ code,
            ...(message === undefined ? {} : { message }),
            ...(pluginFailure && code === pluginFailure.code ? { retryable: pluginFailure.retryable } : {}),
            ...(details === undefined ? {} : { details }),
            ...(remediation === undefined ? {} : { remediation }),
            ...(failureCause === undefined ? {} : { failureCause }),
        });
        if (params.sanitizeFailure) return params.sanitizeFailure(error, entered, containsSensitiveValue, publicFailure);
        throw publicFailure;
    };
    // A finite invocation spends the binding admitted by its first acquisition.
    // The incumbent refresh owner requires a current revisioned snapshot and a
    // write-back lease; it cannot refresh this capture after unlink. Expiry is
    // therefore visible and retryable at the next invocation, never a reselection.
    const captures = new WeakMap<Seed, Map<string, Promise<Readonly<Record<string, string>>>>>();
    const prepare = (input: Omit<RequestContext, 'request' | 'execute'> & Readonly<{
        request: Pick<RequestContext['request'], 'url' | 'method' | 'headers' | 'credentialBinding'>;
    }>) => {
        const binding = input.request.credentialBinding;
        if (binding?.kind !== 'connectedAccountPurpose') return null;
        const materialization = ConnectedAccountHttpHeadersRequestSchema.safeParse({ kind: 'httpHeaders',
            origin: binding.origin, headerNames: binding.headerNames });
        if (!materialization.success) return refused();
        // This is the credential's issuance boundary, not a plugin network fence.
        if (!hasExactPluginHttpCredentialScope({ url: input.request.url, method: input.request.method ?? 'GET',
            issued: { origin: materialization.data.origin, method: binding.method } })
            || Object.keys(input.request.headers ?? {}).some(name =>
            materialization.data.headerNames.some(issued => issued.toLowerCase() === name.toLowerCase()))) return refused();
        const service = params.bind({ seed: input.seed, serviceBinding: input.serviceBinding, purpose: binding.purpose });
        let invocation = captures.get(input.seed);
        if (!invocation) { invocation = new Map(); captures.set(input.seed, invocation); }
        const key = JSON.stringify([params.captureSubject?.(input.serviceBinding) ?? null, binding.purpose,
            materialization.data.origin, [...materialization.data.headerNames].map(name => name.toLowerCase()).sort()]);
        let capture = invocation.get(key);
        if (!capture) {
            capture = (async () => {
                const material = await service.materialize(binding.purpose, materialization.data, { signal: input.seed.signal });
                if (material.kind !== 'httpHeaders') return refused();
                return Object.freeze({ ...material.headers });
            })();
            // Cancellation can refuse a fragment before it awaits this capture.
            // Observe failures now; later fragments still await the original promise.
            void capture.catch(() => undefined);
            invocation.set(key, capture);
        }
        const admitted = capture;
        return { async materialize() {
                input.seed.signal.throwIfAborted();
                input.signal?.throwIfAborted();
                const cancellation = mergeAbortSignals([input.seed.signal, input.signal]);
                let headers: Readonly<Record<string, string>>;
                try { headers = await raceWithAbort(admitted, cancellation.signal); }
                finally { cancellation.dispose(); }
                input.signal?.throwIfAborted();
                const lease = createProviderRedactionLease({ values: Object.values(headers)
                    .flatMap(authorizationValue => readCredentialRedactionValues({ authorizationValue })) });
                const injection: PluginHttpPurposeInjection = { headers,
                    secretHeaderNames: Object.keys(headers),
                    redact: lease.redact, createStreamingSanitizer: lease.createStreamingSanitizer };
                return { lease, injection };
            },
        };
    };
    return {
        async request(input) {
            const admission = prepare(input);
            if (!admission) return await input.execute();
            const prepared = await admission.materialize();
            let entered = false;
            try {
                entered = true;
                const response = await input.execute(prepared.injection);
                if (response.status === 401) throw new PluginError({ code: 'credential_unavailable' });
                return redactPluginHttpResponse(response, prepared.lease.redact);
            } catch (error) { return sanitizeFailure(error, entered, prepared.lease.containsSensitiveValue); }
            finally { prepared.lease.close(); }
        },
        async requestStream(input) {
            const admission = prepare(input);
            if (!admission) return await input.execute();
            let prepared: Awaited<ReturnType<typeof admission.materialize>> | undefined;
            let response: Awaited<ReturnType<typeof input.execute>> | undefined;
            let entered = false;
            let disposed = false;
            const dispose = async () => {
                if (disposed) return;
                disposed = true;
                try { await response?.dispose(); } finally { prepared?.lease.close(); }
            };
            try {
                const material = await admission.materialize();
                prepared = material;
                entered = true;
                response = await input.execute(material.injection);
                if (response.status === 401) throw new PluginError({ code: 'credential_unavailable' });
                const retained = response;
                return { ...response, finalUrl: material.lease.redact(response.finalUrl),
                    headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) =>
                        [material.lease.redact(name), material.lease.redact(value)])),
                    chunks: { async *[Symbol.asyncIterator]() {
                        try { for await (const chunk of retained.chunks) yield chunk; }
                        finally { await dispose(); }
                    } }, dispose };
            } catch (error) {
                try {
                    input.seed.signal.throwIfAborted();
                    input.signal?.throwIfAborted();
                    return sanitizeFailure(error, entered, value => prepared?.lease.containsSensitiveValue(value) ?? false);
                } finally { await dispose(); }
            }
        },
    };
}
