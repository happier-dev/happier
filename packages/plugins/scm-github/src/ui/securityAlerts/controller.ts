import { useCallback, useMemo, useRef, useState } from 'react';
import { useExecutePluginAction, usePluginHostApi, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { TriageDetailSurfaceInputV1, TriageSessionHandoffInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { requestTriageSessionHandoffV1 } from '@happier-dev/triage-sources/runtime';
import { useTriageDetailRequest, useTriageDetailFixPullRequestNavigation, useTriagePostMutationCompletion, completeTriagePostMutationIfNeeded } from '@happier-dev/triage-sources/ui';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_SECURITY_ALERT_ACTION_IDS_V1 as ids,
  GITHUB_DEPENDABOT_DISMISS_REASONS_V1, GITHUB_CODE_SCANNING_DISMISS_REASONS_V1,
  GithubSecurityAlertReadInputV1Schema, GithubSecurityAlertReadResultV1Schema,
  GithubCodeScanningLocationsInputV1Schema, GithubCodeScanningLocationsResultV1Schema,
  GithubCodeScanningLocationInputV1Schema, GithubCodeScanningLocationResultV1Schema,
  GithubDependabotDismissInputV1Schema, GithubDependabotReopenInputV1Schema,
  GithubCodeScanningDismissInputV1Schema, GithubCodeScanningReopenInputV1Schema,
  GithubSecurityAlertMutationResultV1Schema,
  type GithubSecurityAlertReadResultV1,
  type GithubCodeScanningInstanceV1, type GithubCodeScanningLocationResultV1,
} from '../../triage/securityAlerts/actionContracts.js';
import { useGithubPagedWalk, useGithubSettledRead, type GithubPageReaderV1 } from '../detail/panelReaders.js';
import { githubMutationMayHaveChangedProviderStateV1, projectGithubMutationOutcomeV1 } from '../detail/mutations.js';
import { dispatchFailure } from '../detail/readBoundary.js';

const INVALID: TriageSourceFailureV1 = Object.freeze({ class: 'unsupportedContract', code: 'github-security-alert-result-unreadable' });
const TARGET_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({ class: 'unsupportedContract', code: 'github-security-alert-target-unavailable' });
type Unavailable = Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;
type ResultSchema<T> = Readonly<{ safeParse: (value: unknown) => { success: false } | { success: true; data: T | Unavailable } }>;
type Activity = ReturnType<typeof useTabPanelActivity>;
type AlertValue = Extract<GithubSecurityAlertReadResultV1, { kind: 'alert' }>;
type Snippet = Extract<GithubCodeScanningLocationResultV1, { kind: 'location' }>;
/** Carries the provider page needed to validate this exact instance again. */
export type GithubSecurityAlertLocationRowV1 = Readonly<{ location: GithubCodeScanningInstanceV1; continuation: string | null }>;

/** Reuses the detail owner's cancellation, retained content and explicit refresh. */
function useNativeRead<T extends AlertValue | Snippet>(localId: string, payload: JsonValue | null, schema: ResultSchema<T>, activity: Activity) {
  const action = useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId }), [localId]);
  const { execute } = useExecutePluginAction(action);
  const read = useCallback(async (signal: AbortSignal) => {
    if (payload === null) return { kind: 'failed' as const, failure: TARGET_UNAVAILABLE };
    const execution = await execute(payload, { signal });
    if (execution.status !== 'success') return { kind: 'failed' as const, failure: dispatchFailure(execution, 'github-security-alert-read-failed') };
    const parsed = schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: INVALID };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'ready' as const, value: parsed.data };
  }, [execute, payload, schema]);
  return useGithubSettledRead(read, activity.active, activity.activeSignal, { retain: true });
}

/**
 * Mount once at selected-alert detail lifetime; pass the same controller to
 * Overview and Actions. Locations and snippets are demanded only by their panel.
 * It owns no timer, persisted file cache, credential or alternate session launcher.
 */
