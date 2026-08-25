import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import type {
    PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';

// The one UI-side projection type the daemon transport actually produces; the
// normalizer below consumes exactly this, so a second protocol-package alias
// here would drift from what the describe owner hands over.
import type {
    DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    loadPluginUiProjectionWarmCacheEntries,
    savePluginUiProjectionWarmCacheEntries,
    type PluginUiProjectionCacheEntryV1,
} from '@/sync/domains/state/warmCachePersistence';

import {
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from './projection';

/**
 * The Account-qualified last-confirmed plugin UI admission snapshot.
 *
 * Authority is two tiers, not one. Account scoping and Artifact integrity must
 * be exact and already are: bytes are Account-qualified and integrity-verified
 * at acquisition by the Availability Artifact lease. Admission/presentation
 * currentness is the tier that can be last-confirmed, and this module is the
 * only place it is retained across a process. It reuses the incumbent warm
 * cache the platform already owns rather than adding a second persisted
 * authority, store, or currentness owner.
 *
 * The retained snapshot is deliberately the presentation slice only: the
 * daemon-admitted installed-package facts plus the `pluginUi` contribution
 * family. Actions, Composer families, voice providers, tools, commands,
 * Resources and diagnostics are never retained, so a restored process cannot
 * activate anything daemon-backed even before the read-only phase gate.
 */

/**
 * The one key every consumer of this Account-scoped custody uses for a
 * machine. The machine-wide currentness owner and the target-scoped describe
 * owner both address the same entry, so the key cannot be spelled twice.
 */
export function pluginUiProjectionAdmissionTargetKey(input: Readonly<{
    serverId: string | null | undefined;
    machineId: string;
}>): string {
    const serverId = typeof input.serverId === 'string' && input.serverId.trim().length > 0
        ? input.serverId
        : null;
    return `${serverId ?? 'default'}:${input.machineId}`;
}

function hasAnyOwnKey(value: Readonly<Record<string, unknown>> | undefined | null): boolean {
    if (!value) return false;
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
    return false;
}

/**
 * Shape-agnostic on purpose: the projection model gains families over time and
 * a hand-listed set of maps here would silently stop noticing new ones.
 */
function hasAnyProjectionEntries(model: PluginUiProjectionModel): boolean {
    for (const value of Object.values(model)) {
        if (value && typeof value === 'object' && hasAnyOwnKey(value as Record<string, unknown>)) {
            return true;
        }
    }
    return false;
}

/**
 * Builds the minimal retained projection, then round-trips it through the
 * canonical Protocol schema so the persisted bytes are exactly what the
 * restoring reader accepts. A projection with no admitted `pluginUi` entries
 * yields `null`: an empty targeted snapshot is never retained and never
 * restored as authority.
 */
function buildRetainedAdmissionProjection(
    projection: DaemonContributionRegistryProjection | null,
): PluginUiProjectionCacheEntryV1['projection'] | null {
    if (!projection || projection.v !== 2) return null;
    const pluginUi = projection.familiesById.pluginUi;
    if (!pluginUi || !hasAnyOwnKey(pluginUi.entriesById)) return null;
    const retained = PluginProjectionV2Schema.safeParse({
        v: 2,
        generation: projection.generation,
        installedPackagesById: projection.installedPackagesById,
        familiesById: { pluginUi },
    });
    return retained.success ? retained.data : null;
}

/**
 * Whether a retained presentation slice still admits this exact target. A
 * package row carries its own committed `immutableGenerationId`, so matching it
 * is what makes a restored target admission current — no generation is ever
 * synthesized, inferred, or carried forward past its package row.
 */
function admitsExactTarget(
    projection: PluginUiProjectionCacheEntryV1['projection'],
    target: PluginUiTargetedContributionsV1['target'],
): boolean {
    const immutableGenerationId = projection.installedPackagesById[target.pluginId]?.immutableGenerationId;
    return immutableGenerationId !== undefined
        && immutableGenerationId === target.immutableGenerationId;
}

/**
 * Records the snapshot that produced a `current` projection phase for one
 * exact machine target. Called only after the describe owner has confirmed
 * currentness; this module never decides currentness itself.
 */
export function savePluginUiProjectionAdmissionSnapshot(input: Readonly<{
    scope: ServerAccountScope | null;
    targetKey: string;
    machineId: string;
    projection: DaemonContributionRegistryProjection;
}>): void {
    if (!input.scope) return;
    const retained = buildRetainedAdmissionProjection(input.projection);
    const previous = loadPluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId);
    if (!retained) {
        if (!Object.prototype.hasOwnProperty.call(previous, input.targetKey)) return;
        const { [input.targetKey]: _removed, ...remaining } = previous;
        savePluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId, remaining);
        return;
    }
    const previousEntry = previous[input.targetKey];
    // A projection refresh replaces the presentation slice, not the target
    // admissions recorded against the same machine: in a live process the
    // machine-wide describe re-runs on every reconnect, so dropping them here
    // would leave nothing to restore. A different machine keeps none of them,
    // and a superseded generation is rejected by the exact-target read below.
    const targetedContributionsByPluginId = previousEntry?.machineId === input.machineId
        ? previousEntry.targetedContributionsByPluginId
        : undefined;
    savePluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId, {
        ...previous,
        [input.targetKey]: {
            machineId: input.machineId,
            projection: retained,
            ...(targetedContributionsByPluginId === undefined
                ? {}
                : { targetedContributionsByPluginId }),
        },
    });
}

