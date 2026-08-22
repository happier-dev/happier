/** @moduleRealm daemon */
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { PluginTargetedContributionSelectionV1 } from '../targetedContributionAuthoring.js';

/**
 * One target-owned point declaration used to observe its admitted contributors.
 * The host only accepts it for the invoking target plugin; it is not a global
 * catalog query or an authority to inspect another target's point.
 */
export type TargetedContributionPointRef<TContribution = unknown> = Readonly<{
    /**
     * The declaration's owning target. This is an equality fence against the
     * invoking plugin identity, not a selector for another target's catalog.
     */
    targetPluginId: string;
    id: string;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    /**
     * Target-produced executable semantics for the host-only cold projection.
     * This is an ordinary cross-copy data carrier, parsed by the semantic
     * decoder; it is never canonical manifest JSON or invocation authority.
     */
    semanticCarrier?: unknown;
    /** Compile-time evidence only; no contributor implementation crosses the manifest boundary. */
    readonly __targetedContribution?: TContribution;
}>;

/**
 * A complete current admitted view of one target-owned point. `generation` is
 * the target's committed immutable generation, including for an empty point.
 */
export interface TargetedContributionSnapshot<TContribution> {
    readonly generation: string;
    readonly contributions: readonly TContribution[];
}

/** A reserve-before-read observation of one target point's current admitted view. */
export interface TargetedContributionObservation<TContribution> extends Disposable {
    readCurrent(options?: PluginCancellationOptions): Promise<TargetedContributionSnapshot<TContribution>>;
}

/**
 * Target-local admitted-contribution discovery. The callback is level-triggered:
 * it carries no delta and callers reread a complete bounded current snapshot.
 */
export interface TargetedContributionsService {
    observeForSelf<TContribution>(
        point: TargetedContributionPointRef<TContribution>,
        options: Readonly<{ onInvalidated: () => void }>,
    ): TargetedContributionObservation<TContribution>;
}

/**
 * The stable identity fields every host-admitted contribution carries. The
 * selector preserves the original typed entry, including opaque operation and
 * surface handles, rather than reconstructing a local representation.
 */
export type TargetedContributionAdmittedEntry = Readonly<{
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
}>;

export type TargetedContributionSelectionUnavailableReason =
    | 'selection_invalid'
    | 'target_generation_stale'
    | 'contributor_unavailable';

/** The current result of resolving one portable selection through its target owner. */
export type TargetedContributionSelectionResult<TContribution> =
    | Readonly<{
        kind: 'selected';
        targetGeneration: string;
        contribution: TContribution;
    }>
    | Readonly<{
        kind: 'unavailable';
        reason: TargetedContributionSelectionUnavailableReason;
    }>;

function selectionAddressesPoint(
    selection: PluginTargetedContributionSelectionV1,
    point: TargetedContributionPointRef,
): boolean {
    return selection.target.pluginId === point.targetPluginId
        && selection.point.pointId === point.id
        && selection.point.protocol.id === point.protocol.id
        && selection.point.protocol.version === point.protocol.version;
}

function contributionMatchesSelection(
    contribution: TargetedContributionAdmittedEntry,
    selection: PluginTargetedContributionSelectionV1,
): boolean {
    return contribution.protocol.id === selection.point.protocol.id
        && contribution.protocol.version === selection.point.protocol.version
        && contribution.contributor.pluginId === selection.contributor.pluginId
        && contribution.contributor.contributionId === selection.contributor.contributionId
        && contribution.contributor.immutableGenerationId === selection.contributor.immutableGenerationId;
}

/**
 * Reads exactly one current host-admitted contributor for a portable
 * target/point/contributor selection.
 *
 * This is deliberately target-local: it opens the existing `observeForSelf`
 * lifecycle service, never consults an inventory, and fails closed when the
 * target or contributor generation has changed. Consumers receive the host's
 * original typed entry, so opaque operation handles retain their authority and
 * lifetime rather than being recreated by a UI or application layer.
 *
 * @realm any
 *
 * This selector owns no daemon resource: its only dependencies are erased
 * caller contracts, and it receives the live target-local service from its
 * caller. The same currentness and cancellation semantics therefore remain
 * available through the browser-conditioned root entrypoint.
 */
export async function selectCurrentTargetedContribution<
    TContribution extends TargetedContributionAdmittedEntry,
>(input: Readonly<{
    service: TargetedContributionsService;
    point: TargetedContributionPointRef<TContribution>;
    selection: PluginTargetedContributionSelectionV1;
    signal?: AbortSignal;
}>): Promise<TargetedContributionSelectionResult<TContribution>> {
    if (!selectionAddressesPoint(input.selection, input.point)) {
        return Object.freeze({ kind: 'unavailable', reason: 'selection_invalid' });
    }

    const observation = input.service.observeForSelf(input.point, { onInvalidated: () => {} });
    try {
        const snapshot = await observation.readCurrent({ signal: input.signal });
        if (snapshot.generation !== input.selection.target.immutableGenerationId) {
            return Object.freeze({ kind: 'unavailable', reason: 'target_generation_stale' });
        }

        const matches = snapshot.contributions.filter((contribution) => (
            contributionMatchesSelection(contribution, input.selection)
        ));
        if (matches.length !== 1) {
            return Object.freeze({ kind: 'unavailable', reason: 'contributor_unavailable' });
        }

        return Object.freeze({
            kind: 'selected',
            targetGeneration: snapshot.generation,
            contribution: matches[0]!,
        });
    } finally {
        observation.dispose();
    }
}
