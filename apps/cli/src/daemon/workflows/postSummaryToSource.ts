import type { ActionExecutor, ActionExecutorContext, JsonValue } from '@happier-dev/protocol';
import { resolveGithubPostSummaryTargetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerPostSummaryV1';
import {
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  TriageReadConfiguredSourceInstancesResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

export type WorkflowPostSummaryEventOccurrence = Readonly<{
  eventRef: Readonly<{ pluginId: string; localId: string }>;
  sourceInstanceId: string;
  payload: JsonValue;
}>;

export type WorkflowPostSummaryOutcome =
  | Readonly<{ kind: 'skipped'; reason: 'disabled' | 'unsupported_source' | 'empty_summary' }>
  | Readonly<{ kind: 'posted' }>
  | Readonly<{ kind: 'failed'; code: string }>;

function formatSummaryBody(finalResult: JsonValue | undefined): string | null {
  if (typeof finalResult === 'string') {
    const trimmed = finalResult.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (finalResult !== undefined && finalResult !== null) {
    const serialized = JSON.stringify(finalResult, null, 2).trim();
    return serialized.length > 0 ? serialized : null;
  }
  return null;
}

/**
 * Q11: Opt-in summary posting to an authorized connected GitHub issue/PR source.
 * Uses the existing provider comment Action (`happier.scm.github/github/comment/create`)
 * through the canonical Action executor so the rule's approval profile applies unchanged.
 * Pure internal Task triggers and non-GitHub events return `unsupported_source` with zero writes.
 */
export async function postWorkflowRunSummaryToAuthorizedSource(input: Readonly<{
  enabled: boolean;
  occurrence: WorkflowPostSummaryEventOccurrence | undefined;
  finalResult: JsonValue | undefined;
  actionExecutor: Pick<ActionExecutor, 'execute'>;
  context: ActionExecutorContext;
}>): Promise<WorkflowPostSummaryOutcome> {
  if (!input.enabled) return { kind: 'skipped', reason: 'disabled' };
  if (!input.occurrence) return { kind: 'skipped', reason: 'unsupported_source' };
  const target = resolveGithubPostSummaryTargetV1(input.occurrence);
  if (!target) return { kind: 'skipped', reason: 'unsupported_source' };
  const body = formatSummaryBody(input.finalResult);
  if (!body) return { kind: 'skipped', reason: 'empty_summary' };

  const configuredRead = await input.actionExecutor.execute('action.invoke', {
    action: TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    input: { v: 1 },
  }, input.context);
  if (!configuredRead.ok) return { kind: 'failed', code: configuredRead.errorCode };
  const listing = TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(configuredRead.result);
  if (!listing.success || listing.data.kind !== 'read') {
    return { kind: 'failed', code: 'source_unavailable' };
  }
  const matched = listing.data.instances.find((record) =>
    record.lifecycle === 'active'
    && record.configured.instance.sourceInstanceId === target.sourceInstanceId
    && record.configured.instance.source.pluginId === target.pluginId,
  );
  if (!matched) return { kind: 'failed', code: 'source_unavailable' };

  const posted = await input.actionExecutor.execute('action.invoke', {
    action: { pluginId: target.pluginId, localId: target.actionLocalId },
    input: {
      v: 1,
      instance: matched.configured,
      localRef: target.localRef,
      routingToken: target.routingToken,
      body,
    },
  }, input.context);
  return posted.ok ? { kind: 'posted' } : { kind: 'failed', code: posted.errorCode };
}
