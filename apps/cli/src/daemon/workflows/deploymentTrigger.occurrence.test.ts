import { describe, expect, it } from 'vitest';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { AutomationRunPluginEventTriggerEvidenceV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { AutomationSourceSelectorIdV1Schema, deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { PluginJsonValueV2Schema, WorkflowAcceptedSnapshotV1Schema, type PluginJsonValueV2 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { normalizeGithubWebhookDelivery } from '../../../../../packages/plugins/scm-github/src/observations/githubWebhookNormalization';
import { normalizeGitlabWebhookDelivery } from '../../../../../packages/plugins/scm-gitlab/src/events';
import { buildGitlabProjectCollisionScope } from '../../../../../packages/plugins/scm-gitlab/src/triage/identity';
import { normalizeGitlabConfiguredBaseUrl } from '../../../../../packages/plugins/scm-gitlab/src/triage/origin';
import { resolveDeploymentTriggerOccurrence, admitDeploymentTriggerOccurrence } from './deploymentTrigger';

const triggerId = AutomationTriggerIdSchema.parse('deployment-trigger');
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631');
function occurrence(payload: unknown, eventType = 'push') {
  const delivery = normalizeGithubWebhookDelivery({ rawBody: new TextEncoder().encode(JSON.stringify(payload)), eventType,
    providerDeliveryId: 'delivery-1', receivedAtMs: 1000 }).automationEvent;
  if (!delivery) throw new Error('Missing normalized Automation event');
  return normalizedOccurrence(delivery);
}
function normalizedOccurrence(delivery: Readonly<{
  eventRef: Pick<ReturnType<typeof AutomationRunPluginEventTriggerEvidenceV1Schema.parse>, 'eventRef'>['eventRef'];
  sourceInstanceId: string;
  occurrenceId: string;
  occurredAtMs: number;
  payload: PluginJsonValueV2;
}>) {
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
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' }, trigger: input.triggers[0], range: { kind: 'revisionRange', baseOid: push.before, headOid: push.after },
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
      pull_request: { id: 99, number: 12, merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: '2026-10-28T12:00:00Z',
        user: { id: 99, login: 'octocat', type: 'User' },
        head: { sha: 'a'.repeat(40), ref: 'preview', repo: push.repository },
        base: { ref: 'release', repo: push.repository } } }, 'pull_request');
    expect(input.evidence.payload).not.toHaveProperty('pullRequest.baseRef');
    expect(resolveDeploymentTriggerOccurrence(input)).toMatchObject({ kind: 'available', occurrence: {
      kind: 'merge', sha: 'c'.repeat(40), pullRequestNumber: 12, trigger: { branch: 'release' },
    } });
  });
  it('leaves ordinary Workflow triggers on the generic input path', () => {
    expect(resolveDeploymentTriggerOccurrence({ ...occurrence(push), triggers: undefined })).toEqual({ kind: 'unrelated' });
  });
});

