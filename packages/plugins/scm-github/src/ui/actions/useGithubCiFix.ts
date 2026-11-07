import { useCallback } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { createForgeCiFailureContextReadRequestV1, forgeCiSelectionKeyV1, readForgeCiSelectionRunV1 } from '@happier-dev/forge-ci/runtime';
import type { ForgeCiBindingV1 } from '@happier-dev/forge-ci/ui';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSessionHandoffInputV1, TriageSessionHandoffSelectionV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageSessionHandoffChoicesV1 } from '@happier-dev/triage-sources/runtime';
import { handoffGithubCiFailureV1 } from './failureHandoff.js';
import { GITHUB_CI_ACTION_REFS_V1 } from './model.js';

export type GithubCiFixTargetV1 = Parameters<NonNullable<ForgeCiBindingV1['fix']>>[0];
export type GithubCiFixV1 = (
  target: GithubCiFixTargetV1,
  choice?: TriageSessionHandoffSelectionV1,
) => Promise<JsonValue | void>;

/** Mounting does no IO. The native summary owner selects and fits evidence;
 * Triage's configured runner alone chooses the Session, Agent and delivery. */
export function useGithubCiFixV1(options: Readonly<{
  /** The public renderer lifetime; retained callbacks cannot outlive it. */
  signal: AbortSignal;
  workspace?: Extract<TriageSessionHandoffInputV1['context'], { kind: 'repository' }>['workspace'];
}>): GithubCiFixV1 {
  const host = usePluginHostApi();
  const { signal, workspace } = options;
  return useCallback<GithubCiFixV1>(async (target, explicitChoice) => {
    if (signal.aborted) return { kind: 'cancelled' };
    if (target.job !== undefined && forgeCiSelectionKeyV1(target.job.selection) !== forgeCiSelectionKeyV1(target.selection)) {
      return { kind: 'unavailable', reason: 'evidenceInvalid' };
    }
    try {
      let choice = explicitChoice;
      if (choice === undefined) {
        const offered = await readTriageSessionHandoffChoicesV1(host, { signal });
        if (signal.aborted) return { kind: 'cancelled' };
        if (offered.kind === 'actionOutcome') return offered.outcome;
        if (offered.kind === 'unavailable') return offered;
        choice = offered.actions.find(action => action.selection.configuredActionId === offered.defaultActionId)?.selection;
        if (choice === undefined) return { kind: 'unavailable', reason: 'configuredActionUnavailable' };
      }
      const run = readForgeCiSelectionRunV1(target.selection);
      // L02's request factory owns excerpt selection and the actual Action
      // carrier budget; no UI limit or reserve is needed.
      const response = await host.executeAction(GITHUB_CI_ACTION_REFS_V1.readFailureContext,
        projectNativeJsonValueForTransport(createForgeCiFailureContextReadRequestV1({ repository: run.repository, selection: target.selection,
          ...(target.job === undefined ? {} : { jobs: [target.job.jobId] }) })), { signal });
      if (signal.aborted) return { kind: 'cancelled' };
      if (response === undefined) return response;
      if (response && typeof response === 'object' && !Array.isArray(response) && 'ok' in response && response.ok === false) return response;
      const value = response && typeof response === 'object' && !Array.isArray(response)
        && 'ok' in response && response.ok === true && 'result' in response ? response.result : response;
      if (isPluginActionApprovalRequestCreated(value)) return response;
      const summary = ForgeCiActionResultSchemasV1.readFailureContext.parse(value);
      if (summary.kind !== 'value') return response;
      // Once configured delivery begins, its result or rejection belongs to
      // that owner; the read-only cancellation catch below cannot reclassify it.
      return handoffGithubCiFailureV1(host, { summary: summary.value, ...choice,
        ...(workspace === undefined ? {} : { workspace }) }, { signal });
    } catch (error) {
      if (signal.aborted) return { kind: 'cancelled' };
      throw error;
    }
  }, [host, signal, workspace]);
}
