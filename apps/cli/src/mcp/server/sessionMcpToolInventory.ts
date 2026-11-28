import { isDeepStrictEqual } from 'node:util';
import { isSessionHappierToolsEnabled } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import type { ActionId } from '@happier-dev/protocol';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { resolveSessionDefaultWorkspaceAddress } from '@/agent/tools/happierTools/actionToolContext';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { getActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { createSessionActionSettingsView, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { createMcpActionEnablementWithServerFeatureAvailability } from './createMcpActionEnablement';
import { prepareHappierMcpToolInventory } from './registerHappierMcpBuiltInTools';
import { readCliFeatureBuildPolicyInputs } from '@/features/featureBuildPolicy';
import { readCliLocalFeaturePolicySnapshot } from '@/features/featureLocalPolicy';
import { resolveCliFeatureDecisionEnvironment } from '@/features/featureDecisionInputs';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { DaemonPluginToolCatalogUnavailableError } from '../pluginToolCatalogError';
import { DaemonPluginCatalogProjectionSchema, type DaemonPluginCatalogProjection } from '@/plugins/daemon/catalogProjection';
import { projectOccurrenceBoundExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

/** Retain the bridge's admitted inventory until its actual policy/catalog inputs change. */
export function createSessionMcpToolInventory(params: Readonly<{
    client: HappyMcpSessionClient;
    happierToolsEnabled?: boolean;
    actionSettingsProvider: RuntimeActionSettingsProvider;
    hasAuthenticatedRuntime: boolean;
    authorityScope?: 'account' | 'session';
    requiredDirectActionIds?: readonly ActionId[];
    readSessionToolsBootstrap?: () => boolean;
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
    /** Containing bridge lifetime, independent of replaceable native incarnations. */
    lifetimeSignal?: AbortSignal;
}>) {
    const env = resolveCliFeatureDecisionEnvironment();
    const surface = params.client.getRunActionInvocation?.()?.surface === 'voice' ? 'voice' : 'agent';
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
        lifetime = params.lifetimeSignal ?? params.client.getRuntimeLifetimeSignal?.();
        if (lifetime?.aborted) dispose();
        else lifetime?.addEventListener('abort', dispose, { once: true });
    };
    const canRetainCatalog = () => !disposed && Boolean(unsubscribe && params.client.getEphemeralStreamConnectionEpoch);
    const isCatalogCurrent = () => catalog?.projection !== undefined && canRetainCatalog()
        && catalog.signalReady && params.client.isDaemonPluginCatalogSignalReady?.() === true
        && catalog.connectionEpoch === params.client.getEphemeralStreamConnectionEpoch?.()
        && isDeepStrictEqual(catalog.projection, latestProjection);
    const awaitCatalogRead = (pending: Promise<void>, signal?: AbortSignal) => {
        if (!signal) return pending;
        return new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(
                () => { signal.removeEventListener('abort', abort); resolve(); },
                (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
            );
            if (signal.aborted) abort();
        });
    };
    const readPluginToolCatalog = async (signal?: AbortSignal): Promise<readonly ProjectedPluginToolCatalogEntry[]> => {
        signal?.throwIfAborted();
        if (resolveSessionApprovalProfileReferenceV1(params.client.getMetadataSnapshot?.() ?? {})) {
            await params.actionSettingsProvider.prepareApprovalProfiles?.(signal);
        }
        if (!(params.happierToolsEnabled ?? isSessionHappierToolsEnabled(params.client.getMetadataSnapshot?.()))) return [];
        if (params.pluginRuntimeRegistryLease) {
            return projectOccurrenceBoundExecutablePluginToolCatalog(params.pluginRuntimeRegistryLease.registry);
        }
        subscribe();
        while (!isCatalogCurrent()) {
            signal?.throwIfAborted();
            if (!readingCatalog) {
                const hintAtStart = latestProjection;
                const connectionEpoch = params.client.getEphemeralStreamConnectionEpoch?.();
                const signalReady = params.client.isDaemonPluginCatalogSignalReady?.() === true;
                // Catalog work is shared by concurrent RPC callers. Only the
                // containing lifetime can cancel its producer. A cancelled turn must not
                // retire discovery or another caller's shared catalog work;
                // each request's signal cancels that request's wait below.
                const producerSignal = params.lifetimeSignal ?? params.client.getRuntimeLifetimeSignal?.() ?? undefined;
                readingCatalog = (async () => {
                    const response = await readDaemonPluginCatalog({ selection: 'tools', ...(producerSignal ? { signal: producerSignal } : {}) }).catch(() => ({ kind: 'unavailable' as const }));
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
            await awaitCatalogRead(readingCatalog, signal);
            signal?.throwIfAborted();
            // Incumbent daemons without this signal contract retain the original
            // per-request freshness behavior. No guessed revision or TTL.
            if (!canRetainCatalog() || !catalog?.projection || !catalog.signalReady) break;
        }
        if (!catalog) throw new DaemonPluginToolCatalogUnavailableError();
        return catalog.tools;
    };
    const sessionActionSettings = createSessionActionSettingsView(params.actionSettingsProvider,
        () => params.client.getMetadataSnapshot?.(), surface);
    const readInputs = (pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[]) => {
        const location = params.client.getCurrentSessionLocation?.();
        const metadata = params.client.getMetadataSnapshot?.();
        const serverFeatures = params.client.getServerFeaturesSnapshot?.();
        const serverBinding = params.client.getServerBinding?.();
        const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot(serverFeatures) ?? null;
        const sessionWorkspace = resolveSessionDefaultWorkspaceAddress({
            serverId: serverBinding?.serverId ?? null,
            serverIdentityId,
            metadata,
            machineId: location?.machineId ?? null,
            rootPath: location?.path ?? null,
            workspaceRefs: getActiveProjectAccountRowsSnapshot()?.workspaceRefs,
        });
        return {
            actionsSettings: sessionActionSettings.getActionsSettings(),
            serverFeatures,
            sessionMemoryEnabled: surface === 'voice' ? undefined : readSessionMemoryEnabledV1(metadata),
            happierToolsEnabled: params.happierToolsEnabled ?? isSessionHappierToolsEnabled(metadata),
            sessionToolsBootstrap: params.readSessionToolsBootstrap?.(),
            sessionMachineId: location?.machineId ?? null,
            sessionRootPath: location?.path ?? null,
            sessionWorkspace,
            buildPolicy: readCliFeatureBuildPolicyInputs(env),
            localPolicy: readCliLocalFeaturePolicySnapshot(env),
            pluginToolCatalog,
        };
    };
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
                surface,
                hasAuthenticatedRuntime: params.hasAuthenticatedRuntime,
                authorityScope: params.authorityScope,
                sessionToolsBootstrap: inputs.sessionToolsBootstrap,
                readSessionMemoryEnabled: () => inputs.sessionMemoryEnabled,
                readServerFeaturesSnapshot: () => inputs.serverFeatures,
                env,
            });
            inventory = prepareHappierMcpToolInventory({
                sessionId: params.client.sessionId,
                sessionMachineId: inputs.sessionMachineId,
                sessionRootPath: inputs.sessionRootPath,
                sessionWorkspace: inputs.sessionWorkspace,
                inventory: createHappierToolInventory({
                    surface, isActionEnabled, actionsSettings: inputs.actionsSettings,
                    sessionToolsBootstrap: inputs.sessionToolsBootstrap,
                    happierToolsEnabled: inputs.happierToolsEnabled,
                    pluginToolCatalog, requiredDirectActionIds: params.requiredDirectActionIds,
                }),
            });
            previous = snapshot;
        }
        return inventory;
    };
    return Object.assign(readInventory, { readPluginToolCatalog, dispose });
}
