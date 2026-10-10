import { isDeepStrictEqual } from 'node:util';
import type { ActionId } from '@happier-dev/protocol';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createMcpActionEnablementWithServerFeatureAvailability } from './createMcpActionEnablement';
import { prepareHappierMcpToolInventory } from './registerHappierMcpBuiltInTools';
import { readCliFeatureBuildPolicyInputs } from '@/features/featureBuildPolicy';
import { readCliLocalFeaturePolicySnapshot } from '@/features/featureLocalPolicy';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { DaemonPluginToolCatalogUnavailableError } from '../pluginToolCatalogError';
import { DaemonPluginCatalogProjectionSchema, type DaemonPluginCatalogProjection } from '@/plugins/daemon/catalogProjection';
import { projectOccurrenceBoundExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

/** Retain the bridge's admitted inventory until its actual policy/catalog inputs change. */
export function createSessionMcpToolInventory(params: Readonly<{
    client: HappyMcpSessionClient;
    actionSettingsProvider: RuntimeActionSettingsProvider;
    hasAuthenticatedRuntime: boolean;
    authorityScope?: 'account' | 'session';
    requiredDirectActionIds?: readonly ActionId[];
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
}>) {
    let latestProjection: DaemonPluginCatalogProjection | undefined;
    let catalog: Readonly<{ tools: readonly ProjectedPluginToolCatalogEntry[];
        projection: DaemonPluginCatalogProjection | undefined; connectionEpoch: number | undefined; signalReady: boolean }> | undefined;
    let readingCatalog: Promise<void> | undefined;
    let unsubscribe: (() => void) | undefined;
    let lifetime: AbortSignal | null | undefined;
    let disposed = false;
    const dispose = () => {
        disposed = true;
        unsubscribe?.();
        lifetime?.removeEventListener('abort', dispose);
    };
    const subscribe = () => {
        if (unsubscribe || disposed) return;
        unsubscribe = params.client.subscribeDaemonPluginCatalogChanges?.(projection => {
            if (latestProjection?.runtimeId === projection.runtimeId
                && latestProjection.contributionRegistryProjectionRevision >= projection.contributionRegistryProjectionRevision) return;
            latestProjection = projection;
        });
        // Native handlers are registered before their runtime exists. Bind its
        // existing lifetime at first use, not during that earlier registration.
        lifetime = params.client.getRuntimeLifetimeSignal?.();
        if (lifetime?.aborted) dispose();
        else lifetime?.addEventListener('abort', dispose, { once: true });
    };
    const canRetainCatalog = () => !disposed && Boolean(unsubscribe && params.client.getEphemeralStreamConnectionEpoch);
    const isCatalogCurrent = () => catalog?.projection !== undefined && canRetainCatalog()
        && catalog.signalReady && params.client.isDaemonPluginCatalogSignalReady?.() === true
        && catalog.connectionEpoch === params.client.getEphemeralStreamConnectionEpoch?.()
        && isDeepStrictEqual(catalog.projection, latestProjection);
    const readPluginToolCatalog = async (): Promise<readonly ProjectedPluginToolCatalogEntry[]> => {
        if (params.pluginRuntimeRegistryLease) {
            return projectOccurrenceBoundExecutablePluginToolCatalog(params.pluginRuntimeRegistryLease.registry);
        }
        subscribe();
        while (!isCatalogCurrent()) {
            if (!readingCatalog) {
                const hintAtStart = latestProjection;
                const connectionEpoch = params.client.getEphemeralStreamConnectionEpoch?.();
                const signalReady = params.client.isDaemonPluginCatalogSignalReady?.() === true;
                readingCatalog = (async () => {
                    const response = await readDaemonPluginCatalog().catch(() => ({ kind: 'unavailable' as const }));
                    if (response.kind !== 'available') throw new DaemonPluginToolCatalogUnavailableError();
                    const parsed = DaemonPluginCatalogProjectionSchema.safeParse(response.projection);
                    const projection = parsed.success ? parsed.data : undefined;
                    catalog = { tools: response.tools, projection, connectionEpoch, signalReady };
                    // A read supersedes a hint observed before it, not one that
                    // arrived while it was pending. The latter needs a fresh read.
                    if (latestProjection === hintAtStart || projection?.runtimeId === latestProjection?.runtimeId
                        && projection !== undefined && latestProjection !== undefined
                        && projection.contributionRegistryProjectionRevision >= latestProjection.contributionRegistryProjectionRevision) {
                        latestProjection = projection;
                    }
                })().finally(() => { readingCatalog = undefined; });
            }
            await readingCatalog;
            // Incumbent daemons without this signal contract retain the original
            // per-request freshness behavior. No guessed revision or TTL.
            if (!canRetainCatalog() || !catalog?.projection || !catalog.signalReady) break;
        }
        if (!catalog) throw new DaemonPluginToolCatalogUnavailableError();
        return catalog.tools;
    };
    const readInputs = (pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[]) => ({
        actionsSettings: params.actionSettingsProvider.getActionsSettings(),
        serverFeatures: params.client.getServerFeaturesSnapshot?.(),
        sessionMemoryEnabled: readSessionMemoryEnabledV1(params.client.getMetadataSnapshot?.()),
        sessionMachineId: params.client.getCurrentSessionLocation?.()?.machineId ?? null,
        buildPolicy: readCliFeatureBuildPolicyInputs(process.env),
        localPolicy: readCliLocalFeaturePolicySnapshot(process.env),
        pluginToolCatalog,
    });
    let previous: ReturnType<typeof readInputs> | undefined;
    let inventory: ReturnType<typeof prepareHappierMcpToolInventory> | undefined;
    const readInventory = (pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[]) => {
        const inputs = readInputs(pluginToolCatalog);
        // Daemon transport and scoped policy readers can return new objects for
        // the same snapshot. Compare their actual facts, including occurrence
        // fences; object identity alone would rebuild on every request.
        if (!inventory || !isDeepStrictEqual(previous, inputs)) {
            const snapshot = structuredClone(inputs);
            const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
                actionSettingsProvider: { getActionsSettings: () => inputs.actionsSettings },
                surface: 'agent',
                hasAuthenticatedRuntime: params.hasAuthenticatedRuntime,
                authorityScope: params.authorityScope,
                readSessionMemoryEnabled: () => inputs.sessionMemoryEnabled,
                readServerFeaturesSnapshot: () => inputs.serverFeatures,
            });
            inventory = prepareHappierMcpToolInventory({
                sessionId: params.client.sessionId,
                sessionMachineId: inputs.sessionMachineId,
                pluginToolCatalog,
                inventory: createHappierToolInventory({
                    surface: 'agent', isActionEnabled, actionsSettings: inputs.actionsSettings,
                    pluginToolCatalog, requiredDirectActionIds: params.requiredDirectActionIds,
                }),
            });
            previous = snapshot;
        }
        return inventory;
    };
    return Object.assign(readInventory, { readPluginToolCatalog, dispose });
}
