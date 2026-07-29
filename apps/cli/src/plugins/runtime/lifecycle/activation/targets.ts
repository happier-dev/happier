import type {
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSource,
} from '../../../projection/registry/types';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';

export type PluginContributionActivationDemand = Readonly<{
    pluginId: string;
    family: string;
    localId: string;
}>;

const PRODUCT_DEMAND_READY_REGISTRATION_FAMILIES = new Set([
    'actions',
    'hooks',
    'mcp.servers',
    'mcp.discoveryProviders',
    'scmBackends',
    'scmHostingProviders',
    'requestInterceptors',
    'notificationChannels',
    'connectedAccountDescriptors',
    'agents',
    'voiceProviders.speech',
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
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: ActivationTarget['sourceSpec'];
    activationEvents?: readonly string[];
    manifest?: ActivationTarget['manifest'];
}>): void {
    if (!raw.pluginId || !raw.manifestPath || !raw.manifestDigest
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
        manifestDigest: raw.manifestDigest,
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
    return derivePluginDaemonContributionRegistrationRights(
        target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    ).some((right) => right.family === demand.family && right.localId === demand.localId);
}
