import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import { isPluginDeclarativeDataNodeV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginDeclarativeNodeV2 } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, readWidgetDefinitionResourcesV1, WidgetSurfaceReadV1Schema, type WidgetSurfaceReadV1 } from '@happier-dev/protocol/widgets';
import { readInputPath } from '@happier-dev/protocol/inputs';
import type { PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { selectWidgetPlacementsBySurface } from '@/sync/domains/plugins/ui/widgetContract';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { readCompletePluginUiResourceDeclarations } from '@/sync/domains/plugins/ui/projection';
import { acquirePluginContextualResourceStore, createPluginDeclaredResourceStore } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolveDeclarativeDataResourceBinding } from '@/components/plugins/surfaces/declarativeDataSource';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { readWidgetActionRuntimeV1, readWidgetSurfaceActionPortV1 } from './widgetCatalogActionDeps';
import type { LazyActionAccountContext } from './actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveMountedWidgetAreaLayoutSelectionOwner, type WidgetAreaLayoutSelectionOwner } from '@/sync/domains/widgets/widgetAreaLayoutSelection';
import { resolveCallerHostedHtmlResourceBindingV1 } from '@/components/ui/surfaces/hostedHtml/sessionCallerHostedHtmlRequestController';

const unavailable = (errorCode = 'widget_refresh_unavailable'): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Cancellation releases this await, not another mount's shared Resource read. */
async function refreshEntry(entry: PluginUiResourceEntry, signal?: AbortSignal): Promise<PluginUiResourceSnapshot> {
    signal?.throwIfAborted();
    // Start the requested observation before retaining demand, so the static
    // subscriber reuses that read rather than initiating a second baseline.
    const refresh = entry.refresh();
    const release = entry.subscribe(() => {}, false);
    try {
        if (!signal) return await refresh;
        return await new Promise((resolve, reject) => {
            const abort = () => { cleanup(); reject(Object.assign(new Error('Resource operation was aborted'), { code: 'plugin_resource_aborted' })); };
            const cleanup = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            refresh.then(snapshot => { cleanup(); resolve(snapshot); }, error => { cleanup(); reject(error); });
        });
    } finally { release(); }
}