/**
 * Whether a target response is a retainable positive admission.
 *
 * An empty point list is perfectly valid live data — the mounted target simply
 * has nothing contributed to it right now — but it is not last-known-good
 * state: restoring it would let a fresh offline process treat "nothing was
 * admitted" as a confirmed target context. Only a snapshot that names at least
 * one admitted point is retained or restored.
 */
function isRetainableTargetAdmission(
    targetedContributions: PluginUiTargetedContributionsV1,
): boolean {
    return targetedContributions.points.length > 0;
}

/**
 * Records the target-scoped admission that accompanied a successful describe
 * for one exact mounted target.
 *
 * It is written into the same entry as the presentation slice, in one store
 * write, and only when that slice still admits this exact committed
 * generation. There is deliberately no orphan target admission: a restore
 * derives its mounted target from the retained packages, so an admission the
 * retained packages cannot produce could never be matched anyway.
 *
 * A current response that admits no points removes any row it supersedes.
 * Declining the write instead would leave the older nonempty row acting as
 * offline authority after the daemon said there is nothing there.
 */
export function savePluginUiProjectionTargetedAdmissionSnapshot(input: Readonly<{
    scope: ServerAccountScope | null;
    targetKey: string;
    machineId: string;
    targetedContributions: PluginUiTargetedContributionsV1;
}>): void {
    if (!input.scope) return;
    const previous = loadPluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId);
    const entry = previous[input.targetKey];
    if (!entry || entry.machineId !== input.machineId) return;
    const { target } = input.targetedContributions;
    if (!admitsExactTarget(entry.projection, target)) return;
    if (!isRetainableTargetAdmission(input.targetedContributions)) {
        const retained = entry.targetedContributionsByPluginId;
        if (!retained || !Object.prototype.hasOwnProperty.call(retained, target.pluginId)) return;
        const { [target.pluginId]: _removed, ...remaining } = retained;
        savePluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId, {
            ...previous,
            [input.targetKey]: {
                ...entry,
                targetedContributionsByPluginId: remaining,
            },
        });
        return;
    }
    if (entry.targetedContributionsByPluginId?.[target.pluginId] === input.targetedContributions) return;
    savePluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId, {
        ...previous,
        [input.targetKey]: {
            ...entry,
            targetedContributionsByPluginId: {
                ...entry.targetedContributionsByPluginId,
                [target.pluginId]: input.targetedContributions,
            },
        },
    });
}

/**
 * Restores the last-confirmed admission snapshot for one exact Account and
 * machine target, or `null` when none was retained. The caller owns the
 * read-only presentation phase; a restored model never carries authority.
 */
export function readPluginUiProjectionAdmissionSnapshot(input: Readonly<{
    scope: ServerAccountScope | null;
    targetKey: string;
    machineId: string;
}>): PluginUiProjectionModel | null {
    if (!input.scope) return null;
    const entry = loadPluginUiProjectionWarmCacheEntries(
        input.scope.serverId,
        input.scope.accountId,
    )[input.targetKey];
    if (!entry || entry.machineId !== input.machineId) return null;
    const model = normalizePluginUiProjection(entry.projection);
    return hasAnyProjectionEntries(model) ? model : null;
}

/**
 * Restores the last-confirmed target admission for one exact machine target
 * and committed generation, or `null` when none was retained.
 *
 * The caller owns the read-only phase: this returns the presentation handle
 * the daemon last confirmed, never a claim that the target is reachable now.
 */
export function readPluginUiProjectionTargetedAdmissionSnapshot(input: Readonly<{
    scope: ServerAccountScope | null;
    targetKey: string;
    machineId: string;
    target: PluginUiTargetedContributionsV1['target'];
}>): PluginUiTargetedContributionsV1 | null {
    if (!input.scope) return null;
    const entry = loadPluginUiProjectionWarmCacheEntries(
        input.scope.serverId,
        input.scope.accountId,
    )[input.targetKey];
    if (!entry || entry.machineId !== input.machineId) return null;
    const retained = entry.targetedContributionsByPluginId?.[input.target.pluginId];
    // Bytes an earlier build may already have written are re-checked here, so
    // a persisted empty snapshot cannot keep authorizing a mount.
    return retained
        && retained.target.pluginId === input.target.pluginId
        && retained.target.immutableGenerationId === input.target.immutableGenerationId
        && isRetainableTargetAdmission(retained)
        ? retained
        : null;
}

/**
 * A daemon's own definitive "this machine does not serve the projection"
 * answer retires that machine's retained snapshot, so it cannot come back on
 * the next process. A transport failure or an unreachable machine is not that
 * answer and must leave the entry alone.
 */
export function forgetPluginUiProjectionAdmissionSnapshot(input: Readonly<{
    scope: ServerAccountScope | null;
    targetKey: string;
}>): void {
    if (!input.scope) return;
    const previous = loadPluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId);
    if (!Object.prototype.hasOwnProperty.call(previous, input.targetKey)) return;
    const { [input.targetKey]: _removed, ...remaining } = previous;
    savePluginUiProjectionWarmCacheEntries(input.scope.serverId, input.scope.accountId, remaining);
}

/**
 * Forgetting the Account on this device deletes every retained snapshot it
 * owns. An Account switch or deactivation deliberately does not: the entries
 * stay inert and are reusable once that same Account is current again. The
 * only other deletion is one machine's own definitive `not-supported` answer
 * above.
 */
export function forgetPluginUiProjectionAdmissionSnapshots(scope: ServerAccountScope): void {
    savePluginUiProjectionWarmCacheEntries(scope.serverId, scope.accountId, {});
}
