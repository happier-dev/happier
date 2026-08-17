import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiDestinationProjection } from '@/sync/domains/plugins/ui/projection';
import {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
} from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

/**
 * The authority a plugin launch input belongs to.
 *
 * `openSurface(destination, input)` hands the host a bounded JSON argument meant for
 * ONE destination, produced by ONE contribution generation, on ONE machine, for
 * ONE account/server. Every fact in that sentence can change while the value is
 * still held: a projection generation is replaced, a plugin is uninstalled and
 * reinstalled under the same id, the active server or account changes, or the
 * contributing machine goes away. A launch input that outlives any of them is
 * delivered to a surface the author never addressed.
 *
 * This is the same triple the bound surface controller already treats as the
 * mount's identity (`machineId` / `serverId` / `projectionGeneration` in
 * `PluginSurfaceHost`), so a held launch input is scoped by exactly the facts
 * the surface it belongs to is scoped by — rather than by a plugin id, which
 * survives all of them.
 */
export type PluginSurfaceLaunchAuthority = Readonly<{
    serverId: string | null;
    machineId: string | null;
    /** The contribution-registry projection generation the open was made under. */
    generation: number | null;
    /**
     * The opaque incumbent Account lifetime captured by the owning host scope.
     * It prevents an Account transition that keeps the server id stable from
     * delivering bounded launch input to the successor Account.
     */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /**
     * Exact selected materialization when this launch came from a unioned
     * app-scope contribution. It is intentionally absent for machine-scoped
     * surfaces, whose surrounding controller already owns their one producer.
     *
     * Do not reconstruct this from the coarse machine/server coordinates:
     * materialization replacement can retain both while changing the producer.
     */
    executionOrigin: PluginMachineExecutionOriginV1 | null;
}>;

export function createPluginSurfaceLaunchAuthority(input: Readonly<{
    serverId?: string | null;
    machineId?: string | null;
    generation?: number | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
}>): PluginSurfaceLaunchAuthority {
    return Object.freeze({
        serverId: input.serverId ?? null,
        machineId: input.machineId ?? null,
        generation: input.generation ?? null,
        accountLifetime: input.accountLifetime ?? null,
        executionOrigin: input.executionOrigin ?? null,
    });
}

/**
 * Reads the exact producer authority carried by a selected app-scope
 * contribution. The app union is only a catalog: it cannot authorize a
 * launch-input handoff for one of its members.
 *
 * Keep this conversion beside launch-authority equality so every consumer
 * applies the same fail-closed test before retaining bounded plugin JSON.
 */
export function resolveSelectedPluginSurfaceLaunchAuthority(input: Readonly<{
    placement: PluginUiDestinationProjection | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): PluginSurfaceLaunchAuthority | null {
    if (!input.placement || input.accountLifetime?.isCurrent() === false) return null;
    const origin = readPluginUiContributionOrigin(input.placement);
    const executionOrigin = origin?.executionOrigin ?? null;
    if (
        !origin
        || !executionOrigin
        || origin.phase !== 'current'
        || origin.interactionEnabled !== true
        || executionOrigin.materializationRef.pluginId !== input.placement.pluginId
        || executionOrigin.materializationRef.machineId !== origin.machineId
    ) {
        return null;
    }
    return createPluginSurfaceLaunchAuthority({
        serverId: origin.serverId,
        machineId: origin.machineId,
        generation: origin.generation,
        accountLifetime: input.accountLifetime,
        executionOrigin,
    });
}

/**
 * Currentness facts supplied by the registered direct Session/Project scope
 * adapter. They are intentionally not recoverable from a persisted scope id or
 * a placement target selector.
 */
export type PluginSurfaceScopedLaunchFacts = Readonly<{
    serverId: string | null;
    machineId: string | null;
    generation: number | null;
    interactionEnabled: boolean;
}>;

function hasContributionOriginField(placement: PluginUiDestinationProjection): boolean {
    return Object.prototype.hasOwnProperty.call(placement, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY);
}

/**
 * One launch-authority resolver for both selected app-union contributions and
 * direct Session/Project scope adapters. A union-stamped contribution remains
 * fail-closed when its exact origin is missing or invalid; it never falls back
 * to coarse direct facts. A direct scope, in turn, must supply its registered
 * currentness facts and the producer-stamped execution materialization.
 */
export function resolvePluginSurfaceLaunchAuthority(input: Readonly<{
    placement: PluginUiDestinationProjection | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    scoped?: PluginSurfaceScopedLaunchFacts | null;
}>): PluginSurfaceLaunchAuthority | null {
    if (!input.placement || input.accountLifetime?.isCurrent() === false) return null;

    if (hasContributionOriginField(input.placement)) {
        return resolveSelectedPluginSurfaceLaunchAuthority({
            placement: input.placement,
            accountLifetime: input.accountLifetime,
        });
    }

    const scoped = input.scoped ?? null;
    if (
        !scoped
        || scoped.interactionEnabled !== true
        || !scoped.machineId
        || scoped.generation === null
        || !Number.isFinite(scoped.generation)
    ) {
        return null;
    }
    const executionOrigin = readPluginUiProjectionEntryExecutionOrigin(input.placement);
    if (
        !executionOrigin
        || executionOrigin.materializationRef.pluginId !== input.placement.pluginId
        || executionOrigin.materializationRef.machineId !== scoped.machineId
    ) {
        return null;
    }
    return createPluginSurfaceLaunchAuthority({
        serverId: scoped.serverId,
        machineId: scoped.machineId,
        generation: scoped.generation,
        accountLifetime: input.accountLifetime,
        executionOrigin,
    });
}

function areSameExecutionOrigins(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1 | null,
): boolean {
    return left === right || (
        left !== null
        && right !== null
        && left.serverIdentityId === right.serverIdentityId
        && left.materializationRef.pluginId === right.materializationRef.pluginId
        && left.materializationRef.machineId === right.materializationRef.machineId
        && left.materializationRef.materializationId === right.materializationRef.materializationId
    );
}

/**
 * Exact equality, never a partial match: an unknown identity (`null`) is a
 * DIFFERENT authority from a known one, so a value staged before the projection
 * resolved is never delivered into a resolved one.
 */
export function isSamePluginSurfaceLaunchAuthority(
    left: PluginSurfaceLaunchAuthority,
    right: PluginSurfaceLaunchAuthority,
): boolean {
    const sameCoordinates = left.serverId === right.serverId
        && left.machineId === right.machineId
        && left.generation === right.generation;
    if (!sameCoordinates || left.accountLifetime !== right.accountLifetime) {
        return false;
    }
    // The exact materialization is an additional identity fact when supplied.
    // A null/missing stamp never matches a stamped one, so a caller cannot use
    // coarse coordinates as a fallback after selected-origin information exists.
    if (!areSameExecutionOrigins(left.executionOrigin, right.executionOrigin)) {
        return false;
    }
    // A synchronous Account retirement can land before React recreates this
    // authority. The same stale object is not current merely because it is
    // referentially equal, so it cannot keep a pending launch readable.
    return (left.accountLifetime?.isCurrent() ?? true)
        && (right.accountLifetime?.isCurrent() ?? true);
}
