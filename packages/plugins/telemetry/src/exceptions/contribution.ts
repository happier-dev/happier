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
  createTriageIssueWatchOptionsV1,
  createTriageIssueEventSetupInputHintsV1,
  TRIAGE_ISSUE_EVENT_LOCAL_ID_V1,
  TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1,
  TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1,
} from '@happier-dev/triage-sources/runtime';
import { exceptionActions } from './actions.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 } from './issueRecord.js';
import {
  TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1,
  TELEMETRY_EXCEPTION_ISSUE_WATCH_V1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
} from './source.js';
import { TELEMETRY_EXCEPTION_SOURCE_ACTIONS, TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS } from './sourceActions.js';

const protocol = TriageSourcesContributionProtocolV1;
const surfaces = ['plugin', 'ui', 'agent', 'mcp', 'cli'] as const;

/** D30 native exceptions: one Account collection, one commit-published event, one public Triage source contribution. */
export const telemetryExceptionManifestParts = {
  ...createTriageIssueWatchOptionsV1(TELEMETRY_EXCEPTION_SOURCE_V1),
  actions: {
    ...exceptionActions,
    ...TELEMETRY_EXCEPTION_SOURCE_ACTIONS,
    [TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1]: {
      surfaces,
      scopes: ['global'] as const,
      execution: { target: 'daemon' as const },
      title: 'Watch Happier exceptions',
      dangerLevel: 'safe' as const,
      description:
        'Prepares the configured Happier exceptions source for issue alerts without changing it.',
      inputSchema: TriageIssueEventSetupInputV1Schema.jsonSchema,
      inputHints: createTriageIssueEventSetupInputHintsV1(TELEMETRY_EXCEPTION_SOURCE_V1, TELEMETRY_EXCEPTION_ISSUE_WATCH_V1),
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(
        1,
        TriageIssueCommitPublishedEventSourceConfigV1Schema.jsonSchema,
      ),
      run: createTriageIssueEventSourceSetupV1({
        pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId,
        sourceLocalId: TELEMETRY_EXCEPTION_SOURCE_V1.localId,
        displayName: 'Happier exceptions',
        ...TELEMETRY_EXCEPTION_ISSUE_WATCH_V1,
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
        listInstances: protocol.operations.listInstances.bind(TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.listInstances),
        scan: protocol.operations.scan.bind(TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.scan),
        get: protocol.operations.get.bind(TELEMETRY_EXCEPTION_SOURCE_ACTION_IDS.get),
      },
      surfaces: { detail },
    }),
  } } };
}
