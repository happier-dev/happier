import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { SessionModelRefV2 } from '@happier-dev/protocol/providers/selection/v2';
import type { SavedSecretSlotBindingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';
import { resolveSavedSecretSlotBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { t } from '@/text';
import type { DaemonProviderModelProjectionGroupV1 } from '@happier-dev/protocol/rpc';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';

export type RouteSelection = ProviderBoundModelRef | SessionModelRefV2 | null;
export type ProviderRouteSource = Readonly<{
    connectionId: string; providerName: string; connectionName: string;
    connectionRole: 'default' | 'named'; connectionDisplayNameMode: 'automatic' | 'custom';
    suppressedConnectedServiceIds?: readonly string[];
}> & Partial<Pick<DaemonProviderModelProjectionGroupV1, 'authorization' | 'rows'>>;
export type SessionRoute = Readonly<
    { kind: 'unknown' } |
    { kind: 'native'; sourceLabel: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown'; connectedCount: number; modelId: string | null } |
    { kind: 'provider'; connectionId: string; sourceLabel: string | null; modelId: string; unavailable: boolean } |
    { kind: 'team'; teamId: string; resourceId: string; deliveryMode: TeamCredentialRouteV1; sourceLabel: string | null; modelId: string }
>;
export type SessionRoutePresentationInput = Readonly<{
    phase: 'draft' | 'running'; selection: RouteSelection;
    appliedSelection?: RouteSelection; transitionPending?: boolean;
    /** Presentation-only evidence from the canonical model disposition; never live runtime authority. */
    reportedSelection?: RouteSelection;
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown'; connectedCount: number }>;
    /** Runtime binding display snapshot, not a recomputed proposed connection. */
    appliedProviderSource?: ProviderRouteSource | null;
    sources?: readonly ProviderRouteSource[];
    teamSources?: readonly Readonly<{ teamId: string; resourceId: string; displayName: string }>[];
}>;

/** Discloses only credential use for the resolved route, without returning its private SavedSecret reference. */
export function projectProviderRouteSignInPurposes(input: Readonly<{
    route: SessionRoute;
    machineId: string;
    secretBindings?: SavedSecretSlotBindingsV1;
    /** Null means the source declares no runtime credential, even if a retired binding remains. */
    credentialSlotId?: string | null;
    /** Already resolved, locally materialized managed-purpose names. */
    managedSignInPurposes?: readonly string[];
}>): readonly string[] {
    if (input.route.kind !== 'provider' || !input.route.sourceLabel || !input.machineId) return [];
    if (input.managedSignInPurposes) return input.managedSignInPurposes;
    if (input.credentialSlotId === null) return [];
    return resolveSavedSecretSlotBindingIdV1(input.secretBindings, input.machineId, input.credentialSlotId ?? 'apiKey')
        ? [input.route.sourceLabel] : [];
}

/** Safe selected connection facts from the same admitted target descriptor that launch consumes. */
export function readProviderConnectionDisclosureSource(input: Readonly<{
    connection: ProviderConnectionV1;
    projection: PluginProjectionV2 | null | undefined;
    machineId: string;
    resolveServiceTitle: (service: PluginContributionIdentityV1) => string;
}>): Readonly<{ source: ProviderRouteSource; credentialSlotId: string | null; managedSignInPurposes?: readonly string[] }> {
    const connection = input.connection;
    const projected = connection.source.kind === 'contribution'
        ? input.projection?.familiesById.providers?.entriesById[connection.source.contributionKey] : null;
    const parsed = ProviderContributionV1Schema.safeParse(projected?.definition);
    const definition = parsed.success ? parsed.data : null;
    const credential = connection.source.kind === 'custom' ? connection.source.template.credential : definition?.credential;
    const source = { connectionId: connection.id,
        providerName: connection.source.kind === 'custom' ? connection.source.template.name : definition?.name ?? connection.displayName,
        connectionName: connection.displayName, connectionRole: connection.role, connectionDisplayNameMode: connection.displayNameMode };
    if (connection.deployment.kind !== 'managedLocal') return { source,
        credentialSlotId: credential?.transports.some(transport => transport.uses.includes('runtime')) ? credential.slotId : null };
    const local = !connection.gatewayPlacement || connection.gatewayPlacement.kind === 'sessionMachine'
        || connection.gatewayPlacement.machineId === input.machineId;
    const managedSignInPurposes = local ? (definition?.connectedAccounts ?? []).flatMap(declaration => {
        const target = connection.purposeBindingDefaults?.[declaration.purpose];
        if (!target) return [];
        const service = target.kind === 'account' ? target.account.service : target.service;
        return [input.resolveServiceTitle(service)];
    }) : [];
    return { source, credentialSlotId: null, managedSignInPurposes: [...new Set(managedSignInPurposes)] };
}

export function providerConnectionSourceLabel(source: Omit<ProviderRouteSource, 'connectionId'>): string {
    return presentProviderConnectionIdentity({ providerName: source.providerName, displayName: source.connectionName,
        role: source.connectionRole, displayNameMode: source.connectionDisplayNameMode }).sourceLabel;
}
/**
 * The model picker's heading for the Agent's own models: the account or pool it signs in with.
 * Null while it uses only its own sign-in (or that is unknown), where the picker keeps "Built-in".
 */
export function presentNativeRouteSourceLabel(
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown' }>,
): string | null {
    return native.authSource === 'connected' || native.authSource === 'mixed' ? native.label : null;
}

function routeSourceLabel(route: SessionRoute, nativeLabel: string): string | null {
    switch (route.kind) {
        case 'unknown': return null;
        case 'native': return nativeLabel;
        case 'provider': return route.sourceLabel;
        case 'team': return route.sourceLabel ?? t('teams.credentials.title');
    }
}

/** Whether two routes go through the same source: the Agent's own account, one connection or one Team resource. */
function isSameRouteSource(left: SessionRoute, right: SessionRoute): boolean {
    switch (left.kind) {
        case 'unknown': return false;
        case 'native': return right.kind === 'native';
        case 'provider': return right.kind === 'provider' && right.connectionId === left.connectionId;
        case 'team': return right.kind === 'team' && right.teamId === left.teamId && right.resourceId === left.resourceId;
    }
}

/** The applied route, or while it is unreadable the last reported one; never a guess from the selection. */
function readRunningRoute(presentation: Readonly<{ applied: SessionRoute; reported?: SessionRoute }>): SessionRoute {
    return presentation.applied.kind === 'unknown' ? presentation.reported ?? presentation.applied : presentation.applied;
}

/**
 * Whether the armed change keeps the source the session already runs through and changes only its
 * model (D15). The composer then names that model, not the unchanged source.
 */
export function isArmedModelOnlySessionChange(
    presentation: Readonly<{ applied: SessionRoute; pending: SessionRoute | null; reported?: SessionRoute }>,
): boolean {
    return presentation.pending !== null && isSameRouteSource(readRunningRoute(presentation), presentation.pending);
}

/**
 * The source a running session continues through once the next message is sent (D15): a route
 * picked while it runs is armed for that message, like an Agent switch. Null when nothing is armed,
 * when the armed source cannot be named, or when only the model changes within the source that
 * already runs — the route does not switch, so naming it as "next" would claim a change that isn't.
 */
export function presentArmedSessionRouteSource(
    presentation: Readonly<{ applied: SessionRoute; pending: SessionRoute | null; reported?: SessionRoute }>,
    native: Readonly<{ label: string }>,
): string | null {
    if (!presentation.pending || isArmedModelOnlySessionChange(presentation)) return null;
    return routeSourceLabel(presentation.pending, native.label);
}

/**
 * The composer chip's words for a route (D6). The native case keeps the incumbent account label,
 * which follows the user's account choice as they make it. An armed change is named as what comes
 * next ("Next via …") — a choice already made, not something that needs attention. A missing runner
 * observation retains coherent last-reported route presentation, without granting it live authority.
 * Without either evidence or an armed source it returns `null` and the caller keeps its incumbent label.
 */
export function presentSessionRouteChip(
    presentation: Readonly<{ applied: SessionRoute; pending: SessionRoute | null; reported?: SessionRoute }>,
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown' }>,
): Readonly<{ label: string }> | null {
    const route = presentSessionRouteSource(presentation, native);
    if (route === null) return null;
    return {
        label: route.kind === 'armed' ? t('connectedServices.authChip.nextVia', { source: route.source })
            : route.kind === 'own_sign_in' ? t('connectedServices.authChip.runsThroughOwnSignIn')
                : t('connectedServices.authChip.runsThrough', { source: route.source }),
    };
}

/**
 * The route's source alone, for a field select whose field name ("Runs through") is said apart from its value: an
 * armed change, the Agent's own sign-in, or the source a running route goes through. `null` as for the chip.
 */
export function presentSessionRouteSource(
    presentation: Readonly<{ applied: SessionRoute; pending: SessionRoute | null; reported?: SessionRoute }>,
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown' }>,
): Readonly<{ kind: 'armed' | 'own_sign_in' | 'source'; source: string }> | null {
    const armed = presentArmedSessionRouteSource(presentation, native);
    if (armed) return { kind: 'armed', source: armed };
    const applied = readRunningRoute(presentation);
    if (applied.kind === 'native' && native.authSource === 'unknown') return null;
    const source = routeSourceLabel(applied, native.label);
    if (!source) return null;
    return { kind: applied.kind === 'native' && native.authSource === 'native' ? 'own_sign_in' : 'source', source };
}

export function readProviderRouteConnectionId(selection: RouteSelection): string | null {
    return selection && 'source' in selection
        ? selection.source === 'account_provider_connection' ? selection.providerConnectionId : null
        : selection?.providerConnectionId ?? null;
}

/** Match projected rows by the full authored source, including the Provider purpose and endpoint. */
export function readProjectedConnectedAccountRoute(selection: Extract<SessionModelRefV2, { source: 'connected_account' }>,
    sources: readonly ProviderRouteSource[] | undefined) {
    const key = sessionModelSelectionKey(selection);
    for (const source of sources ?? []) {
        const row = source.rows?.find(row => sessionModelSelectionKey(row.ref) === key);
        if (row) return { source, row };
    }
    return null;
}

export function resolveSessionRoutePresentation(input: SessionRoutePresentationInput): Readonly<{ applied: SessionRoute; pending: SessionRoute | null; reported?: SessionRoute }> {
    const resolve = (selection: RouteSelection, applied: boolean): SessionRoute => {
        if (selection && 'source' in selection && selection.source === 'team_resource') {
            const source = input.teamSources?.find(source => source.teamId === selection.teamId && source.resourceId === selection.resourceId);
            return { kind: 'team', teamId: selection.teamId, resourceId: selection.resourceId,
                deliveryMode: selection.deliveryMode, modelId: selection.modelId, sourceLabel: source?.displayName ?? null };
        }
        if (selection && 'source' in selection && selection.source === 'connected_account') {
            const projected = readProjectedConnectedAccountRoute(selection, input.sources);
            return projected ? { kind: 'provider', connectionId: projected.source.connectionId,
                sourceLabel: providerConnectionSourceLabel(projected.source), modelId: selection.modelId,
                unavailable: projected.source.authorization?.authorized !== true } : { kind: 'unknown' };
        }
        const connectionId = readProviderRouteConnectionId(selection);
        if (connectionId && selection) {
            const current = input.sources?.find(source => source.connectionId === connectionId);
            // A retained Session can edit its next-launch choice before the picker is demanded.
            // Its matching applied snapshot still names that exact source without a catalog RPC.
            const snapshot = input.appliedProviderSource?.connectionId === connectionId ? input.appliedProviderSource : null;
            const source = applied ? snapshot ?? current : current ?? snapshot;
            return { kind: 'provider', connectionId, sourceLabel: source ? providerConnectionSourceLabel(source) : null,
                modelId: selection.modelId, unavailable: current === undefined };
        }
        return { kind: 'native', sourceLabel: input.native.label, authSource: input.native.authSource,
            connectedCount: input.native.connectedCount, modelId: selection?.modelId ?? null };
    };
    return {
        applied: input.phase === 'draft' ? resolve(input.selection, false)
            : input.appliedSelection ? resolve(input.appliedSelection, true) : { kind: 'unknown' },
        ...(input.phase === 'running' && !input.appliedSelection && input.reportedSelection
            ? { reported: resolve(input.reportedSelection, true) } : {}),
        pending: input.phase === 'running' && input.transitionPending ? resolve(input.selection, false) : null,
    };
}
