import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { ConnectedAccountHttpHeadersRequestSchema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { SavedSecretOperationAdmissionFailureReasonV1Schema } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PluginSecretSourceFailureV1Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { redactPluginHttpResponse } from '@happier-dev/cli-common/plugins/http';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { savedSecretOperationAdmissionStatus } from '@/settings/secrets/savedSecretCatalog';
import { createStablePluginConnectedAccountsHost, type StablePluginConnectedAccountsOwner,
    type StablePluginConnectedAccountsHostOptions } from '../invocation/services/connectedAccounts';
import { readCredentialRedactionValues } from '../invocation/services/credentialRedactionValues';
import { hasExactPluginHttpCredentialScope } from './voiceAccountCredentialBinding';
import type { StablePluginHttpPurposeHost, PluginHttpPurposeInjection } from './service';

type RequestContext = Parameters<StablePluginHttpPurposeHost['request']>[0];

function refused(): never {
    throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
        message: 'The request does not match the admitted credential purpose' });
}

/** Only the closed material-repair envelope may cross this error-redaction boundary. */
function readMaterialSourceFailureDetails(details: unknown) {
    if (!details || typeof details !== 'object' || !('materialStatus' in details) || !('sourceFailure' in details)
        || !details.sourceFailure || typeof details.sourceFailure !== 'object') return undefined;
    const materialStatus = SavedSecretOperationAdmissionFailureReasonV1Schema.options
        .map(savedSecretOperationAdmissionStatus).find(status => status === details.materialStatus);
    const source = PluginSecretSourceFailureV1Schema.safeParse({ ...details.sourceFailure, ok: false });
    if (!materialStatus || !source.success) return undefined;
    return { materialStatus, sourceFailure: { code: source.data.code, ...(source.data.repair ? { repair: source.data.repair } : {}) } };
}

/** Host-kept headers spend the invocation's existing exact purpose selection. */
export function createConnectedAccountPluginHttpPurposeHost(owner: StablePluginConnectedAccountsOwner,
    redaction: Pick<StablePluginConnectedAccountsHostOptions, 'registerRawForRedaction'>): StablePluginHttpPurposeHost {
    const host = createStablePluginConnectedAccountsHost(owner, {
        registerRawForRedaction: redaction.registerRawForRedaction,
        // This adapter requests only httpHeaders; file-byte registration is unreachable.
        registerExactForRedaction: redaction.registerRawForRedaction,
    });
    // A finite invocation spends the binding admitted by its first acquisition.
    // The incumbent refresh owner requires a current revisioned snapshot and a
    // write-back lease; it cannot refresh this capture after unlink. Expiry is
    // therefore visible and retryable at the next invocation, never a reselection.
    const captures = new WeakMap<RequestContext['seed'], Map<string, Promise<Readonly<Record<string, string>>>>>();
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
        const scope = input.serviceBinding.connectedAccountScopes?.find(scope => scope.purpose === binding.purpose);
        if (!scope) return refused();
        const service = host.bind(input.seed, input.serviceBinding.connectedAccountScopes ?? [], {
            exactPurposeBindingSubjectId: input.serviceBinding.exactPurposeBindingSubjectId,
        });
        let invocation = captures.get(input.seed);
        if (!invocation) { invocation = new Map(); captures.set(input.seed, invocation); }
        const key = JSON.stringify([input.serviceBinding.exactPurposeBindingSubjectId ?? null, binding.purpose,
            materialization.data.origin, [...materialization.data.headerNames].map(name => name.toLowerCase()).sort()]);
        let capture = invocation.get(key);
        if (!capture) {
            capture = (async () => {
                const material = await service.materialize(binding.purpose, materialization.data,
                    { signal: input.seed.signal });
                if (material.kind !== 'httpHeaders') return refused();
                return Object.freeze({ ...material.headers });
            })();
            // Cancellation can refuse a fragment before it awaits this capture.
            // Observe failures now; later fragments still await the original promise.
            void capture.catch(() => undefined);
            invocation.set(key, capture);
        }
        const admitted = capture;
        return { scope, purpose: { consumer: { pluginId: input.seed.plugin.id,
            localId: input.seed.contribution.id }, purpose: binding.purpose },
            async materialize() {
                input.seed.signal.throwIfAborted();
                input.signal?.throwIfAborted();
                const headers = await admitted;
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
    const sanitizeFailure = (error: unknown, entered: boolean,
        containsSensitiveValue: (value: string) => boolean): never => {
        if (error instanceof CredentialRequestRedirectError) throw error;
        const code = isPluginError(error) && !containsSensitiveValue(error.code)
            ? error.code : entered ? 'outcome_unknown' : 'credential_unavailable';
        const details = !entered && isPluginError(error) ? readMaterialSourceFailureDetails(error.details) : undefined;
        throw new PluginError({ code, message: code === 'credential_unavailable' ? 'Sign in again, then retry.' : code,
            ...(details ? { details } : {}) });
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
                try { return sanitizeFailure(error, entered, value => prepared?.lease.containsSensitiveValue(value) ?? false); }
                finally { await dispose(); }
            }
        },
    };
}
