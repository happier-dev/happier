/**
 * Aggregate transition capacity is a measured deployment fact, never a reuse of
 * the public 500-row/8 MiB transport bounds. `PLAINTEXT-ACCOUNTS-2026-08-09.PEP1`
 * requires the Account transition owner to record measured capacity-reserve
 * bounds for its exact 10,000-Run case before PEP1 may stage or activate, and
 * forbids a source implementation from inventing them.
 *
 * This module holds only the recorded measurement and the derivation over it.
 * The one released bound the derivation needs — the census page unit — is
 * supplied by the Account transition owner, which already owns that Protocol
 * import and is where the derived capacity is bound to a constant.
 */
export type AccountEncryptionTransitionMeasuredCapacity = Readonly<{
    participantLimit: number;
    encodedByteLimit: bigint;
    reservedCapacityBytes: bigint;
}>;

/** The two facts the offline PEP1 measurement reports for the approved case. */
export type AccountEncryptionTransitionCapacityMeasurement = Readonly<{
    /**
     * Participant rows the harness Account's Automation source census
     * enumerates: every Automation definition, then every Run holding retained
     * content. It is NOT the whole census the fence counts — that census also
     * includes every participating plugin Collection row, and the harness
     * Account has none — so a real Account at the approved Run ceiling can
     * carry more participants than this measurement reports.
     */
    censusParticipantRows: number;
    /**
     * Encoded bytes of one near-maximum Run migrate-request segment, measured
     * by sealing a canonical target Run envelope against the Protocol's
     * 220,000-byte stored-string cap.
     *
     * It is a typical-heavy participant, NOT the largest a participant may
     * reach: a Run's source item carries six independently capped envelope
     * fields (two at 220,000, one at 220,512, three at
     * `MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES`), so the census unit
     * `JSON.stringify(inventoryItem)` admits ~2.23 MB — about ten times this
     * value. The derived `encodedByteLimit` therefore bounds an aggregate of
     * typical-heavy participants, and refuses a census of far fewer
     * maximum-content ones.
     */
    nearMaximumParticipantEncodedBytes: bigint;
}>;

/**
 * Recorded output of
 * `sources/app/automations/automationAccountEncryptionPep1.measurement.integration.spec.ts`
 * run on 2026-08-20 with `HAPPIER_PEP1_MEASURE=1`.
 *
 * The measurement is not runnable inside a request transaction: it seeds 10,000
 * Runs across four origins (~600 MB RSS, ~5 s of work) before it can report
 * either fact, so it runs offline behind that env gate and its output is
 * recorded here. Exactly one step stays manual — re-running the harness after a
 * fixture, schema, or Protocol-bound change and copying its two reported facts
 * into this record. Nothing else is manual: the capacity itself is derived
 * below, and the harness asserts these two facts back against this record, so a
 * stale record fails RED instead of silently aging.
 */
export const ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT = Object.freeze({
    censusParticipantRows: 10_003,
    nearMaximumParticipantEncodedBytes: 220_570n,
}) satisfies AccountEncryptionTransitionCapacityMeasurement;

/**
 * Derives the three aggregate bounds the transition fence reads.
 *
 * - `participantLimit` expresses the measured census in the released page unit
 *   the census and stage routes actually walk, rounding up so the harness
 *   Account's own census keeps whole-page headroom. That headroom is the only
 *   allowance for participants the harness Account does not hold — further
 *   Automation definitions and every plugin Collection row — so an Account at
 *   the approved Run ceiling plus more than that headroom is refused
 *   `migration_too_large` even though its Run count is inside the approved
 *   scope.
 * - `encodedByteLimit` bounds one side — the source census, or the staged
 *   target set — at the footprint that many typical-heavy participants reach.
 *   See `nearMaximumParticipantEncodedBytes`: it is not a per-participant
 *   maximum, so this is not a worst-case bound for the approved Run scope.
 * - `reservedCapacityBytes` bounds the peak the fence actually checks,
 *   `sourceBytes + targetBytes`. Both sides are retained at once while a
 *   transition is staged, so reserving only one side's worth would refuse the
 *   approved case at its final batch. For an Automation participant the staged
 *   target measurement is the whole stage item, which embeds source and target
 *   together, so that peak is closer to three times one side than two.
 */
export function deriveAccountEncryptionTransitionMeasuredCapacity(
    params: Readonly<{
        measurement: AccountEncryptionTransitionCapacityMeasurement;
        censusPageItems: number;
    }>,
): AccountEncryptionTransitionMeasuredCapacity {
    const participantLimit = Math.ceil(
        params.measurement.censusParticipantRows / params.censusPageItems,
    ) * params.censusPageItems;
    const encodedByteLimit =
        params.measurement.nearMaximumParticipantEncodedBytes
        * BigInt(participantLimit);
    return {
        participantLimit,
        encodedByteLimit,
        reservedCapacityBytes: encodedByteLimit * 2n,
    };
}
