import { describe, expect, it } from 'vitest';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { AutomationRunPluginEventTriggerEvidenceV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { AutomationSourceSelectorIdV1Schema, deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { normalizeGithubWebhookDelivery } from '../../../../../packages/plugins/scm-github/src/observations/githubWebhookNormalization';
import { resolveDeploymentTriggerOccurrence } from './deploymentTrigger';

const triggerId = AutomationTriggerIdSchema.parse('deployment-trigger');
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631');
function occurrence(payload: unknown, eventType = 'push') {
  const delivery = normalizeGithubWebhookDelivery({ rawBody: new TextEncoder().encode(JSON.stringify(payload)), eventType,
    providerDeliveryId: 'delivery-1', receivedAtMs: 1000 }).automationEvent;
  if (!delivery) throw new Error('Missing normalized Automation event');
  const base = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: delivery.eventRef,
    sourceSelectorId, occurrenceId: delivery.occurrenceId, occurredAt: delivery.occurredAtMs, payload: PluginJsonValueV2Schema.parse(delivery.payload) };
  const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...base, sourceInstanceId: delivery.sourceInstanceId,
    sourceContractVersion: 1, observationReceivedAt: 1000, filter: { version: null, result: 'matched' } });
  const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
    occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: base }), occurredAt: base.occurredAt,
    evidence: { eventRef: delivery.eventRef, sourceSelectorId } });
  return { cause, evidence, triggers: [{ triggerId, branch: 'release' }] };
}
const push = { repository: { id: 77, full_name: 'acme/widgets' }, ref: 'refs/heads/release', before: 'a'.repeat(40), after: 'b'.repeat(40) };

describe('normalized deployment trigger occurrence', () => {
  it('pins the real normalized push SHA and canonical admitted occurrence identity', () => {
    const input = occurrence({ ...push, environmentId: 'foreign', command: 'untrusted' });
    expect(resolveDeploymentTriggerOccurrence(input)).toEqual({ kind: 'available', occurrence: {
      kind: 'push', sha: push.after, requestKey: input.cause.kind === 'trigger' ? input.cause.occurrenceKey : '',
      repository: 'acme/widgets', trigger: input.triggers[0], range: { kind: 'revisionRange', baseOid: push.before, headOid: push.after },
    } });
  });
  it('settles unrelated branches and deleted refs from producer facts without reading deployment or Git state', () => {
    for (let index = 0; index < 1000; index += 1) {
      expect(resolveDeploymentTriggerOccurrence(occurrence({ ...push, ref: `refs/heads/topic-${index}` }))).toEqual({ kind: 'skipped' });
    }
    expect(resolveDeploymentTriggerOccurrence(occurrence({ ...push, after: '0'.repeat(40) }))).toEqual({ kind: 'skipped' });
  });
  it('keeps branch-creation history unknown and rejects mismatched admitted evidence', () => {
    const input = occurrence({ ...push, before: '0'.repeat(40) });
    expect(resolveDeploymentTriggerOccurrence(input)).toMatchObject({ kind: 'available', occurrence: { sha: push.after } });
    const result = resolveDeploymentTriggerOccurrence(input);
    if (result.kind === 'available') expect(result.occurrence.range).toBeUndefined();
    expect(resolveDeploymentTriggerOccurrence({ ...input, evidence: { ...input.evidence, payload: { ...push, after: 'c'.repeat(40) } } }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(resolveDeploymentTriggerOccurrence({ ...input, evidence: { ...input.evidence, sourceInstanceId: 'github:repository:88' } }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
  });
  it('uses the merge event SHA and PR number without inventing its absent base branch', () => {
    const input = occurrence({ action: 'closed', repository: push.repository,
      pull_request: { id: 99, number: 12, merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: '2026-10-28T12:00:00Z' } }, 'pull_request');
    expect(resolveDeploymentTriggerOccurrence(input)).toMatchObject({ kind: 'available', occurrence: {
      kind: 'merge', sha: 'c'.repeat(40), pullRequestNumber: 12, trigger: { branch: 'release' },
    } });
  });
  it('leaves ordinary Workflow triggers on the generic input path', () => {
    expect(resolveDeploymentTriggerOccurrence({ ...occurrence(push), triggers: undefined })).toEqual({ kind: 'unrelated' });
  });
});
