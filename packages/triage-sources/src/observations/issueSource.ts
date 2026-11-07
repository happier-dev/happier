import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { readTriageSessionHandoffChoicesV1 } from '../sessionHandoff.js';
import {
  TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageIssueEventSetupInputV1Schema, TriageIssueEventSourceConfigV1Schema,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
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

/** The existing shared Action Fields renders these inputs; no source-local form. */
export const TRIAGE_ISSUE_EVENT_SETUP_INPUT_HINTS_V1 = {
  fields: [{
    path: 'sourceInstanceId', title: 'Source',
    description: 'The configured PRs & Issues source to watch.', widget: 'text' as const, required: true,
  }, {
    path: 'checkPeriodSeconds', title: 'Check every (seconds)',
    description: 'Default: 300 seconds (5 minutes). Provider rate limits may delay a check.',
    widget: 'number' as const, defaultValue: 300,
  }, {
    path: 'investigation.mode', title: 'When an issue opens', widget: 'select' as const,
    defaultValue: 'inbox', options: [{ value: 'inbox', label: 'Show in Inbox' },
      { value: 'auto_start', label: 'Start an investigation' }],
  }, {
    path: 'investigation.configuredActionId', title: 'Configured investigation', widget: 'text' as const,
    description: 'Choose an existing investigate Action configured in PRs & Issues.',
    visibleWhen: { op: 'eq' as const, path: 'investigation.mode', value: 'auto_start' },
    requiredWhen: { op: 'eq' as const, path: 'investigation.mode', value: 'auto_start' },
  }],
};

/** Resolve the source through its current target-owned row; opening setup writes nothing. */
export function createTriageIssueEventSourceSetupV1(input: Readonly<{ pluginId: string; sourceLocalId: string; displayName: string }>):
  (raw: unknown, context: PluginInvocationContext) => Promise<JsonValue> {
  return async (raw: unknown, context: PluginInvocationContext) => {
    const selected = TriageIssueEventSetupInputV1Schema.parse(raw);
    const listing = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await context.services.actions.execute(
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1 }, { signal: context.signal },
    ));
    context.signal.throwIfAborted();
    const candidates = listing.kind === 'read' && listing.status === 'complete'
      ? listing.instances.filter(record => record.lifecycle === 'active'
        && record.configured.instance.sourceInstanceId === selected.sourceInstanceId
        && record.configured.instance.source.pluginId === input.pluginId
        && record.configured.instance.source.localId === input.sourceLocalId)
      : [];
    const instance = candidates.length === 1
      ? TriageConfiguredSourceConnectedAccountInstanceV1Schema.safeParse(candidates[0]!.configured)
      : null;
    if (!instance?.success) throw new PluginError({ code: 'triage_issue_source_unavailable', message: 'Choose a currently configured source.' });
    if (selected.investigation?.mode === 'auto_start') {
      const choices = await readTriageSessionHandoffChoicesV1({ executeAction: (ref, args, options) =>
        context.services.actions.execute(ref, args, options) }, { task: 'investigate', signal: context.signal });
      context.signal.throwIfAborted();
      const configuredActionId = selected.investigation.configuredActionId;
      if (choices.kind !== 'choices' || !choices.actions.some(action => action.selection.configuredActionId === configuredActionId)) {
        throw new PluginError({ code: 'triage_issue_investigation_unavailable', message: 'Choose a currently configured investigate Action.' });
      }
    }
    const sourceConfig = TriageIssueEventSourceConfigV1Schema.parse({
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