/** Qualified instance, execution admission and declared Resources precede any refresh work. */
export function createWidgetRefreshActionDepsV1(account: LazyActionAccountContext | null | undefined, deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetRefresh'> {
    if (!account) return {};
    return { widgetRefresh: async ({ ref, context, signal }) => {
        account.assertCurrent();
        const owner = ref.surface.owner;
        let mountedOwner: WidgetAreaLayoutSelectionOwner | undefined;
        const isAreaCurrent = () => mountedOwner?.isCurrent() ?? true;
        // The admitted page port already supplies its captured context. Reverse
        // dispatch has none and must resolve the same current owner as selection.
        if ((owner.kind === 'project' || owner.kind === 'corePage' || owner.kind === 'pluginArea')
            && !sameStrictJsonValue(context.widgetAreaContext?.surface, ref.surface)) {
            const mounted = resolveMountedWidgetAreaLayoutSelectionOwner(ref.surface);
            if ('ok' in mounted) return mounted;
            context = { ...context, widgetAreaContext: { surface: ref.surface, values: mounted.providedContext } };
            mountedOwner = mounted;
        }
        if (!deps.widgetInputs || !account.accountLifetime) return unavailable();
        const port = readWidgetSurfaceActionPortV1(deps, ref.surface);
        if (!port) return unavailable();
        let state: WidgetSurfaceReadV1 | ActionExecuteFailure;
        if (mountedOwner) {
            // The captured read re-admits the page's declared context and host
            // port lifetime; a mounted address alone grants neither.
            const result = await mountedOwner.read(ref.surface, signal);
            if (!result.ok) return result;
            const parsed = WidgetSurfaceReadV1Schema.safeParse(result.result);
            if (!parsed.success || !sameStrictJsonValue(parsed.data.surface, ref.surface)) return unavailable('invalid_widget_area_result');
            state = parsed.data;
        } else state = await port.read(ref.surface, context, signal);
        if (!isAreaCurrent()) return unavailable('widget_area_scope_retired');
        if ('ok' in state) return state;
        const instance = state.instances.find(row => row.instance.id === ref.instanceId)?.instance;
        if (!instance) return unavailable('widget_instance_not_found');
        const definition = instance.definition;
        if (definition.kind === 'artifact' && ref.surface.accountId !== account.accountId) return unavailable('widget_definition_unavailable');
        const authored = definition.kind === 'inline' ? definition.definition
            : definition.kind === 'artifact' ? await deps.widgetDefinitionArtifacts?.get(definition.artifactId, signal) : null;
        account.assertCurrent();
        // Native bodies refresh through their own domains; this Action admits
        // declared plugin Resources only, including for saved native copies.
        if (definition.kind === 'builtin' || authored?.body.kind === 'builtin') return unavailable();
        if (definition.kind !== 'installed' && !authored) return unavailable();
        const resolved = await deps.widgetInputs.resolve({ ref, instance, context, admission: 'execution', ...(signal ? { signal } : {}) });
        account.assertCurrent();
        if (!isAreaCurrent()) return unavailable('widget_area_scope_retired');
        if (resolved.status !== 'ready') return unavailable(`widget_inputs_${resolved.status}`);
        const initial = await readWidgetActionRuntimeV1(ref.surface, account, signal, undefined, deps);
        const installedDefinition = definition.kind === 'installed' ? definition : authored?.body.kind === 'installed' ? authored.body : null;
        const matches = (candidate: NonNullable<ReturnType<typeof readWidgetDescriptor>>) => installedDefinition !== null
            && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), installedDefinition);
        const installedSeed = ('ok' in initial ? undefined : initial.candidates.find(matches))
            ?? (installedDefinition ? readWidgetDescriptor(readCurrentAppShellPluginUiProjection(), installedDefinition) : null);
        const seed = authored && (definition.kind === 'artifact' || definition.kind === 'inline')
            ? describeAuthoredWidgetDefinitionV1(authored, definition, installedSeed) : installedSeed;
        if (!seed) return unavailable();
        const parsedSession = seed.sessionInputPath ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(resolved.input, seed.sessionInputPath)) : null;
        if (parsedSession && (!parsedSession.success || !areServerProfileIdentifiersEquivalent(parsedSession.data.serverId, account.serverId))) return unavailable();
        if (seed.target === 'session' && !parsedSession?.success) return unavailable();
        const selectedRuntime = parsedSession?.success ? await readWidgetActionRuntimeV1(ref.surface, account, signal, parsedSession.data, deps) : initial;
        if (!isAreaCurrent()) return unavailable('widget_area_scope_retired');
        if ('ok' in selectedRuntime) return selectedRuntime;
        const runtime = { ...selectedRuntime, isCurrent: () => isAreaCurrent() && selectedRuntime.isCurrent() };
        if (definition.kind === 'artifact') {
            const current = await deps.widgetDefinitionArtifacts?.get(definition.artifactId, signal);
            account.assertCurrent();
            if (!current || !sameStrictJsonValue(current, authored)) return unavailable('widget_definition_changed');
        }
        if (authored?.body.kind === 'html') {
            const declarations = readWidgetDefinitionResourcesV1(authored);
            if (!declarations.length || !runtime.projection || !runtime.isCurrent()) return unavailable();
            const target = { machineId: runtime.machineId, serverId: runtime.machineId ? account.serverId : null,
                projection: runtime.projection, isCurrent: runtime.isCurrent };
            const resources = declarations.map(reference => ({ reference, binding: resolveCallerHostedHtmlResourceBindingV1({
                target, reference, serverId: account.serverId, sessionId: parsedSession?.success ? parsedSession.data.sessionId : undefined,
                launchInput: resolved.input,
            }) }));
            // Refresh has no physical mount identity; surface-only reads remain
            // unavailable, just as they do for declarative Resource refresh.
            if (resources.some(row => !row.binding)) return unavailable();
            const leases = resources.map(row => acquirePluginContextualResourceStore({ ...row.binding!,
                pluginId: row.reference.pluginId, accountLifetime: account.accountLifetime! }));
            try {
                if (leases.some(lease => !lease)) return unavailable();
                const results = await Promise.all(resources.map((row, index) => refreshEntry(leases[index]!.store.getEntry(row.reference), signal)));
                account.assertCurrent();
                if (!runtime.isCurrent()) return unavailable();
                const failed = results.find(snapshot => snapshot.error || !snapshot.value);
                return failed ? unavailable(failed.error?.code ?? 'plugin_resource_unavailable')
                    : { ok: true, result: { ref, status: 'refreshed' } };
            } finally { for (const lease of leases) lease?.dispose(); }
        }
        if (authored?.body.kind === 'declarative') {
            const nodes: PluginDeclarativeNodeV2[] = [authored.body.document.root];
            const resources = [];
            while (nodes.length) {
                const node = nodes.pop()!;
                if (isPluginDeclarativeDataNodeV1(node) && node.data.kind === 'resource') {
                    const binding = resolveDeclarativeDataResourceBinding({ projection: runtime.projection, input: resolved.input,
                        machineId: runtime.machineId, serverId: account.serverId, accountLifetime: account.accountLifetime,
                        ...(parsedSession?.success ? { sessionId: parsedSession.data.sessionId } : {}), isCurrent: runtime.isCurrent,
                        requireReadAuthority: true }, node);
                    if (!binding) return unavailable();
                    resources.push({ binding, resource: node.data.resource });
                }
                if ('children' in node) nodes.push(...node.children);
            }
            if (!resources.length) return unavailable();
            // Admit every exact declaration before issuing reads. A surface-only
            // source has no Action mount identity and therefore fails closed above.
            const leases = resources.map(row => acquirePluginContextualResourceStore(row.binding));
            try {
                if (leases.some(lease => !lease)) return unavailable();
                const entries = resources.map((row, index) => leases[index]!.store.getEntry(row.resource));
                const results = await Promise.all(entries.map(entry => refreshEntry(entry, signal)));
                account.assertCurrent();
                if (!runtime.isCurrent()) return unavailable();
                const failed = results.find(snapshot => snapshot.error || !snapshot.value);
                return failed ? unavailable(failed.error?.code ?? 'plugin_resource_unavailable')
                    : { ok: true, result: { ref, status: 'refreshed' } };
            } finally { for (const lease of leases) lease?.dispose(); }
        }
        const candidate = runtime.candidates.find(matches);
        if (!candidate?.resources?.length || candidate.sessionInputPath !== seed.sessionInputPath || !runtime.projection || !runtime.isCurrent()) return unavailable();
        if (!installedDefinition) return unavailable();
        const placement = selectWidgetPlacementsBySurface(runtime.projection, installedDefinition.surface);
        if (placement.length !== 1) return unavailable();
        const origin = readPluginUiContributionOrigin(placement[0]);
        const machineId = runtime.machineId ?? (origin?.phase === 'current' && origin.interactionEnabled ? origin.machineId : null);
        if (!machineId || (origin?.serverId && !areServerProfileIdentifiersEquivalent(origin.serverId, account.serverId))) return unavailable();
        const occurrenceId = placement[0].occurrenceId;
        if (typeof occurrenceId !== 'string' || !occurrenceId) return unavailable();
        const resourcesById = readCompletePluginUiResourceDeclarations(runtime.projection, installedDefinition.surface.pluginId, occurrenceId);
        if (resourcesById === undefined) return unavailable();
        const store = createPluginDeclaredResourceStore({ accountLifetime: account.accountLifetime,
            pluginId: installedDefinition.surface.pluginId, machineId, serverId: account.serverId,
            expectedCallerOccurrenceId: occurrenceId, resourcesById, resourceDeclarationsComplete: true,
            ...(parsedSession?.success ? { sessionId: parsedSession.data.sessionId } : {}) });
        if (!store) return unavailable();
        try {
            // Resolve every declaration/context before issuing any read. Surface
            // provenance cannot be invented from an instance ref or physical host.
            const entries = candidate.resources.map(resource => store.getEntry(resource));
            const results = await Promise.all(entries.map(entry => refreshEntry(entry, signal)));
            account.assertCurrent();
            if (!runtime.isCurrent()) return unavailable();
            const failed = results.find(snapshot => snapshot.error || !snapshot.value);
            return failed ? unavailable(failed.error?.code ?? 'plugin_resource_unavailable')
                : { ok: true, result: { ref, status: 'refreshed' } };
        } catch (error) {
            account.assertCurrent();
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
            return unavailable(code === 'plugin_resource_context_unavailable' ? undefined : code);
        } finally { store.dispose(); }
    } };
}
