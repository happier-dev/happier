import { PluginError, type DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import {
  readTriageConfiguredSourceDisplayLabelV1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { triageIssueWatchOptionIdsV1 } from './issueSource.js';

type ReadOptions = PluginDynamicResourceRuntime['read'];

function optionsResource(read: ReadOptions) {
  // Watch setup runs on its watcher Machine. Its Resource reads the Account
  // through the normal read-only Action dispatcher.
  return {
    source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
    runtime: { read, observe: () => ({ dispose() {} }) },
  } as const;
}

/** The contributor registers its own options; Triage owns the Account reads. */
export function createTriageIssueWatchOptionsV1(source: PluginContributionIdentity) {
  const ids = triageIssueWatchOptionIdsV1(source);
  const sourceResource = `options/${ids.source}`;
  const resources = {
    [sourceResource]: optionsResource(async ({ readAction, signal }) => {
      const result = await readAction(TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1, source, purpose: 'issueWatch' }, { signal });
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
    }),
  } satisfies NonNullable<DefinePluginInput['resources']>;
  const inputTypes = {
    [ids.source]: { title: 'Source', semantic: 'triageConfiguredSource',
      valueSchema: TriageSourceInstanceIdV1Schema.jsonSchema, options: { resource: sourceResource } },
  } satisfies NonNullable<DefinePluginInput['inputTypes']>;
  return { resources, inputTypes };
}
