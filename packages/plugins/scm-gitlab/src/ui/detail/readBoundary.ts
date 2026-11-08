import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

/** A result the surface could not read is a contract break, not an empty read. */
export const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-result-unreadable',
});

/** An entry without its source-minted route cannot be read by guessing a project. */
export const ROUTE_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'gitlab-locator-unusable',
});

export function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending' ? 'gitlab-detail-read-not-dispatched' : code,
  });
}

export type ExecuteResult = Readonly<{ status: string; result?: unknown; code?: string }>;

/** The source-private route the target observed for this entry, if it has one. */
export function useGitlabRoutingToken(input: TriageDetailSurfaceInputV1): string | null {
  return input.observation.locator.routingToken ?? null;
}
