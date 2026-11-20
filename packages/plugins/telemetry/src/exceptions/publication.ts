import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { admitCheckpointedPluginEventObservationV1, readCurrentSourceDefinitions } from '@happier-dev/plugin-sdk/events';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  buildTriageEntryRouteSegmentV1,
  TriageIssueCommitPublishedEventSourceConfigV1Schema,
  TriageIssueTransitionV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
} from '@happier-dev/triage-protocol/v1';
import {
  createTriageIssueInvestigationChoiceReaderV1,
  publishTriageIssueTransitionV1,
  TRIAGE_ISSUE_EVENT_LOCAL_ID_V1,
} from '@happier-dev/triage-sources/runtime';
import type { ExceptionIssueTransition } from './issueWriter.js';
import {
  exceptionLocalRefV1,
  isTelemetryExceptionInstanceV1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
} from './source.js';

export const TELEMETRY_EXCEPTION_EVENT_REF_V1 = Object.freeze({
  pluginId: TELEMETRY_EXCEPTION_SOURCE_V1.pluginId,
  localId: TRIAGE_ISSUE_EVENT_LOCAL_ID_V1,
});
const DISPLAY_NAME = 'Happier exceptions';

/**
 * Post-commit publication for the collector's single issue writer (M10).
 * Each committed lifecycle transition becomes one AE observation (AE owns
 * matching and dedupe) and then goes through the shared Triage transition
 * publisher that vendor observers use. Count or last-seen changes never reach
 * here. Without a configured Happier exceptions source in this Account there is
 * nothing to address, so nothing is published; the record stays readable.
 */
export function createExceptionIssuePublisher(
  context: PluginInvocationContext,
): (transition: ExceptionIssueTransition) => Promise<void> {
  return async ({ phase, row }) => {
    const listing = TriageReadConfiguredSourceInstancesResultV1Schema.parse(
      await context.services.actions.execute(
        TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
        { v: 1 },
        { signal: context.signal },
      ),
    );
    if (listing.kind !== 'read') return;
    const instances = listing.instances.filter(
      (record) =>
        record.lifecycle === 'active' &&
        isTelemetryExceptionInstanceV1(record.configured),
    );
    for (const record of instances) {
      const sourceInstanceId = record.configured.instance.sourceInstanceId;
      const entryRef = {
        source: TELEMETRY_EXCEPTION_SOURCE_V1,
        ...exceptionLocalRefV1(row.rowId),
      };
      const transition = TriageIssueTransitionV1Schema.parse({
        phase,
        sourceInstanceId,
        issueFingerprint: row.rowId,
        issueRef: buildTriageEntryRouteSegmentV1(entryRef),
        providerUpdatedAt: row.value.updatedAtMs,
        // App-derived (redacted) text travels only as alert evidence, which the handoff frames as data.
        evidence: {
          v: 1,
          items: [
            {
              source: { kind: 'alert', label: DISPLAY_NAME },
              author: { kind: 'unknown' },
              text: row.value.title,
            },
          ],
        },
      });
      // The committed revision identifies this transition; a replay rejoins the same AE occurrence.
      const occurrenceId = `${sourceInstanceId}:${row.rowId}:${row.revision}`;
      const disposition = await admitCheckpointedPluginEventObservationV1(
        {
          eventRef: TELEMETRY_EXCEPTION_EVENT_REF_V1,
          sourceInstanceId,
          sourceContractVersion: 1,
          occurrenceId,
          occurredAt: row.value.updatedAtMs,
          observationReceivedAt: Date.now(),
          observedDelta: 1,
          payload: projectNativeJsonValueForTransport(transition),
        },
        context,
      );
      // Auto-start follows the investigation mode each admitting Workflow trigger chose at setup.
      const key = (selector: Readonly<{ automationId: string; triggerId: string; triggerRevision: number; sourceSelectorId: string }>) =>
        JSON.stringify([selector.automationId, selector.triggerId, selector.triggerRevision, selector.sourceSelectorId]);
      const admitted = new Set((disposition.admissions ?? []).filter(admission => admission.observation.occurrenceId === occurrenceId
        && (admission.result.kind === 'admitted' || admission.result.kind === 'rejoined')).map(admission => key(admission.definition)));
      let configuredActionId: string | undefined;
      if (admitted.size > 0) {
        const catalog = await readCurrentSourceDefinitions(context, { kind: 'checkpointedPull', source: {
          eventRef: TELEMETRY_EXCEPTION_EVENT_REF_V1, sourceInstanceId, sourceContractVersion: 1 } });
        for (const definition of catalog?.definitions ?? []) {
          if (!admitted.has(key(definition))) continue;
          const config = TriageIssueCommitPublishedEventSourceConfigV1Schema.safeParse(definition.sourceConfig);
          if (config.success && config.data.investigation.mode === 'auto_start') {
            configuredActionId = config.data.investigation.configuredActionId;
            break;
          }
        }
      }
      await publishTriageIssueTransitionV1(context, {
        providerDisplayName: DISPLAY_NAME,
        sourceInstanceId,
        transition,
        occurrenceId,
        entryRef,
        title: row.value.title,
        ...(configuredActionId === undefined
          ? {}
          : {
              autoStart: {
                configuredActionId,
                choices: createTriageIssueInvestigationChoiceReaderV1(context, TELEMETRY_EXCEPTION_SOURCE_V1),
              },
            }),
      });
    }
  };
}