describe('GitLab deployment trigger occurrence', () => {
  function gitlabOccurrence(kind: 'push' | 'merge' = 'push', baseUrl = 'https://forge.example/gitlab') {
    const payload = { project: { id: 77, path_with_namespace: 'Acme/Widgets' },
      ...(kind === 'push' ? { ref: push.ref, before: push.before, after: push.after }
        : { object_attributes: { id: 99, iid: 12, target_project_id: 77, action: 'merge', state: 'merged', merge_commit_sha: push.after } }) };
    const event = normalizeGitlabWebhookDelivery({ eventType: kind === 'push' ? 'Push Hook' : 'Merge Request Hook',
      baseUrl, providerDeliveryId: `gitlab:${kind}:delivery-1`, receivedAtMs: 1000,
      rawBody: new TextEncoder().encode(JSON.stringify(payload)) });
    if (!event) throw new Error('Expected GitLab deployment event');
    return normalizedOccurrence(event);
  }
  it.each(['push', 'merge'] as const)('retains the GitLab deployment identity and pinned %s occurrence', kind => {
    const input = gitlabOccurrence(kind);
    expect(resolveDeploymentTriggerOccurrence(input)).toMatchObject({ kind: 'available', occurrence: {
      kind, sha: push.after, repository: { kind: 'gitlab', deployment: 'https://forge.example/gitlab', repository: 'acme/widgets' },
      ...(kind === 'merge' ? { pullRequestNumber: 12 } : { range: { baseOid: push.before, headOid: push.after } }),
    } });
    expect(resolveDeploymentTriggerOccurrence({ ...input, evidence: { ...input.evidence,
      sourceInstanceId: buildGitlabProjectCollisionScope(normalizeGitlabConfiguredBaseUrl('https://other.example/gitlab')!, '77') } })).toEqual({ kind: 'refused', code: 'invalid_input' });
  });
  it('keeps branch filtering and rejects repository identities without their deployment', () => {
    const input = gitlabOccurrence();
    expect(resolveDeploymentTriggerOccurrence({ ...input, triggers: [{ triggerId, branch: 'main' }] })).toEqual({ kind: 'skipped' });
    const payload = PluginJsonValueV2Schema.parse({ repository: { repositoryId: '77', nameWithOwner: 'Acme/Widgets' },
      ref: push.ref, before: push.before, after: push.after });
    const invalid = normalizedOccurrence({ eventRef: input.evidence.eventRef, sourceInstanceId: input.evidence.sourceInstanceId,
      occurrenceId: 'delivery-2', occurredAtMs: 1000, payload });
    expect(resolveDeploymentTriggerOccurrence(invalid)).toEqual({ kind: 'refused', code: 'invalid_input' });
  });
  it('admits only the Project Source on the same GitLab deployment including its base path', async () => {
    const input = gitlabOccurrence('merge');
    const resolved = resolveDeploymentTriggerOccurrence({ ...input, triggers: [{ triggerId }] });
    expect(resolved.kind).toBe('available');
    if (resolved.kind !== 'available') return;
    const environment = createDeploymentEnvironmentHeaderV1();
    const targetLink = createDeploymentTargetLinkHeaderV1();
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy', input: {} }] };
    const snapshot = WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', definition, authoredDefinition: definition,
      metadata: null, workDepth: 0, frozenChildren: {}, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a',
      executionTarget: { kind: 'detached_run' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      materializedLeaves: [{ sourceKey: '$root', blockId: 'deploy', kind: 'action', actionId: 'deployments.deploy', selection: {},
        authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' },
        actionInput: { serverId: environment.serverId, environmentId: environment.id, targetLinkId: targetLink.id,
          sha: resolved.occurrence.sha, requestKey: resolved.occurrence.requestKey },
        actionContract: freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec('deployments.deploy'))) }] });
    for (const baseUrl of ['https://forge.example/gitlab', 'https://forge.example/other', 'https://other.example/gitlab']) {
      const result = await admitDeploymentTriggerOccurrence({ occurrence: resolved.occurrence, snapshot, machineId: 'machine-a',
        context: { surface: 'cli', authority: 'account_automation' }, executor: { execute: async actionId => {
          // Home Action transport is the boundary; identity and admission remain real.
          if (actionId === 'deployments.environments.get') return { ok: true, result: { ok: true, environment, targetLinks: [targetLink] } };
          if (actionId === 'projects.sources.read') return { ok: true, result: { ok: true, canManage: true, source: {
            id: environment.projectSourceId, revision: 1, name: 'Widgets', audience: [], createdByAccountId: 'account-owner',
            repository: { provider: { id: 'happier.scm.forge.gitlab', kind: 'gitlab', displayName: 'GitLab', baseUrl },
              repository: { nameWithOwner: 'acme/widgets' }, protocol: 'https' } } } };
          throw new Error(`Unexpected Action ${actionId}`);
        } } });
      expect(result.kind).toBe(baseUrl === 'https://forge.example/gitlab' ? 'deploy' : 'refused');
      if (baseUrl !== 'https://forge.example/gitlab') expect(result).toEqual({ kind: 'refused', code: 'source_mismatch' });
    }
  });
});
