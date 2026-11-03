import type { PluginResourceContextV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginCollectionReadErrorCodeV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { PluginUiResourceClient } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import type { PluginDynamicResourceInvocationOptionsV1, ResourcesService } from '@happier-dev/plugin-sdk/resources';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolvePluginUiAccountResourceRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginUiProjectedActionResolver, readPluginUiResourceProjection, resolvePluginUiClientExecutablePlatform,
    type PluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginUiAccountStorageScope } from '@/sync/api/plugins/data/pluginUiDataClient';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { readPluginSurfaceResourceReference } from './pluginSurfaceResourceRead';
import { createPluginSurfaceResourceActionServices } from './pluginSurfaceResourceActionServices';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { readObservedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

function awaitResourceOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
            if (settled) return false;
            settled = true;
            signal.removeEventListener('abort', abort);
            return true;
        };
        const abort = () => { if (settle()) reject(Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' })); };
        signal.addEventListener('abort', abort, { once: true });
        void operation.then(value => { if (settle()) resolve(value); }, error => { if (settle()) reject(error); });
        if (signal.aborted) abort();
    });
}

/** Transport over the existing selected Account activation, without a second Resource loader. */
export function createPluginAccountResourceClient(input: Readonly<{
    pluginId: string;
    declaration: PluginUiResourceProjection;
    accountLifetime: ActiveServerAccountScopeLifetime;
    context: PluginResourceContextV1;
    /** Already selected by the enclosing host; never elect a Machine from Resource custody. */
    actionExecutionTarget?: SessionExecutionTargetV1;
    bindResources(input: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): ResourcesService;
    /** Join the one already-demanded snapshot after observation admission; never refresh it. */
    readBaseline(signal: AbortSignal): Promise<PluginUiResourceSnapshot>;
    isCurrent(): boolean;
}>): PluginUiResourceClient & Readonly<{ lifetime: Readonly<{ isCurrent(): boolean; onRetire(cancel: () => void): Readonly<{ dispose(): void }> }> }> {
    const projectedOrigin = readPluginUiAccountExecutableOrigin(input.declaration);
    let attaching: Promise<void> | null = null;
    const declarationIsCurrent = () => {
        const projection = readCurrentAppShellPluginUiProjection({ scope: input.accountLifetime.scope, declarationsOnly: true });
        return readPluginUiAccountExecutableOrigin(readPluginUiResourceProjection(projection?.resourcesById,
            { pluginId: input.pluginId, localId: input.declaration.id }))?.custodyId === projectedOrigin?.custodyId;
    };
    const cancellations = new Set<() => void>();
    let producerSignal: AbortSignal | undefined;
    const retire = () => { for (const cancel of [...cancellations]) cancel(); cancellations.clear(); };
    const lifetime = Object.freeze({
        isCurrent: () => input.accountLifetime.isCurrent() && producerSignal?.aborted !== true,
        onRetire(cancel: () => void) {
            if (!lifetime.isCurrent()) { cancel(); return { dispose() {} }; }
            cancellations.add(cancel);
            return { dispose() { cancellations.delete(cancel); if (cancellations.size === 0) producerSignal?.removeEventListener('abort', retire); } };
        },
    });
    const resolve = async (signal?: AbortSignal) => {
        if (!input.isCurrent() || !input.accountLifetime.isCurrent() || !projectedOrigin
            || projectedOrigin.accountId !== input.accountLifetime.scope.accountId
            || projectedOrigin.serverId !== input.accountLifetime.scope.serverId) {
            throw Object.assign(new Error('Account Resource retired'), { code: 'plugin_surface_retired' });
        }
        if (input.declaration.scope !== input.context.kind) {
            throw Object.assign(new Error('Resource context is unavailable'), { code: 'plugin_resource_context_unavailable' });
        }
        const projection = readCurrentAppShellPluginUiProjection({ scope: input.accountLifetime.scope, declarationsOnly: true });
        const current = readPluginUiResourceProjection(projection?.resourcesById,
            { pluginId: input.pluginId, localId: input.declaration.id });
        const currentOrigin = readPluginUiAccountExecutableOrigin(current);
        if (!current || currentOrigin?.custodyId !== projectedOrigin.custodyId) {
            throw Object.assign(new Error('Account Resource unavailable'), { code: 'plugin_resource_not_found' });
        }
        const selected = resolvePluginUiAccountResourceRegistration({ resource: current, platform: resolvePluginUiClientExecutablePlatform() });
        if (!selected) throw Object.assign(new Error('Account Resource activation unavailable'), { code: 'plugin_resource_unavailable' });
        await selected.registration.prepare?.(signal);
        if (selected.runtime.createProducer) {
            throw Object.assign(new Error('Context producers require daemon Resource placement'), { code: 'plugin_resource_producer_placement_unavailable' });
        }
        if (!producerSignal) {
            producerSignal = selected.registration.lifecycle.signal;
            producerSignal.addEventListener('abort', retire, { once: true });
            if (producerSignal.aborted) retire();
        }
        return selected;
    };
    const invocation = async (signal?: AbortSignal, onReadAuthorityRetired?: () => void) => {
        const selected = await resolve(signal);
        const controller = new AbortController();
        const cancellation = mergeAbortSignals([signal, controller.signal, selected.registration.lifecycle.signal]);
        const isCurrent = () => !cancellation.signal.aborted && input.isCurrent() && input.accountLifetime.isCurrent() && declarationIsCurrent()
            && selected.registration.lifecycle.isCurrent();
        const retirement = input.accountLifetime.onRetire(() => controller.abort());
        const actions = createPluginSurfaceResourceActionServices({ registration: selected.registration,
            sourceCustody: projectedOrigin!.sourceCustody, context: input.context, signal: cancellation.signal, isCurrent,
            ...(input.actionExecutionTarget ? { contributedAction: input.actionExecutionTarget } : {}),
            retireObservation() {
                if (!isCurrent()) return;
                try { onReadAuthorityRetired?.(); } finally { controller.abort(); }
            },
            resolveContributedAction: identity => {
                const account = createPluginUiProjectedActionResolver(readCurrentAppShellPluginUiProjection({
                    scope: input.accountLifetime.scope, declarationsOnly: true })?.actionsById)(identity);
                if (account?.execution.target === 'account') return account;
                // Session/main surfaces have already demanded this exact Machine
                // through the shared projection owner. Never borrow another
                // plugin's ambient Runs-on choice or start a second loader.
                const target = input.actionExecutionTarget;
                const machine = target ? readObservedDaemonMergedProjectionCacheEntry({ ...target,
                    accountLifetime: input.accountLifetime, sections: ['actionsById'] }) : null;
                const action = machine?.kind === 'ready'
                    ? createPluginUiProjectedActionResolver(machine.inputs.pluginUiProjection.actionsById)(identity) : null;
                return action?.execution.target === 'daemon' ? action : null;
            } });
        const availability = readPluginAccountAvailability(input.accountLifetime.scope);
        const execution = availability.readCurrentAccountExecution(input.pluginId);
        const declaration = execution.kind === 'available' ? execution.manifest.contributes.resources?.find(resource =>
            resource.id === input.declaration.id && resource.source === 'dynamic') : undefined;
        const dynamic = declaration?.source === 'dynamic' ? declaration : undefined;
        const needsStorage = dynamic?.hostAccess?.some(id => execution.kind === 'available'
            && [...execution.manifest.hostAccess.required, ...execution.manifest.hostAccess.optional]
                .some(request => request.id === id && request.capability === 'storage.account'));
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: cancellation.signal, context: input.context,
            resources: input.bindResources({ signal: cancellation.signal, isCurrent }),
            readAction: actions.readAction, observeAction: actions.observeAction,
            ...(needsStorage ? { accountStorage: createPluginUiAccountStorageScope({ pluginId: input.pluginId,
                accountLifetime: input.accountLifetime, readAvailability: () => availability, signal: cancellation.signal, isCurrent }) } : {}) };
        return { ...selected, options, isCurrent, maxBytes: dynamic?.maxBytes ?? MAX_PLUGIN_DYNAMIC_RESOURCE_DECLARED_BYTES_V2,
            dispose() { controller.abort(); actions.dispose(); retirement.dispose(); cancellation.dispose(); } };
    };
    const assertReference = (resource: Parameters<PluginUiResourceClient['readResource']>[0]) => {
        const ref = readPluginSurfaceResourceReference(input.pluginId, resource);
        if (ref?.pluginId !== input.pluginId || ref.localId !== input.declaration.id) {
            throw Object.assign(new Error('Resource is not declared'), { code: 'plugin_resource_not_found' });
        }
    };
    return Object.freeze({
        lifetime,
        async readResource(resource, options) {
            assertReference(resource);
            await readPluginAccountAvailability(input.accountLifetime.scope).ensureCurrentAccountExecution(input.pluginId);
            const pendingAttachment = attaching;
            if (pendingAttachment) await (options?.signal ? awaitResourceOperation(pendingAttachment, options.signal) : pendingAttachment);
            const bound = await invocation(options?.signal);
            try {
                if (!bound.isCurrent()) throw Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' });
                const content = await bound.runtime.read(bound.options);
                if (!bound.isCurrent()) throw Object.assign(new Error('Account Resource retired'), { code: 'plugin_surface_retired' });
                const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
                if (!(bytes instanceof Uint8Array) || !input.declaration.contentType) {
                    throw Object.assign(new Error('Resource response is invalid'), { code: 'plugin_resource_payload_invalid' });
                }
                if (bytes.byteLength > bound.maxBytes) throw Object.assign(new Error('Resource exceeds its declared byte budget'), { code: 'plugin_resource_too_large' });
                return Object.freeze({ bytes, contentType: input.declaration.contentType,
                    digest: computePluginUiArtifactSha256DigestV1(bytes) });
            } finally { bound.dispose(); }
        },
        async watchResource(resource, listener, options) {
            assertReference(resource);
            await readPluginAccountAvailability(input.accountLifetime.scope).ensureCurrentAccountExecution(input.pluginId);
            const bound = await invocation(options?.signal, () => expire());
            let admit!: () => void;
            let refuse!: (error: unknown) => void;
            const admission = new Promise<void>((resolve, reject) => { admit = resolve; refuse = reject; });
            attaching = admission;
            // The watch Promise owns reporting; a snapshot-only race may not join this bookkeeping Promise.
            void admission.catch(() => {});
            let observation: Disposable | undefined;
            let closed = false;
            let observationDisposed = false;
            let cleanup: void | Promise<void>;
            const dispose = () => {
                closed = true;
                bound.options.signal.removeEventListener('abort', onAbort);
                bound.dispose();
                if (observation && !observationDisposed) {
                    observationDisposed = true;
                    cleanup = observation.dispose();
                }
                return cleanup;
            };
            const onAbort = () => {
                refuse(Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' }));
                try { void Promise.resolve(dispose()).catch(() => {}); }
                catch { /* Cancellation has already withdrawn this invocation. */ }
            };
            const expire = () => {
                if (closed || !bound.isCurrent()) return;
                closed = true;
                try {
                    listener({ version: 1, subscriptionId: input.declaration.id,
                        kind: 'error', code: 'expired_resource', diagnostics: [] });
                } finally {
                    try { void Promise.resolve(dispose()).catch(() => {}); }
                    catch { /* The existing Resource event already withdrew this read authority. */ }
                }
            };
            try {
                if (!bound.isCurrent()) throw Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' });
                bound.options.signal.addEventListener('abort', onAbort, { once: true });
                const observed = Promise.resolve(bound.runtime.observe(() => {
                    if (!closed && bound.isCurrent()) listener({ kind: 'invalidated' });
                }, bound.options)).then(async next => {
                    if (!next || typeof next.dispose !== 'function') {
                        throw Object.assign(new Error('Resource observer is invalid'), { code: 'plugin_resource_observation_invalid', retryable: false });
                    }
                    observation = next;
                    if (closed || !bound.isCurrent()) {
                        await dispose();
                        throw Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' });
                    }
                });
                await awaitResourceOperation(observed, bound.options.signal);
                admit();
                if (attaching === admission) attaching = null;
                const baseline = await input.readBaseline(bound.options.signal);
                if (!bound.isCurrent()) throw Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' });
                // Read refusal does not retire the admitted observation. Wait
                // for a real producer change instead of reopening this watch.
                if (baseline.error?.retryable === false
                    && PluginCollectionReadErrorCodeV1Schema.safeParse(baseline.error.code).success) return { dispose };
                if (baseline.error || !baseline.value || !baseline.digest) {
                    throw Object.assign(new Error(baseline.error?.message ?? 'Resource baseline is unavailable'),
                        baseline.error ?? { code: 'plugin_resource_unavailable' });
                }
                return { dispose, admittedDigest: baseline.digest };
            } catch (error) {
                refuse(error);
                if (attaching === admission) attaching = null;
                try { await dispose(); } catch { /* Preserve the deciding attach/read failure. */ }
                throw error;
            }
        },
    });
}
