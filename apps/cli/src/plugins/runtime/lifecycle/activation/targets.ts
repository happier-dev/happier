import type {
    ResolvedActivationTarget,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSource,
} from '../../../projection/registry/types';
import { derivePluginAccountContributionRegistrationRights, derivePluginAccountExecutionArtifactSlots, derivePluginDaemonContributionRegistrationRights, PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';

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
 * Continuous background services and Event subscriptions remain eager unless
 * their declaration selects the host's configuration-demand boundary. Finite
 * services activate only through the canonical background-service demand boundary.
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
    // Capture registration resolves and demands the exact declared source.
    'captureSources',
    'secretSources',
    // Resource binding and plugin invocation prepare the exact registered
    // producer before exposing its synchronous descriptor/watch services.
    'resources',
    // Inventory is declarative; search/resolve demand the selected runtime.
    'composerReferences',
    // Reached only when a composer stages that exact attachment, through
    // `createTargetComposerAttachmentRegistry`'s own demand boundary.
    'composerAttachments',
    // Project inspection and native launch resolve the selected identity via
    // resolveProjectNativeAdapter before reading its registration.
    'projectNativeAdapters',
    // Managed operations demand the selected descriptor; its existing Action
    // registrations supply all native roles without a provisioner runtime API.
    'machineProvisioners',
    // Managed database attachment demands the exact linked data-role runtime.
    'deploymentTargets',
]);

/**
 * Activation targets: the deduplicated set of (plugin, daemon entry) pairs
 * derived from a resolved contribution registry, plus the helpers used to
 * collect them and decide when they should activate.
 */

export type ActivationTarget = ResolvedActivationTarget & Readonly<{
    /** Static declaration rights admitted with this exact daemon/Account artifact target. */
    registrationRights: ReturnType<typeof deriveActivationTargetRegistrationRights>;
    /**
     * Background services listed by this plugin's `machineRoles` entries whose role is off on this
     * Machine (from the admission fact `inactiveMachineRoleIds`). They never start, and they are no
     * reason to activate the target automatically; Actions and other demanded work still activate it.
     */
    inactiveRoleBackgroundServiceIds: ReadonlySet<string>;
}>;

function readInactiveRoleBackgroundServiceIds(
    target: Pick<ResolvedActivationTarget, 'pluginId' | 'manifest'>,
    inactiveMachineRoleIds: readonly string[] | undefined,
): ReadonlySet<string> {
    if (!inactiveMachineRoleIds?.length) return EMPTY_SERVICE_IDS;
    const inactive = new Set(inactiveMachineRoleIds);
    return new Set((target.manifest.contributes.machineRoles ?? [])
        .filter(role => inactive.has(`${target.pluginId}/${role.id}`))
        .flatMap(role => role.backgroundServices ?? []));
}
const EMPTY_SERVICE_IDS: ReadonlySet<string> = new Set();

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
    account?: ActivationTarget['account'];
    pluginRootPath?: string;
}>, inactiveMachineRoleIds?: readonly string[]): void {
    if (!raw.pluginId || !raw.manifestPath
        || (!raw.daemonEntryPath && !raw.devDaemonEntryPath && !raw.account) || !raw.sourceSpec || !raw.manifest) {
        return;
    }
    const key = raw.account
        ? `${raw.pluginId}::account::${raw.account.artifactId}::${raw.account.exportName}`
        : `${raw.pluginId}::${raw.daemonEntryPath ?? raw.devDaemonEntryPath}`;
    if (targets.has(key)) {
        return;
    }
    const target: ResolvedActivationTarget = {
        provenance: raw.provenance ?? 'external',
        source: raw.source ?? { kind: raw.sourceSpec?.kind ?? 'path' },
        pluginId: raw.pluginId,
        manifestPath: raw.manifestPath,
        daemonEntryPath: raw.daemonEntryPath ?? null,
        devDaemonEntryPath: raw.devDaemonEntryPath ?? null,
        sourceSpec: raw.sourceSpec,
        manifest: raw.manifest,
        ...(raw.account ? { account: raw.account } : {}),
        ...(raw.pluginRootPath ? { pluginRootPath: raw.pluginRootPath } : {}),
        ...(raw.activationEvents ? { activationEvents: raw.activationEvents } : {}),
    };
    targets.set(key, projectActivationTarget(target, inactiveMachineRoleIds));
}

