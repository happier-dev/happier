import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

/**
 * Classify a failed HTTP mutation from this carrier's transport witness.
 *
 * `issued` means every local authority/setup guard passed and the request was
 * handed to the transport. The decision itself belongs to the Protocol seam
 * owner, so the browser carrier and the CLI/daemon carrier cannot disagree
 * about whether one sealed mutation may have committed.
 */
export function classifyHttpMutationRequestFailure(input: Readonly<{
    error: unknown;
    issued: boolean;
    signal?: AbortSignal;
}>): 'cancelled' | 'not_dispatched' | 'outcome_unknown' {
    return classifyHomeDomainHttpMutationFailureV1({
        error: input.error,
        issued: input.issued,
        aborted: input.signal?.aborted === true,
    });
}
