import type { CorpusDisplayedAttentionV1 } from '../attention/deriveAttention.js';
import type { CorpusEntryObservationsV1 } from '../fold/projectedObservation.js';

/**
 * Which connection the selected entry's detail and Actions run under.
 *
 * This is the read-side twin of the attention derivation: a pure derivation
 * over the selected entry's authoritative observations, never over an
 * entry-local account or permission map. Exactly one instance is selected, and
 * the reason is visible.
 */
export type CorpusSelectedInstanceV1 =
    | Readonly<{
        kind: 'selected';
        sourceInstanceId: string;
        reason: 'override' | 'attention' | 'onlyPresent' | 'deterministicTieBreak';
    }>
    | Readonly<{ kind: 'none'; reason: 'noPresentObservation' | 'allInstancesRetired' }>;

export function selectObservationInstance(
    observations: CorpusEntryObservationsV1,
    activeSourceInstanceIds: Iterable<string>,
    attention: CorpusDisplayedAttentionV1 | null,
    overrideSourceInstanceId: string | null,
): CorpusSelectedInstanceV1 {
    const active = new Set(activeSourceInstanceIds);
    const anyPresent: string[] = [];
    const eligible: string[] = [];
    for (const observation of observations) {
        // Only a present observation carries something to open, and a retired
        // instance has no credential to run anything under.
        if (observation.outcome.kind !== 'present') continue;
        anyPresent.push(observation.sourceInstanceId);
        if (active.has(observation.sourceInstanceId)) eligible.push(observation.sourceInstanceId);
    }
    if (eligible.length === 0) {
        return {
            kind: 'none',
            reason: anyPresent.length > 0 ? 'allInstancesRetired' : 'noPresentObservation',
        };
    }

    // The user's explicit switch is never second-guessed.
    if (overrideSourceInstanceId && eligible.includes(overrideSourceInstanceId)) {
        return { kind: 'selected', sourceInstanceId: overrideSourceInstanceId, reason: 'override' };
    }

    // The connection the row's own reason names, so the detail opens under the
    // account that was actually asked. A null attention result deliberately
    // falls through to the deterministic rule below.
    if (attention && eligible.includes(attention.fromSourceInstanceId)) {
        return { kind: 'selected', sourceInstanceId: attention.fromSourceInstanceId, reason: 'attention' };
    }

    // Never pass order, never insertion order, and never "the freshest": two
    // instances' observation times come from two machines' clocks and are not
    // comparable.
    const smallest = [...eligible].sort()[0] as string;
    return {
        kind: 'selected',
        sourceInstanceId: smallest,
        reason: eligible.length === 1 ? 'onlyPresent' : 'deterministicTieBreak',
    };
}