/** The one projection from a resolved target to its admitted activation facts. */
export function projectActivationTarget(
    target: ResolvedActivationTarget,
    inactiveMachineRoleIds?: readonly string[],
): ActivationTarget {
    return Object.freeze({
        ...target,
        registrationRights: deriveActivationTargetRegistrationRights(target),
        inactiveRoleBackgroundServiceIds: readInactiveRoleBackgroundServiceIds(target, inactiveMachineRoleIds),
    });
}

export function collectActivationTargets(contributes: ResolvedContributionRegistry, realm?: 'account'): readonly ActivationTarget[] {
    const targets = new Map<string, ActivationTarget>();
    if (realm === 'account') {
        for (const declaration of contributes.pluginDeclarations ?? []) {
            for (const slot of derivePluginAccountExecutionArtifactSlots(declaration.manifest.contributes)) {
                const { realm: _realm, ...account } = slot.registrationRight.target;
                addActivationTarget(targets, { ...declaration,
                    provenance: declaration.sourceSpec.kind === 'bundled' ? 'first_party' : 'external',
                    source: { kind: declaration.sourceSpec.kind },
                    daemonEntryPath: null, devDaemonEntryPath: null, account,
                });
            }
        }
        return Object.freeze([...targets.values()]);
    }
    const roles = (pluginId: string | undefined) => pluginId ? contributes.pluginEnablementById?.[pluginId]?.inactiveMachineRoleIds : undefined;
    for (const target of contributes.activationTargets) {
        addActivationTarget(targets, target, roles(target.pluginId));
    }
    for (const agent of contributes.agents) {
        addActivationTarget(targets, agent, roles(agent.pluginId));
    }
    for (const action of contributes.actions) {
        addActivationTarget(targets, action, roles(action.pluginId));
    }
    return Object.freeze([...targets.values()]);
}

export function shouldActivateTargetAtStartup(target: ActivationTarget): boolean {
    if (target.account) return false;
    if (target.activationEvents?.includes('startup')) return true;
    // The canonical configuration consumer checks admitted Account presence
    // and subscribes to its existing push owner before demanding this target.
    if (target.manifest.activation?.configuration) return false;
    const inactiveServices = target.inactiveRoleBackgroundServiceIds;
    const registrationRights = target.registrationRights;
    if (registrationRights.length === 0) return false;

    // Families stay on compatibility-eager activation until their real
    // consumer owns a positive asynchronous demand boundary. This prevents a
    // nominally "lazy" cutover from silently deleting registrations that are
    // still read synchronously today.
    return registrationRights.some((right) => (
        right.family === 'backgroundServices'
            ? target.manifest.contributes.backgroundServices.some((service) => service.id === right.localId && service.activation !== 'demand'
                && !inactiveServices.has(service.id))
            : !PRODUCT_DEMAND_READY_REGISTRATION_FAMILIES.has(right.family)
    ));
}

/**
 * Machine roles (P03-MACHINE-ROLES §4.2): a target whose automatic activation exists only for
 * background services of roles that are off is not activated automatically (startup, reload of a
 * changed plugin, configuration demand). Demanded work (Actions, notifications) still activates it.
 */
export function isAutomaticActivationSuppressedByMachineRoles(target: ActivationTarget): boolean {
    const inactive = target.inactiveRoleBackgroundServiceIds;
    if (inactive.size === 0) return false;
    if (!target.manifest.activation?.configuration) return !shouldActivateTargetAtStartup(target);
    const services = target.manifest.contributes.backgroundServices;
    return services.length > 0 && services.every(service => inactive.has(service.id));
}

export function deriveActivationTargetRegistrationRights(target: Pick<ResolvedActivationTarget, 'manifest' | 'account'>) {
    return target.account
        ? derivePluginAccountContributionRegistrationRights(target.manifest.contributes, target.account)
        : derivePluginDaemonContributionRegistrationRights(target.manifest.contributes);
}

export function activationTargetMatchesContributionDemand(
    target: ActivationTarget,
    demand: PluginContributionActivationDemand,
): boolean {
    if (demand.pluginId !== target.pluginId) return false;
    const rights = target.registrationRights;
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
