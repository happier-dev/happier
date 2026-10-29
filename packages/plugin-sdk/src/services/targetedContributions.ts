/** @moduleRealm any */
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { AdmittedTargetedOperationIdentity } from '../actions/admittedTargetedOperation.js';
import type {
    PluginTargetedContributionSelectionV1,
    PluginTargetedContributionSourceCustodyV1,
} from '../targetedContributionAuthoring.js';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

import type { TargetedContributionPointRef, TargetedContributionSnapshot, TargetedContributionObservation, TargetedContributionsService } from '@happier-dev/cli-common/plugins/registration/contracts';
export type { TargetedContributionPointRef, TargetedContributionSnapshot, TargetedContributionObservation, TargetedContributionsService } from '@happier-dev/cli-common/plugins/registration/contracts';

/**
 * The stable identity fields every host-admitted contribution carries. The
 * selector preserves the original typed entry, including opaque operation and
 * surface handles, rather than reconstructing a local representation.
 */
export type TargetedContributionAdmittedEntry = Readonly<{
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        occurrenceId: string;
        sourceCustody: PluginTargetedContributionSourceCustodyV1;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    operations?: Readonly<Record<string, Readonly<{
        identity: AdmittedTargetedOperationIdentity;
    }> | undefined>>;
}>;

export type TargetedContributionSelectionUnavailableReason =
    | 'selection_invalid'
    | 'target_source_stale'
    | 'contributor_unavailable';

/** The current result of resolving one portable selection through its target owner. */
export type TargetedContributionSelectionResult<TContribution> =
    | Readonly<{
        kind: 'selected';
        targetOccurrenceId: string;
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
    operationRole: string | undefined,
): boolean {
    if (!(contribution.protocol.id === selection.point.protocol.id
        && contribution.protocol.version === selection.point.protocol.version
        && contribution.contributor.pluginId === selection.contributor.pluginId
        && contribution.contributor.contributionId === selection.contributor.contributionId)) return false;
    if (operationRole === undefined) return pluginSourceCustodyV1Equal(
        contribution.contributor.sourceCustody,
        selection.contributor.sourceCustody,
    );
    const operations = contribution.operations;
    const operation = operations && Object.hasOwn(operations, operationRole)
        ? operations[operationRole]?.identity
        : undefined;
    return operation !== undefined
        && operation.role === operationRole
        && operation.target.pluginId === selection.target.pluginId
        && operation.point.pointId === selection.point.pointId
        && operation.point.protocol.id === selection.point.protocol.id
        && operation.point.protocol.version === selection.point.protocol.version
        && operation.contributor.pluginId === selection.contributor.pluginId
        && operation.contributor.contributionId === selection.contributor.contributionId
        && pluginSourceCustodyV1Equal(operation.contributor.sourceCustody, selection.contributor.sourceCustody);
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
 * By default the selection fences the contributor descriptor's source. An
 * explicit operationRole instead fences that exact role's source, as retained
 * Action-input selections do. A changed or missing role never falls back to
 * the descriptor or another role, including in a mixed-placement contribution.
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
    operationRole?: TContribution extends Readonly<{ operations: infer Operations }>
        ? Extract<keyof Operations, string>
        : never;
    signal?: AbortSignal;
}>): Promise<TargetedContributionSelectionResult<TContribution>> {
    if (!selectionAddressesPoint(input.selection, input.point)) {
        return Object.freeze({ kind: 'unavailable', reason: 'selection_invalid' });
    }

    const observation = input.service.observeForSelf(input.point, { onInvalidated: () => {} });
    try {
        const snapshot = await observation.readCurrent({ signal: input.signal });
        if (!pluginSourceCustodyV1Equal(snapshot.sourceCustody, input.selection.target.sourceCustody)) {
            return Object.freeze({ kind: 'unavailable', reason: 'target_source_stale' });
        }

        const matches = snapshot.contributions.filter((contribution) => (
            contributionMatchesSelection(contribution, input.selection, input.operationRole)
        ));
        if (matches.length !== 1) {
            return Object.freeze({ kind: 'unavailable', reason: 'contributor_unavailable' });
        }

        return Object.freeze({
            kind: 'selected',
            targetOccurrenceId: snapshot.occurrenceId,
            contribution: matches[0]!,
        });
    } finally {
        observation.dispose();
    }
}
