import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { readTriageSessionHandoffChoicesV1 } from '../sessionHandoff.js';
import {
  TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageConfiguredSourceInstanceV1Schema,
  TriageIssueCommitPublishedEventSourceConfigV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageIssueEventSetupInputV1Schema, TriageIssueEventSourceConfigV1Schema,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

export {
  TriageIssueInvestigationV1Schema, TriageIssueEventSetupInputV1Schema,
  TriageIssueEventSourceConfigV1Schema, TriageIssueTransitionV1Schema,
} from '@happier-dev/triage-protocol/v1';
export type { TriageIssueEventSourceConfigV1, TriageIssueTransitionV1 } from '@happier-dev/triage-protocol/v1';

/** AM-3's visible, person-changeable sampling default; not a provider quota. */
export const TRIAGE_ISSUE_DEFAULT_CHECK_PERIOD_MS_V1 = 300_000;
export const TRIAGE_ISSUE_EVENT_LOCAL_ID_V1 = 'issue-transition';
export const TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1 = 'automation/setup-issue-transition-v1';
export const TRIAGE_ISSUE_BACKGROUND_LOCAL_ID_V1 = 'issue-observer';
export const TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1 = 'issue-alerts';

/** Source identities shared by the declaring plugins and Triage's typed options. */
export const TRIAGE_ISSUE_WATCH_SOURCES_V1 = {
  sentry: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
  posthog: { pluginId: 'happier.posthog', localId: 'posthog-error-tracking' },
  telemetry: { pluginId: 'happier.telemetry', localId: 'exceptions' },
} as const;

type WatchSource = typeof TRIAGE_ISSUE_WATCH_SOURCES_V1[keyof typeof TRIAGE_ISSUE_WATCH_SOURCES_V1];

export function triageIssueWatchOptionIdsV1(source: WatchSource) {
  return { source: `issue-source/${source.localId}`, investigation: `issue-investigation/${source.localId}` } as const;
}

/** The commit-published setup uses the same fields without the polling interval. */
export function createTriageIssueEventSetupInputHintsV1(
  source: WatchSource,
  options?: Readonly<{ publication?: 'commit'; sourceDescription?: { key: string; fallback: string } }>,
) {
  const ids = triageIssueWatchOptionIdsV1(source);
  const fields = [{
    path: 'sourceInstanceId', title: 'Source',
    description: options?.sourceDescription ?? 'The configured PRs & Issues source to watch.',
    widget: 'select' as const, required: true,
    inputType: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: ids.source },
  }, {
    path: 'checkPeriodSeconds', title: 'Check every (seconds)',
    description: 'Default: 300 seconds (5 minutes). Provider rate limits may delay a check.',
    widget: 'number' as const, defaultValue: 300,
  }, {
    path: 'investigation.mode', title: 'When an issue opens', widget: 'select' as const,
    defaultValue: 'inbox', options: [{ value: 'inbox', label: 'Show in Inbox' },
      { value: 'auto_start', label: 'Start an investigation' }],
  }, {
    path: 'investigation.configuredActionId', title: 'Configured investigation', widget: 'select' as const,
    inputType: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: ids.investigation },
    description: 'Choose an existing investigate Action configured in PRs & Issues.',
    visibleWhen: { op: 'eq' as const, path: 'investigation.mode', value: 'auto_start' },
    requiredWhen: { op: 'eq' as const, path: 'investigation.mode', value: 'auto_start' },
  }];
  return { fields: options?.publication === 'commit' ? fields.filter(field => field.path !== 'checkPeriodSeconds') : fields };
}

/**
 * Resolve the source through its current target-owned row; opening setup writes nothing.
 * `publication: 'commit'` admits an Account-data source whose own writer publishes
 * committed transitions; the default polls a connected-account source.
 */
export function createTriageIssueEventSourceSetupV1(input: Readonly<{ pluginId: string; sourceLocalId: string; displayName: string;
  publication?: 'scan' | 'commit' }>):
  (raw: unknown, context: PluginInvocationContext) => Promise<JsonValue> {
  return async (raw: unknown, context: PluginInvocationContext) => {
    const selected = TriageIssueEventSetupInputV1Schema.parse(raw);
    const source = { pluginId: input.pluginId, localId: input.sourceLocalId };
    const listing = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await context.services.actions.execute(
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1, source }, { signal: context.signal },
    ));
    context.signal.throwIfAborted();
    const candidates = listing.kind === 'read' && listing.status === 'complete'
      ? listing.instances.filter(record => record.lifecycle === 'active'
        && record.configured.instance.sourceInstanceId === selected.sourceInstanceId
        && record.configured.instance.source.pluginId === input.pluginId
        && record.configured.instance.source.localId === input.sourceLocalId)
      : [];
    const commit = input.publication === 'commit';
    const configured = candidates.length === 1 ? candidates[0]!.configured : null;
    const instance = configured === null ? null : commit
      ? TriageConfiguredSourceInstanceV1Schema.safeParse(configured)
      : TriageConfiguredSourceConnectedAccountInstanceV1Schema.safeParse(configured);
    if (!instance?.success || (commit && !('source' in instance.data.binding && instance.data.binding.source === 'accountData'))
      || (commit && selected.checkPeriodSeconds !== undefined)) {
      throw new PluginError({ code: 'triage_issue_source_unavailable', message: 'Choose a currently configured source.' });
    }
    if (selected.investigation?.mode === 'auto_start') {
      const choices = await readTriageSessionHandoffChoicesV1({ executeAction: (ref, args, options) =>
        context.services.actions.execute(ref, args, options) }, { task: 'investigate', source, signal: context.signal });
      context.signal.throwIfAborted();
      const configuredActionId = selected.investigation.configuredActionId;
      if (choices.kind !== 'choices' || !choices.actions.some(action => action.selection.configuredActionId === configuredActionId)) {
        throw new PluginError({ code: 'triage_issue_investigation_unavailable', message: 'Choose a currently configured investigate Action.' });
      }
    }
    const sourceConfig = commit ? TriageIssueCommitPublishedEventSourceConfigV1Schema.parse({
      v: 1, instance: instance.data, investigation: selected.investigation ?? { mode: 'inbox' },
    }) : TriageIssueEventSourceConfigV1Schema.parse({
      v: 1, instance: instance.data,
      checkPeriodMs: selected.checkPeriodSeconds === undefined
        ? TRIAGE_ISSUE_DEFAULT_CHECK_PERIOD_MS_V1 : selected.checkPeriodSeconds * 1_000,
      investigation: selected.investigation ?? { mode: 'inbox' },
    });
    return projectNativeJsonValueForTransport(PluginEventAutomationSetupResultV1Schema.parse({
      v: 1, sourceInstanceId: selected.sourceInstanceId, sourceContractVersion: 1,
      sourceConfig, displayLabel: `${input.displayName} issues`, observationOnly: { kind: 'observationOnly' },
    }));
  };
}
