import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import { createFetchPluginHttpRuntime, createStablePluginHttpHost, createProviderRedactionLease,
    redactPluginHttpResponse, wrapPluginHttpStream, readCredentialRedactionValues } from '@happier-dev/cli-common/plugins/http';
import { resolveAccountSettingsPluginSecretBinding } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { PluginDirectSecretDeclarationV1Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { runtimeFetchManualResponse } from '@/utils/system/runtimeFetch';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { scopedPluginSettingsAdapter, resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import { formatPluginSettingsAdministrationRevision } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';

/** Physical Account custody only; binding and resource envelopes keep their existing owners. */
export function createPluginSurfaceAccountNetworkServices(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    isCurrent(): boolean;
}>): Readonly<{ http: HttpService;
    secrets: SecretsService;
    /** Host invocation custody only; never exposed through plugin services. */
    registerRawForRedaction(value: string): void;
    redactDiagnosticText(value: string): string;
    snapshotRedactor(): (value: string) => string;
    dispose(): void }> {
    const lease = createProviderRedactionLease({ values: [] });
    const register = (value: string) => lease.add(readCredentialRedactionValues({ rawCredential: value }));
    const unavailable = (): never => { throw new PluginError({ code: 'plugin_secret_custody_unavailable' }); };
    const assertCurrent = () => {
        input.signal.throwIfAborted();
        if (!input.isCurrent() || !input.accountLifetime.isCurrent()) throw new PluginError({ code: 'plugin_generation_stale' });
    };
    const withAccount = async <T>(signal: AbortSignal | undefined,
        run: (context: Awaited<ReturnType<typeof captureLazyActionAccountContext>>) => Promise<T>): Promise<T> => {
        assertCurrent();
        const cancellation = mergeAbortSignals([input.signal, signal]);
        try {
            const context = await captureLazyActionAccountContext(input.accountLifetime.scope.serverId, cancellation.signal);
            try {
                if (context.accountId !== input.accountLifetime.scope.accountId) return unavailable();
                return await run(context);
            } finally { context.dispose(); }
        } finally { cancellation.dispose(); }
    };
    const secretId = (id: string) => PluginDirectSecretDeclarationV1Schema.parse({ id }).id;
    const binding = async (id: string, context: Awaited<ReturnType<typeof captureLazyActionAccountContext>>) => {
        const snapshot = await context.readRawSettingsSnapshot();
        return resolveAccountSettingsPluginSecretBinding(snapshot.raw, { pluginId: input.pluginId, localId: secretId(id) });
    };
    const settingsInput = (id: string) => {
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(input.accountLifetime.scope.serverId);
        if (!serverIdentityId) return unavailable();
        return { pluginId: input.pluginId, scope: { kind: 'account' as const }, target: { kind: 'account' as const, serverIdentityId },
            fields: [{ key: secretId(id), redacted: true }], signal: input.signal };
    };
    const status: SecretsService['status'] = async id => {
        assertCurrent();
        const result = await scopedPluginSettingsAdapter.read(settingsInput(id));
        if (result.status !== 'ready') return { state: 'unavailable', revision: 'unavailable' };
        return { state: result.snapshot.secretStates?.[id] === 'configured' ? 'configured' : 'missing',
            revision: formatPluginSettingsAdministrationRevision(result.snapshot.revision) };
    };
    const mutate = async (id: string, mutation: Readonly<{ kind: 'set'; value: string }> | Readonly<{ kind: 'delete' }>,
        options?: { expectedRevision?: string; signal?: AbortSignal }) => {
        assertCurrent();
        const selected = settingsInput(id);
        const before = await scopedPluginSettingsAdapter.read(selected);
        if (before.status !== 'ready') return unavailable();
        if (options?.expectedRevision !== undefined && options.expectedRevision !== formatPluginSettingsAdministrationRevision(before.snapshot.revision)) {
            throw new PluginError({ code: 'plugin_secret_revision_conflict' });
        }
        const cancellation = mergeAbortSignals([input.signal, options?.signal]);
        try {
            const result = await scopedPluginSettingsAdapter.write({ ...selected, fieldId: id, expectedRevision: before.snapshot.revision,
                mutation, signal: cancellation.signal, isCurrent: input.isCurrent });
            if (result.status === 'conflict') throw new PluginError({ code: 'plugin_secret_revision_conflict' });
            if (result.status === 'outcomeUnknown') throw new PluginError({ code: 'plugin_secret_outcome_unknown' });
            if (result.status !== 'applied' && result.status !== 'ready') return unavailable();
            return { revision: formatPluginSettingsAdministrationRevision(result.status === 'ready' ? result.snapshot.revision : result.revision) };
        } finally { cancellation.dispose(); }
    };
    const secrets: SecretsService = {
        status,
        get: (id, options) => withAccount(options?.signal, async context => {
            const selected = await binding(id, context);
            if (!selected) throw new PluginError({ code: 'plugin_secret_missing' });
            const result = await readSavedSecretReferenceInContext(context, selected.savedSecretId, options?.signal);
            if (!result.ok) return unavailable();
            register(result.value);
            return result.value;
        }),
        set: (id, value, options) => { assertCurrent(); register(value); return mutate(id, { kind: 'set', value }, options); },
        delete: (id, options) => mutate(id, { kind: 'delete' }, options),
    };
    const transport = createFetchPluginHttpRuntime(runtimeFetchManualResponse);
    const http = createStablePluginHttpHost({ adapter: {
        ...transport,
        async request(request, options) {
            try { return redactPluginHttpResponse(await transport.request(request, options), lease.redact); }
            catch (error) {
                if (error instanceof PluginError && !lease.containsSensitiveValue(error.code)) throw error;
                throw new PluginError({ code: options?.signal?.aborted ? 'plugin_action_aborted' : 'plugin_fetch_adapter_unavailable' });
            }
        },
        async requestStream(request, options) {
            const response = await transport.requestStream!(request, options);
            return wrapPluginHttpStream({ ...response, finalUrl: lease.redact(response.finalUrl),
                headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [lease.redact(name), lease.redact(value)])) },
                { signal: options?.signal, sanitizer: lease.createStreamingSanitizer() });
        },
    }, containsRegisteredSecret: ({ value }) => lease.containsSensitiveValue(value) })
        .bind({ plugin: { id: input.pluginId }, signal: input.signal, isOccurrenceCurrent: input.isCurrent }, {});
    return { http, secrets, registerRawForRedaction: register, redactDiagnosticText: lease.redact,
        snapshotRedactor: lease.snapshotRedactor, dispose: lease.close };
}
