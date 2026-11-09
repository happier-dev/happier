import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { projectTriageSourceReadFailureV1, type TriageSourceReadFailureV1 } from '@happier-dev/triage-sources/runtime';

/** UI-local transport facts; the source's published failure envelope stays unchanged. */
export type GithubReadFailureV1 = TriageSourceReadFailureV1;

/** A result the surface could not read is a contract break, not an empty read. */
export const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github-detail-result-unreadable',
});

/**
 * The observation carried no route for this entry, so no plane can be read.
 *
 * It is a stated failure rather than an empty panel: a path is never guessed
 * from identity, display text or a git remote.
 */
export const ROUTE_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});

export function dispatchFailure(execution: ExecuteResult, fallbackCode: string): GithubReadFailureV1 {
  return projectTriageSourceReadFailureV1(execution, fallbackCode, 'github-detail-read-not-dispatched');
}

export type ExecuteResult = PluginActionExecution;

/** The source-private route the target observed for this entry, if it has one. */
export function useGithubRoutingToken(input: TriageDetailSurfaceInputV1): string | null {
  return input.observation.locator.routingToken ?? null;
}
