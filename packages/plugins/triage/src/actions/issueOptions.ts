import { PluginError, type DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import {
  readTriageConfiguredSourceDisplayLabelV1,
  TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageActionIdV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSessionHandoffChoicesV1Schema,
  TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { TRIAGE_ISSUE_WATCH_SOURCES_V1, triageIssueWatchOptionIdsV1 } from '@happier-dev/triage-sources/runtime';

type ReadOptions = PluginDynamicResourceRuntime['read'];

function optionsResource(read: ReadOptions) {
  // Watch setup runs on its watcher Machine. Its Resource reads the Account
  // through the normal read-only Action dispatcher.
  return {
    source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
    runtime: { read, observe: () => ({ dispose() {} }) },
  } as const;
}

const watchSources = Object.values(TRIAGE_ISSUE_WATCH_SOURCES_V1);

function optionsResourceId(inputTypeId: string): string {
  return `options/${inputTypeId}`;
}

export const TRIAGE_ISSUE_OPTIONS_RESOURCES = Object.fromEntries(watchSources.flatMap(source => {
  const ids = triageIssueWatchOptionIdsV1(source);
  return [
    [optionsResourceId(ids.source), optionsResource(async ({ readAction, signal }) => {
      const result = await readAction(TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1, source }, { signal });
      if (!result.ok) throw new PluginError({ code: result.errorCode });
      const read = TriageReadConfiguredSourceInstancesResultV1Schema.parse(result.result);
      if (read.kind !== 'read' || read.status !== 'complete') {
        throw new PluginError({ code: read.kind === 'read' ? read.status : read.kind });
      }
      const options = read.instances.filter(row => row.lifecycle === 'active').map(({ configured }) => ({
        value: configured.instance.sourceInstanceId,
        label: readTriageConfiguredSourceDisplayLabelV1(configured),
      }));
      const setup = read.configureSource;
      return JSON.stringify({ options, ...(setup === undefined ? {} : { emptyAction: {
        label: { key: 'plugins.triage.surface.firstRun.connectNamed', fallback: 'Connect {name}', params: { name: setup.displayName } },
        destination: setup.destination,
      } }) });
    })],
    [optionsResourceId(ids.investigation), optionsResource(async ({ query, readAction, signal }) => {
      const selected = TriageSourceInstanceIdV1Schema.safeParse(query?.draftInput?.sourceInstanceId);
      if (!selected.success) {
        throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath: 'sourceInstanceId' } });
      }
      const result = await readAction(TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1,
        { v: 1, projection: 'sessionHandoff', task: 'investigate', source }, { signal });
      if (!result.ok) throw new PluginError({ code: result.errorCode });
      const read = TriageSessionHandoffChoicesV1Schema.parse(result.result);
      if (read.kind !== 'choices') throw new PluginError({ code: read.reason });
      return JSON.stringify({ options: read.actions.map(({ label, selection }) => ({ value: selection.configuredActionId, label })) });
    })],
  ] as const;
})) satisfies NonNullable<DefinePluginInput['resources']>;

export const TRIAGE_ISSUE_INPUT_TYPES = Object.fromEntries(watchSources.flatMap(source => {
  const ids = triageIssueWatchOptionIdsV1(source);
  return [
    [ids.source, { title: 'Source', semantic: 'triageConfiguredSource',
      valueSchema: TriageSourceInstanceIdV1Schema.jsonSchema, options: { resource: optionsResourceId(ids.source) } }],
    [ids.investigation, { title: 'Configured investigation', semantic: 'triageConfiguredInvestigation',
      valueSchema: TriageActionIdV1Schema.jsonSchema, options: { resource: optionsResourceId(ids.investigation) } }],
  ] as const;
})) satisfies NonNullable<DefinePluginInput['inputTypes']>;
