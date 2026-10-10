import type {
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSource,
} from '../../../projection/registry/types';
import { derivePluginDaemonContributionRegistrationRights, PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';

export type PluginContributionActivationDemand = Readonly<{
    pluginId: string;
    family: string;
    localId: string;
}>;

/**
 * Registration families whose host consumer owns a positive asynchronous
 * demand boundary, so a plugin contributing only these stays dormant through
 * daemon cold start. Every entry names a consumer that calls
 * `activateContributionsOnDemand` for the exact contribution before it reads
 * the live registration; adding a family without that boundary silently
 * deletes registrations the consumer still reads synchronously.
 *
 * Everything else is deliberately eager: `backgroundServices` is a declared
 * machine-runtime service, and `resources`, `events`, `promptAssets` and
 * `composerReferences` are still read synchronously by their hosts.
 */
const PRODUCT_DEMAND_READY_REGISTRATION_FAMILIES = new Set([
    'actions',
    'hooks',
    'mcp.servers',
    'mcp.discoverySources',
    'scmBackends',
    'scmHostingProviders',
    'requestInterceptors',
    'notificationChannels',
    'connectedAccountDescriptors',
    'agents',
    'providers',
    'voiceProviders',
    // Reached only when a composer stages that exact attachment, through
    // `createTargetComposerAttachmentRegistry`'s own demand boundary.
    'composerAttachments',
    // Project inspection and native launch resolve the selected identity via
    // resolveProjectNativeAdapter before reading its registration.
    'projectNativeAdapters',
    // Managed operations demand the selected descriptor; its existing Action
    // registrations supply all native roles without a provisioner runtime API.
    'machineProvisioners',
]);

/**
 * Activation targets: the deduplicated set of (plugin, daemon entry) pairs
 * derived from a resolved contribution registry, plus the helpers used to
 * collect them and decide when they should activate.
 */

export type ActivationTarget = import('../../../projection/registry/types').ResolvedActivationTarget;

export function addActivationTarget(targets: Map<string, ActivationTarget>, raw: Readonly<{
    provenance?: ResolvedContributionProvenance;
    source?: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: ActivationTarget['sourceSpec'];
    activationEvents?: readonly string[];
    manifest?: ActivationTarget['manifest'];
}>): void {
    if (!raw.pluginId || !raw.manifestPath
        || (!raw.daemonEntryPath && !raw.devDaemonEntryPath) || !raw.sourceSpec || !raw.manifest) {
        return;
    }
    const key = `${raw.pluginId}::${raw.daemonEntryPath ?? raw.devDaemonEntryPath}`;
    if (targets.has(key)) {
        return;
    }
    targets.set(key, {
        provenance: raw.provenance ?? 'external',
        source: raw.source ?? { kind: raw.sourceSpec?.kind ?? 'path' },
        pluginId: raw.pluginId,
        manifestPath: raw.manifestPath,
        daemonEntryPath: raw.daemonEntryPath ?? null,
        devDaemonEntryPath: raw.devDaemonEntryPath ?? null,
        sourceSpec: raw.sourceSpec,
        manifest: raw.manifest,
        ...(raw.activationEvents ? { activationEvents: raw.activationEvents } : {}),
    });
}

export function collectActivationTargets(contributes: ResolvedContributionRegistry): readonly ActivationTarget[] {
    const targets = new Map<string, ActivationTarget>();
    for (const target of contributes.activationTargets) {
        addActivationTarget(targets, target);
    }
    for (const agent of contributes.agents) {
        addActivationTarget(targets, agent);
    }
    for (const action of contributes.actions) {
        addActivationTarget(targets, action);
    }
    for (const tool of contributes.tools ?? []) {
        addActivationTarget(targets, tool);
    }
    for (const command of contributes.commands ?? []) {
        addActivationTarget(targets, command);
    }
    return Object.freeze([...targets.values()]);
}

export function shouldActivateTargetAtStartup(target: ActivationTarget): boolean {
    if (target.activationEvents?.includes('startup')) return true;
    const registrationRights = derivePluginDaemonContributionRegistrationRights(
        target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    );
    if (registrationRights.length === 0) return false;

    // Families stay on compatibility-eager activation until their real
    // consumer owns a positive asynchronous demand boundary. This prevents a
    // nominally "lazy" cutover from silently deleting registrations that are
    // still read synchronously today.
    return registrationRights.some((right) => (
        !PRODUCT_DEMAND_READY_REGISTRATION_FAMILIES.has(right.family)
    ));
}

export function activationTargetMatchesContributionDemand(
    target: ActivationTarget,
    demand: PluginContributionActivationDemand,
): boolean {
    if (demand.pluginId !== target.pluginId) return false;
    const rights = derivePluginDaemonContributionRegistrationRights(
        target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    );
    if (demand.family === 'machineProvisioners') {
        const descriptor = target.manifest.contributes.machineProvisioners?.find((entry) => entry.id === demand.localId);
        if (!descriptor) return false;
        const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === demand.family);
        const references = family?.extractReferences(descriptor).filter((reference) => reference.targetFamily === 'actions') ?? [];
        return references.length > 0 && references.every(({ reference }) => (
            typeof reference === 'string'
            && rights.some((right) => right.family === 'actions' && right.localId === reference)
        ));
    }
    return rights.some((right) => right.family === demand.family && right.localId === demand.localId);
}
