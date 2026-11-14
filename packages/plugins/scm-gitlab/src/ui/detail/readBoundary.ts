import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { projectTriageSourceReadFailureV1, type TriageSourceReadFailureV1 } from '@happier-dev/triage-sources/runtime';
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

export function dispatchFailure(execution: ExecuteResult, fallbackCode: string, sourceFailure?: TriageSourceFailureV1): TriageSourceReadFailureV1 {
  return projectTriageSourceReadFailureV1(execution, fallbackCode, 'gitlab-detail-read-not-dispatched', sourceFailure);
}

export type ExecuteResult = PluginActionExecution;

/** The source-private route the target observed for this entry, if it has one. */
export function useGitlabRoutingToken(input: TriageDetailSurfaceInputV1): string | null {
  return input.observation.locator.routingToken ?? null;
}
