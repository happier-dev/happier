import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import {
  TriageIssueCommitPublishedEventSourceConfigV1Schema,
  TriageIssueEventSetupInputV1Schema,
  TriageIssueTransitionV1Schema,
  TriageSourcesContributionProtocolV1,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import {
  createTriageIssueEventSourceSetupV1,
  TRIAGE_ISSUE_COMMIT_EVENT_SETUP_INPUT_HINTS_V1,
  TRIAGE_ISSUE_EVENT_LOCAL_ID_V1,
  TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1,
  TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1,
} from '@happier-dev/triage-sources/runtime';
import { exceptionActions } from './actions.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from './issueRecord.js';
import {
  getTelemetryException,
  scanTelemetryExceptions,
  TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1,
  TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
} from './source.js';

const protocol = TriageSourcesContributionProtocolV1;
const surfaces = ['plugin', 'ui', 'agent', 'mcp', 'cli'] as const;
// Source reads run on any of the reader's own Machines: they read Account data, never collector raw data.
const read = {
  surfaces,
  scopes: ['global'] as const,
  execution: { target: 'daemon' as const },
  dangerLevel: 'safe' as const,
  readOnly: true,
};
const ids = {
  listInstances: 'exceptions/list-instances-v1',
  scan: 'exceptions/scan-v1',
  get: 'exceptions/get-v1',
} as const;

/** D30 native exceptions: one Account collection, one commit-published event, one public Triage source contribution. */
export const telemetryExceptionManifestParts = {
  actions: {
    ...exceptionActions,
    [ids.listInstances]: {
      ...read,
      title: 'Discover Happier exceptions',
      description:
        'Discover the built-in Happier exceptions source for PRs & Issues setup.',
      inputSchema: protocol.operations.listInstances.declaration.input.schema,
      resultSchema: protocol.operations.listInstances.declaration.resultSchema,
      run: async () => ({
        kind: 'complete' as const,
        candidates: [TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1],
        failures: [],
      }),
    },
    [ids.scan]: {
      ...read,
      title: 'Read Happier exceptions',
      description:
        'Read native exception issues in this Account and those a Team shared with it, without collector occurrences.',
      inputSchema: protocol.operations.scan.declaration.input.schema,
      resultSchema: protocol.operations.scan.declaration.resultSchema,
      run: (input: unknown, context: PluginInvocationContext) =>
        scanTelemetryExceptions(
          protocol.operations.scan.declaration.input.schema.parse(input),
          context,
        ),
    },
    [ids.get]: {
      ...read,
      title: 'Read a Happier exception',
      description:
        'Read one exact native exception issue, including one a Team shared with this Account.',
      inputSchema: protocol.operations.get.declaration.input.schema,
      resultSchema: protocol.operations.get.declaration.resultSchema,
      run: (input: unknown, context: PluginInvocationContext) =>
        getTelemetryException(
          protocol.operations.get.declaration.input.schema.parse(input),
          context,
        ),
    },
    [TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1]: {
      surfaces,
      scopes: ['global'] as const,
      execution: { target: 'daemon' as const },
      title: 'Watch Happier exceptions',
      dangerLevel: 'safe' as const,
      description:
        'Prepares the configured Happier exceptions source for issue alerts without changing it.',
      inputSchema: TriageIssueEventSetupInputV1Schema.jsonSchema,
      inputHints: TRIAGE_ISSUE_COMMIT_EVENT_SETUP_INPUT_HINTS_V1,
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(
        1,
        TriageIssueCommitPublishedEventSourceConfigV1Schema.jsonSchema,
      ),
      run: createTriageIssueEventSourceSetupV1({
        pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId,
        sourceLocalId: TELEMETRY_EXCEPTION_SOURCE_V1.localId,
        displayName: 'Happier exceptions',
        publication: 'commit',
      }),
    },
  },
  accountCollections: {
    [TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1.id]:
      TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
  },
  notifications: {
    [TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1]: {
      kind: 'plugin' as const,
      title: 'Exception alerts',
      eventIds: [TRIAGE_ISSUE_EVENT_LOCAL_ID_V1],
    },
  },
  events: {
    [TRIAGE_ISSUE_EVENT_LOCAL_ID_V1]: {
      declaration: {
        kind: 'event' as const,
        title: 'Happier exception issue changed',
        description:
          'A native exception issue opened, regressed or was resolved. Occurrence counts never fire it.',
        payloadSchema: TriageIssueTransitionV1Schema.jsonSchema,
        automation: {
          v: 1 as const,
          eligible: true as const,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull' as const],
            sourceConfigSchema:
              TriageIssueCommitPublishedEventSourceConfigV1Schema.jsonSchema,
            setupActionRef: {
              pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId,
              localId: TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1,
            },
          },
        },
      },
    },
  },
};

/**
 * The public Triage source contribution. The protocol requires a detail
 * renderer, which is UI composition owned by the Triage/Insights UI owners (U5):
 * they add this to the manifest's `contributesTo` together with that renderer
 * artifact, so no half-declared source ever loads.
 */
export function telemetryExceptionSourceContribution(detail: Readonly<{ renderer: string; fallbackRenderers?: readonly string[] }>) {
  return { [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: { [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
    [TELEMETRY_EXCEPTION_SOURCE_V1.localId]: protocol.contribute({
      descriptor: TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1,
      operations: {
        listInstances: protocol.operations.listInstances.bind(ids.listInstances),
        scan: protocol.operations.scan.bind(ids.scan),
        get: protocol.operations.get.bind(ids.get),
      },
      surfaces: { detail },
    }),
  } } };
}