export function useGithubSecurityAlertDetail(input: TriageDetailSurfaceInputV1, options: Readonly<{
  activity?: Activity;
  locationsActive?: boolean;
}> = {}) {
  const tabActivity = useTabPanelActivity();
  const host = usePluginHostApi();
  const fixPullRequestNavigation = useTriageDetailFixPullRequestNavigation();
  const activity = options.activity ?? tabActivity;
  const request = useTriageDetailRequest(input);
  const routingToken = input.observation.locator.routingToken;
  const target = useMemo(() => ({ v: 1 as const, ...request, routingToken }), [request, routingToken]);
  const detailPayload = useMemo(() => {
    const parsed = GithubSecurityAlertReadInputV1Schema.safeParse(target);
    return parsed.success ? parsed.data : null;
  }, [target, input.observation.sourceUpdatedAtMs, input.observation.snapshot.state.presentation, input.observation.snapshot.state.nativeLabel]);
  const detail = useNativeRead<AlertValue>(ids.read, detailPayload, GithubSecurityAlertReadResultV1Schema, activity);
  const locationsActivity = { ...activity, active: activity.active && request.localRef.kindId === 'code-scanning-alert'
    && (options.locationsActive ?? input.panel === 'locations') };
  const locationAction = useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId: ids.listLocations }), []);
  const { execute: executeLocations } = useExecutePluginAction(locationAction);
  // Native GitHub list-instances contract admits at most 100 rows per page.
  const pageLimit = 100;
  const readPage: GithubPageReaderV1<GithubSecurityAlertLocationRowV1> = useCallback(async (continuation, signal) => {
    const parsedInput = GithubCodeScanningLocationsInputV1Schema.safeParse({ ...target, limit: pageLimit, ...(continuation === null ? {} : { continuation }) });
    if (!parsedInput.success) return { kind: 'failed', failure: TARGET_UNAVAILABLE };
    const execution = await executeLocations(parsedInput.data, { signal });
    if (execution.status !== 'success') return { kind: 'failed', failure: dispatchFailure(execution, 'github-security-alert-read-failed') };
    const parsed = GithubCodeScanningLocationsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed', failure: INVALID };
    if (parsed.data.kind === 'unavailable') return { kind: 'failed', failure: parsed.data.failure };
    return { kind: 'page', page: { rows: parsed.data.rows.map(location => ({ location, continuation })),
      continuation: parsed.data.continuation ?? null, incomplete: parsed.data.incomplete ?? null, omittedRowCount: 0, projectionTruncated: false } };
  }, [executeLocations, target]);
  const locations = useGithubPagedWalk(readPage, detailPayload !== null, TARGET_UNAVAILABLE, null,
    { activity: locationsActivity, authority: target });
  const [selection, setSelection] = useState<Readonly<{ target: typeof target; row: GithubSecurityAlertLocationRowV1 }> | null>(null);
  const selectedLocation = selection?.target === target ? selection.row : null;
  const selectLocation = useCallback((row: GithubSecurityAlertLocationRowV1) => {
    // Only admitted rows from this selected alert's mounted walk can be selected.
    if (locations.state.rows.includes(row)) setSelection({ target, row });
  }, [locations.state.rows, target]);
  const snippetPayload = useMemo(() => {
    if (selectedLocation === null) return null;
    const parsed = GithubCodeScanningLocationInputV1Schema.safeParse({ ...target, limit: pageLimit,
      selectedInstance: selectedLocation.location, ...(selectedLocation.continuation === null ? {} : { continuation: selectedLocation.continuation }) });
    return parsed.success ? parsed.data : null;
  }, [selectedLocation, target]);
  const snippet = useNativeRead<Snippet>(ids.readLocation, snippetPayload, GithubCodeScanningLocationResultV1Schema,
    { ...locationsActivity, active: locationsActivity.active && selectedLocation !== null });
  const mutationKind = request.localRef.kindId === 'dependabot-alert' ? 'dependabot-alert' : 'code-scanning-alert';
  const dismissAction = useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId: mutationKind === 'dependabot-alert' ? ids.dismissDependabot : ids.dismissCodeScanning }), [mutationKind]);
  const reopenAction = useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId: mutationKind === 'dependabot-alert' ? ids.reopenDependabot : ids.reopenCodeScanning }), [mutationKind]);
  const dismissDispatch = useExecutePluginAction(dismissAction);
  const reopenDispatch = useExecutePluginAction(reopenAction);
  const complete = useTriagePostMutationCompletion();
  const [settlement, setSettlement] = useState<Readonly<{ target: typeof target; outcome: ReturnType<typeof projectGithubMutationOutcomeV1> }> | null>(null);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const writing = useRef(false);
  const runMutation = useCallback(async (kind: 'dismiss' | 'reopen', reason?: string, comment?: string) => {
    if (!activity.active || activity.activeSignal.aborted || writing.current || detailPayload === null) return;
    const dependency = request.localRef.kindId === 'dependabot-alert';
    const schema = kind === 'dismiss' ? dependency ? GithubDependabotDismissInputV1Schema : GithubCodeScanningDismissInputV1Schema
      : dependency ? GithubDependabotReopenInputV1Schema : GithubCodeScanningReopenInputV1Schema;
    const parsed = schema.safeParse({ ...target, ...(kind === 'dismiss' ? { reason, ...(comment === undefined ? {} : { comment }) } : {}) });
    if (!parsed.success) return;
    writing.current = true;
    try {
      const execution = await (kind === 'dismiss' ? dismissDispatch.execute : reopenDispatch.execute)(parsed.data, { signal: activity.activeSignal });
      if (activity.activeSignal.aborted || currentTarget.current !== target) return;
      const result = execution.status === 'success' ? GithubSecurityAlertMutationResultV1Schema.safeParse(execution.result) : null;
      const projected = projectGithubMutationOutcomeV1(execution, result?.success ? result.data : null);
      setSettlement({ target, outcome: projected });
      await completeTriagePostMutationIfNeeded(complete, execution, () => githubMutationMayHaveChangedProviderStateV1(projected));
    } finally { writing.current = false; }
  }, [activity.active, activity.activeSignal, complete, detailPayload, dismissDispatch.execute, reopenDispatch.execute, request.localRef.kindId, target]);
  const dismiss = useCallback((reason: string, comment?: string) => runMutation('dismiss', reason, comment), [runMutation]);
  const reopen = useCallback(() => runMutation('reopen'), [runMutation]);
  const fix = useCallback((choices: Pick<TriageSessionHandoffInputV1, 'configuredActionId' | 'sessionChoice' | 'agentChoice' | 'delivery'>) => {
    if (!activity.active || activity.activeSignal.aborted || detailPayload === null) return undefined;
    const entry = { entryRef: input.observation.entryRef, sourceInstanceId: input.instance.instance.sourceInstanceId };
    return requestTriageSessionHandoffV1(host, { ...choices, task: 'fix', context: { kind: 'entry', entry }, evidence: [{ kind: 'alertEntry', entry }] }, { signal: activity.activeSignal });
  }, [activity.active, activity.activeSignal, detailPayload, host, input.observation.entryRef, input.instance.instance.sourceInstanceId]);
  return { detail, locations, selectedLocation, selectLocation, snippet,
    fix,
    fixPullRequest: request.localRef.kindId === 'dependabot-alert' ? fixPullRequestNavigation : null,
    mutations: { dismiss, reopen, outcome: settlement?.target === target ? settlement.outcome : null,
      reasons: request.localRef.kindId === 'dependabot-alert' ? GITHUB_DEPENDABOT_DISMISS_REASONS_V1 : GITHUB_CODE_SCANNING_DISMISS_REASONS_V1,
      canDismiss: detail.state.kind === 'ready' && detail.state.value.detail.nativeState === 'open',
      canReopen: detail.state.kind === 'ready' && (detail.state.value.detail.nativeState === 'dismissed'
        || (request.localRef.kindId === 'dependabot-alert' && detail.state.value.detail.nativeState === 'auto_dismissed')),
      pending: dismissDispatch.execution.status === 'pending' || reopenDispatch.execution.status === 'pending' } };
}

export type GithubSecurityAlertControllerV1 = ReturnType<typeof useGithubSecurityAlertDetail>;
