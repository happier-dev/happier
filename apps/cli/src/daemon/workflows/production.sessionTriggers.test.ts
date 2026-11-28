import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, admitAgentStartV1,
  AutomationTriggerIdSchema, AutomationSourceSelectorIdV1Schema, deriveAutomationOccurrenceKeyV1, PluginJsonValueV2Schema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import * as scm from '@/scm/readWorktreeChangeFingerprint';
import { runScmCommand, createHostScmCommandRunner } from '@/scm/runtime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { realizeWorkspaceCheckoutWithScmWorkspaceSource } from '@/scm/workspace/workspaceCheckoutOperations';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createProductionWorkflowRunCoordinator, type WorkflowProductionExecutionDeps } from './production';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { prepareWorkflowAcceptedWorkspaceTarget } from './resolveWorkflowWorkspace';
import type { WorkflowClaimForCoordination } from './worker';
import { AutomationRunPluginEventTriggerEvidenceV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { normalizeGithubWebhookDelivery } from '../../../../../packages/plugins/scm-github/src/observations/githubWebhookNormalization';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { resolvePreviewWorkflowForHost } from '@/deployments/previewWorkflowForHost';
import { ScmHostingPullRequestLifecycleV1Schema } from '@happier-dev/protocol/scm/pullRequestLifecycleV1';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const previousRunId = '1d4dd16c-d69b-4115-a3b0-e3c92f47f3bd';
const accountId = 'account-1';
const machineId = 'machine-1';
const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const project = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
const captured = new Error('accepted_snapshot_captured');
const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
}, blocks: [{ kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };

function execution(): WorkflowProductionExecutionDeps {
  return { credentials: { token: 'token', encryption: null }, serverId: 'server-1',

    machineAdmissionTransport: async () => { throw new Error('No session effect before acceptance'); },
    resolveExistingSessionConversation: async () => { throw new Error('No conversation effect before acceptance'); },
    detachedRun: { actionExecutor: { execute: async () => { throw new Error('No detached effect before acceptance'); } },
      buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
  };
}

function claim(source: WorkflowDefinitionV1, previous?: string): WorkflowClaimForCoordination {
  return { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1', scopeSessionId: 'origin-session',
    causeWorkDepth: 0, accountCurrentness: witness, automationCause: { kind: 'manual', invokedAt: 1 },
    ...(previous ? { lastSucceededRun: { runId: previousRunId, checkpointEnvelope: previous } } : {}),
    definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: source,
      workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } }),
  };
}

function previousCheckpoint(endFingerprint?: string) {
  // Deliberately construct the old/new wire bytes, including an absent value.
  return JSON.stringify({ t: 'plain', v: { v: 2, binding: { v: 1, purpose: 'checkpoint', accountId, runId: previousRunId },
    content: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'previous-root', nextSequence: '1',
      frontier: { nextBlockOrdinal: 1, paused: false }, ...(endFingerprint ? { endFingerprint } : {}) } } });
}

function admissionHarness(prepareWorkspace: typeof prepareWorkflowAcceptedWorkspaceTarget = async () => ({ ok: true, workspaceTarget: { project } }),
  resolveDeploymentPreviewWorkflow?: Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveDeploymentPreviewWorkflow'],
  workspaceTransport?: Readonly<{
    resolveCurrentWorkspaceRefs: () => Promise<readonly ManagedWorkspaceRefV2[]>;
    restoreManagedWorkspaceSource: () => Promise<WorkspaceSource | null>;
  }>,
) {
  const snapshots: unknown[] = [];
  const acceptedEnvelopes: string[] = [];
  const effects: string[] = [];
  const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    resolveAccountEncryption: async () => ({ kind: 'available', witness }), isAcceptedAuthorizationCurrent: async () => true,
    execution: execution(), onCommittedTransition: () => {},
    prepareAcceptedWorkspaceTarget: prepareWorkspace,
    ...workspaceTransport,
    ...(resolveDeploymentPreviewWorkflow ? { resolveDeploymentPreviewWorkflow } : {}),
    resolveMaterializationHost: async ({ runId: id, workDepth, directory }) => ({
      effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async (value) => typeof value === 'string'
          ? { address: { serverId: 'server-1', sessionId: value }, machineId }
          : value && typeof value === 'object' && 'sessionId' in value && 'serverId' in value && typeof value.sessionId === 'string' && value.serverId === 'server-1'
            ? { address: { serverId: value.serverId, sessionId: value.sessionId }, machineId } : null },
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
        caller: { kind: 'originless', runId: id, runDepth: workDepth }, baseline: { machineId, directory },
        ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
      }),
    }),
    storage: { observeChanges: () => ({ dispose: async () => {} }), execute: async (operation) => {
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId: previousRunId, accountId });
      effects.push(operation.operation);
      if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('Unexpected storage effect');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope) });
      if (opened.kind !== 'available') throw new Error('Accepted snapshot unavailable');
      snapshots.push(opened.content);
      acceptedEnvelopes.push(operation.acceptedEnvelope);
      throw captured;
    } },
  });
  return { coordinate, snapshots, effects, acceptedEnvelopes };
}

afterEach(() => vi.restoreAllMocks());

describe('scoped workflow claim admission', () => {
  it.each([
    ['full', true], ['full', false], ['occurrence', true], ['occurrence', false],
  ] as const)('seals %s payload leaves only for the matching admitted plugin Event (%s)', async (shape, matching) => {
    const occurrence = normalizeGithubWebhookDelivery({ rawBody: new TextEncoder().encode(JSON.stringify({
      ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), repository: { id: 77, full_name: 'acme/widgets' },
    })), eventType: 'push', providerDeliveryId: 'event-value-1', receivedAtMs: 1 }).automationEvent!;
    const base = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: occurrence.eventRef,
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631'),
      occurrenceId: occurrence.occurrenceId, occurredAt: occurrence.occurredAtMs,
      payload: PluginJsonValueV2Schema.parse(occurrence.payload) };
    const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...base,
      sourceInstanceId: occurrence.sourceInstanceId, sourceContractVersion: 1, observationReceivedAt: 1,
      filter: { version: null, result: 'matched' } });
    const triggerId = AutomationTriggerIdSchema.parse('event-values');
    const source: WorkflowDefinitionV1 = { ...definition, blocks: [{ kind: 'step', id: 'work',
      document: { text: 'Review this repository', references: [], attachments: [] }, result: { kind: 'text' },
      input: [{ kind: 'trigger_event', event: occurrence.eventRef, path: ['repository', 'nameWithOwner'] }] }] };
    const harness = admissionHarness();
    await expect(harness.coordinate({ ...claim(source), automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: shape === 'full' ? evidence : base }),
      automationCause: { kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: base }), occurredAt: 1,
        evidence: { eventRef: matching ? occurrence.eventRef : { ...occurrence.eventRef, localId: 'another-event' },
          sourceSelectorId: base.sourceSelectorId } },
    })).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject(matching ? { triggerEventValues: [
      { event: occurrence.eventRef, path: ['repository', 'nameWithOwner'], value: 'acme/widgets' },
    ] } : {});
    if (!matching) expect(harness.snapshots[0]).toMatchObject({ triggerEventValues: [] });
  });

  it('carries the admitted exception fingerprint into a saved Workflow snapshot', async () => {
    const event = { pluginId: 'happier.telemetry', localId: 'issue-transition' };
    const evidence = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: event,
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631'),
      occurrenceId: 'exception-transition-1', occurredAt: 42,
      payload: { phase: 'open', issueFingerprint: 'selected-worktree-fingerprint' } };
    const triggerId = AutomationTriggerIdSchema.parse('exception-trigger');
    const source: WorkflowDefinitionV1 = { ...definition, blocks: [{ kind: 'step', id: 'work',
      document: { text: 'Inspect the exception', references: [], attachments: [] }, result: { kind: 'text' },
      input: [{ kind: 'trigger_event', event, path: ['issueFingerprint'] }] }] };
    const harness = admissionHarness();
    await expect(harness.coordinate({ ...claim(source), automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: evidence }),
      automationCause: { kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }), occurredAt: 42,
        evidence: { eventRef: event, sourceSelectorId: evidence.sourceSelectorId } },
    })).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ triggerEventValues: [
      { event, path: ['issueFingerprint'], value: 'selected-worktree-fingerprint' },
    ] });
  });

  it('resolves the saved preview source before materializing the stored placeholder', async () => {
    const template = createDeploymentEnvironmentDetailV1();
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/widgets' };
    template.content.definition = { kind: 'repository', ref: 'main' };
    template.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off', repository,
      runtimeTargetLinkId: template.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [] };
    const event = ScmHostingPullRequestLifecycleV1Schema.parse({ id: '77', number: 17, action: 'opened',
      headSha: 'a'.repeat(40), headRef: 'feature', baseRef: 'main', baseRepository: repository, headRepository: repository,
      author: { id: '19', login: 'alice', kind: 'human' } });
    let admittedSource: WorkflowDefinitionV1 | undefined;
    const harness = admissionHarness(async input => {
      admittedSource = input.definition;
      return { ok: false, code: 'workspace_unavailable' };
    }, ({ templateRef, runId }) => resolvePreviewWorkflowForHost({ templateRef, event, occurrenceKey: runId,
      // Home persistence is replaced; source parsing, admission and composition stay real.
      readEnvironment: async () => ({ ...template, targetLinks: template.targetLinks.map(row => row.targetLink) }),
      readTargetLink: async () => { throw new Error('No data target selected'); },
      readTargetDeclaration: async () => { throw new Error('No data target selected'); },
    }));
    const pending = { ...claim(definition), definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: definition,
      workspace: { directory: '/repo' }, executionTarget: { kind: 'detached_run' },
      deploymentPreview: { serverId: template.environment.serverId, environmentId: template.environment.id } } }) };
    await harness.coordinate(pending);
    expect(admittedSource?.blocks[0]).toMatchObject({ kind: 'action', actionId: 'deployments.environments.create', input: {
      preview: { kind: 'literal', value: { pullRequestId: event.id, headSha: event.headSha } },
    } });
    expect(harness.effects).toEqual([]);
  });
  it('settles normalized wrong-branch and deleted pushes before Environment, Source, SCM or snapshot effects', async () => {
    const harness = admissionHarness();
    const triggerId = AutomationTriggerIdSchema.parse('deployment-trigger');
    for (const pushed of [{ ref: 'refs/heads/feature', after: 'b'.repeat(40) },
      { ref: 'refs/heads/release', after: '0'.repeat(40) }]) {
      const event = normalizeGithubWebhookDelivery({ rawBody: new TextEncoder().encode(JSON.stringify({ ...pushed,
        before: 'a'.repeat(40), repository: { id: 77, full_name: 'acme/widgets' } })), eventType: 'push',
        providerDeliveryId: 'push-1', receivedAtMs: 1 }).automationEvent!;
      const base = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: event.eventRef,
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631'), occurrenceId: event.occurrenceId,
        occurredAt: event.occurredAtMs, payload: PluginJsonValueV2Schema.parse(event.payload) };
      const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...base,
        sourceInstanceId: event.sourceInstanceId, sourceContractVersion: 1, observationReceivedAt: 1,
        filter: { version: null, result: 'matched' } });
      const original = claim(definition);
      await expect(harness.coordinate({ ...original, definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: definition, workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        deploymentTriggers: [{ triggerId, branch: 'release' }],
      } }), automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: evidence }),
        automationCause: { kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
          occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: base }), occurredAt: 1,
          evidence: { eventRef: event.eventRef, sourceSelectorId: base.sourceSelectorId } },
      })).resolves.toEqual({ state: 'skipped', reason: 'filtered', admission: 'refused' });
    }
    expect(harness.effects).toEqual([]);
    expect(harness.snapshots).toEqual([]);
  });
  it('admits a manually invoked habit into its scoped destination Session', async () => {
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'existing_session', sessionId: 'origin-session', machineId } } }))).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ origin: { originSessionId: 'origin-session' },
      materializedLeaves: [{ selection: { conversation: { kind: 'existing_session', sessionId: 'origin-session' } } }] });
  });

  it('refuses a lifecycle self-target inherited through a nested definition before snapshot effects', async () => {
    const harness = admissionHarness();
    const source: WorkflowDefinitionV1 = { ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'existing_session', sessionId: 'origin-session', machineId } },
      blocks: [{ kind: 'if', id: 'nested', when: { kind: 'compare', operator: 'eq',
        left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } }, then: definition.blocks, otherwise: [] }] };
    const occurrence = claim(source);
    const triggerId = AutomationTriggerIdSchema.parse('lifecycle-trigger');
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId, evidence: {
      v: 1, kind: 'sessionLifecycle', event: 'parentTurnCompleted',
      sourceSessionId: 'origin-session', sourceTurnId: 'turn-1', occurredAt: 1,
    } });
    await expect(harness.coordinate({ ...occurrence, automationCause: { kind: 'trigger', triggerKind: 'sessionLifecycle',
      triggerId, triggerRevision: 0, occurredAt: 1, occurrenceKey,
      evidence: { event: 'parentTurnCompleted', sourceSessionId: 'origin-session', sourceTurnId: 'turn-1',
        policy: { kind: 'currentTurn' } } } })).resolves.toMatchObject({ state: 'failed', reason: 'self_target', admission: 'refused' });
    expect(harness.effects).toEqual([]);
  });

  it('allows origin_session through the same scoped claim boundary', async () => {
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'origin_session' } } }))).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ origin: { originSessionId: 'origin-session' } });
  });

  it('freezes an exact source Session context input for lifecycle review without treating it as an independent self-target', async () => {
    const harness = admissionHarness();
    const source: WorkflowDefinitionV1 = { ...definition,
      inputs: [{ name: 'reviewSession', valueType: 'json', required: true, defaultFrom: 'origin_session',
        inputType: { hostType: 'session' } }],
      defaults: { ...definition.defaults, conversation: { kind: 'input', name: 'reviewSession' } } };
    const triggerId = AutomationTriggerIdSchema.parse('review-trigger');
    const evidence = { v: 1 as const, kind: 'sessionLifecycle' as const, event: 'parentTurnCompleted' as const,
      sourceSessionId: 'origin-session', sourceTurnId: 'turn-1', occurredAt: 1 };
    const automationCause = { kind: 'trigger' as const, triggerKind: 'sessionLifecycle' as const,
      triggerId, triggerRevision: 0, occurredAt: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }),
      evidence: { event: evidence.event, sourceSessionId: evidence.sourceSessionId, sourceTurnId: evidence.sourceTurnId,
        policy: { kind: 'currentTurn' as const } } };
    await expect(harness.coordinate({ ...claim(source), automationCause })).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ inputs: { reviewSession: { serverId: 'server-1', sessionId: 'origin-session' } },
      materializedLeaves: [{ selection: { conversation: { kind: 'existing_session', sessionId: 'origin-session', machineId } } }] });
    const independent = admissionHarness();
    await expect(independent.coordinate({ ...claim({ ...source, inputs: [{ name: 'reviewSession', valueType: 'json', required: false,
      inputType: { hostType: 'session' }, default: { serverId: 'server-1', sessionId: 'origin-session' } }] }), automationCause }))
      .resolves.toMatchObject({ state: 'failed', reason: 'self_target', admission: 'refused' });
    expect(independent.effects).toEqual([]);
  });

  it('binds an Account habit to each admitted lifecycle source instead of its launcher Session', async () => {
    const source: WorkflowDefinitionV1 = { ...definition,
      inputs: [{ name: 'reviewSession', valueType: 'json', required: true, defaultFrom: 'origin_session',
        inputType: { hostType: 'session' } }],
      defaults: { ...definition.defaults, conversation: { kind: 'input', name: 'reviewSession' } } };
    const triggerId = AutomationTriggerIdSchema.parse('account-review-trigger');
    for (const [sourceSessionId, constant] of [['event-session-y', undefined], ['event-session-z', undefined],
      ['event-session-y', 'launcher-session']] as const) {
      const harness = admissionHarness(input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
        env: { NODE_ENV: 'test', HOME: '/home/reviewer' }, platform: 'linux', pathIsDirectory: async () => true,
        inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }),
      }));
      const evidence = { v: 1 as const, kind: 'sessionLifecycle' as const, event: 'parentTurnCompleted' as const,
        sourceSessionId, sourceTurnId: 'turn-1', occurredAt: 1 };
      const occurrence = claim(source);
      const definitionEnvelope = constant ? JSON.stringify({ t: 'plain', v: { inlineDefinition: source,
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        inputs: { reviewSession: { serverId: 'server-1', sessionId: constant } } } }) : occurrence.definitionEnvelope;
      await expect(harness.coordinate({ ...occurrence, definitionEnvelope, scopeSessionId: null,
        automationCause: { kind: 'trigger', triggerKind: 'sessionLifecycle', triggerId, triggerRevision: 0,
          occurredAt: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }),
          evidence: { event: evidence.event, sourceSessionId, sourceTurnId: evidence.sourceTurnId,
            policy: { kind: 'currentTurn' } } } })).rejects.toBe(captured);
      expect(harness.snapshots[0]).toMatchObject({ origin: { originSessionId: sourceSessionId },
        inputs: { reviewSession: { serverId: 'server-1', sessionId: constant ?? sourceSessionId } },
        materializedLeaves: [{ selection: { conversation: { kind: 'existing_session', sessionId: constant ?? sourceSessionId, machineId } } }] });
    }
  });

  it('does not turn arbitrary webhook payload into an origin Session', async () => {
    const harness = admissionHarness(input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
        env: { NODE_ENV: 'test', HOME: '/home/reviewer' }, platform: 'linux', pathIsDirectory: async () => true,
        inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }),
      }));
    const triggerId = AutomationTriggerIdSchema.parse('payload-origin-trigger');
    const base = { v: 1 as const, kind: 'pluginEvent' as const,
      eventRef: { pluginId: 'happier.scm.github', localId: 'push' },
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631'),
      occurrenceId: 'payload-origin', occurredAt: 1, payload: { sourceSessionId: 'untrusted-session' } };
    const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...base,
      sourceInstanceId: 'github-hooks', sourceContractVersion: 1, observationReceivedAt: 1,
      filter: { version: null, result: 'matched' } });
    await expect(harness.coordinate({ ...claim(definition), scopeSessionId: null,
      automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: evidence }),
      automationCause: { kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
        occurredAt: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: base }),
        evidence: { eventRef: base.eventRef, sourceSelectorId: base.sourceSelectorId } } })).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ inputs: {} });
    expect(harness.snapshots[0]).toHaveProperty('origin');
    expect((harness.snapshots[0] as { origin: object }).origin).not.toHaveProperty('originSessionId');
  });

  it('seals the admitted guest HEAD and dirty fingerprint and creates the worktree only in the guest', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'workflow-project-source-'));
    const controller = join(scratch, 'controller');
    const guest = join(scratch, 'guest');
    async function git(cwd: string, args: string[]) {
      const result = await runScmCommand({ bin: 'git', cwd, args });
      if (!result.success) throw new Error(result.stderr);
      return result.stdout.trim();
    }
    try {
      for (const [root, content] of [[controller, 'controller'], [guest, 'guest']] as const) {
        await mkdir(root);
        await git(root, ['init', '--initial-branch=main']);
        await writeFile(join(root, 'tracked.txt'), content);
        await git(root, ['add', '--', 'tracked.txt']);
        await git(root, ['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '-m', content]);
        await writeFile(join(root, 'tracked.txt'), `${content} edited`);
      }
      const guestHead = await git(guest, ['rev-parse', 'HEAD']);
      expect(await git(controller, ['rev-parse', 'HEAD'])).not.toBe(guestHead);
      const controllerFingerprint = await scm.readWorktreeChangeFingerprint(controller);
      const guestFingerprint = await scm.readWorktreeChangeFingerprint(guest);
      if (controllerFingerprint.kind !== 'available' || guestFingerprint.kind !== 'available') {
        throw new Error('Both Git fixtures must produce fingerprints');
      }
      expect(guestFingerprint.fingerprint).not.toBe(controllerFingerprint.fingerprint);

      const ref: ManagedWorkspaceRefV2 = {
        v: 2, kind: 'managed', id: 'workspace-ref', serverId: 'server-1',
        controller: { machineId, installationId: 'controller-installation' }, managedId: 'guest',
        rootPath: controller, createdAtMs: 1,
      };
      // Substitute the guest transport's path space. Git and file reads still
      // run against two real repositories, including both dirty file contents.
      const toGuest = (path: string) => join(guest, relative(controller, path));
      const toAdmitted = (path: string) => join(controller, relative(guest, path));
      const guestSource: WorkspaceSource = {
        ...localWorkspaceSource, kind: 'target', id: 'workflow-guest',
        commandPaths: { toCommandPath: toGuest, fromCommandPath: toAdmitted },
        spawn: request => localWorkspaceSource.spawn({
          ...request, cwd: request.cwd ? toGuest(request.cwd) : guest,
        }),
        stat: path => localWorkspaceSource.stat(toGuest(path)),
        lstat: path => localWorkspaceSource.lstat(toGuest(path)),
        realpath: async path => toAdmitted(await localWorkspaceSource.realpath(toGuest(path))),
        mkdir: (path, options) => localWorkspaceSource.mkdir(toGuest(path), options),
        readdir: path => localWorkspaceSource.readdir(toGuest(path)),
        rename: (from, to) => localWorkspaceSource.rename(toGuest(from), toGuest(to)),
        rm: (path, options) => localWorkspaceSource.rm(toGuest(path), options),
        readFile: path => localWorkspaceSource.readFile(toGuest(path)),
        open: (path, options) => localWorkspaceSource.open(toGuest(path), options),
      };
      const source: WorkflowDefinitionV1 = { ...definition,
        defaults: { ...definition.defaults, workspace: { kind: 'new_worktree', source: { kind: 'original' }, displayName: 'workflow-guest' } },
        inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }],
      };
      const occurrence = { ...claim(source, previousCheckpoint(controllerFingerprint.fingerprint)),
        definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: source,
          workspace: { directory: controller, workspaceRefId: ref.id,
            sessionPlacement: { kind: 'in_place', workspace: workspaceAddressFromRefV2(ref) } },
          executionTarget: { kind: 'session' },
        } }),
      };
      const registration = createGitScmBackendRuntimeRegistration();
      const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
        executableDefinition: registration.runtime!, registration,
        scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true }),
        hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }),
      })]);
      const harness = admissionHarness(input => prepareWorkflowAcceptedWorkspaceTarget({
        ...input, inspectLocation: location => inspectWorkspaceLocationWithScmWorkspace({ ...location, registry }),
      }), undefined, {
        resolveCurrentWorkspaceRefs: async () => [ref],
        restoreManagedWorkspaceSource: async () => guestSource,
      });
      await expect(harness.coordinate(occurrence)).rejects.toBe(captured);
      expect(harness.snapshots[0]).toMatchObject({
        workspaceTarget: { project: { directory: controller }, originalCommittedRevision: guestHead },
        inputs: { diffFingerprint: guestFingerprint.fingerprint },
      });
      const probe = '.dev/worktree/source-probe';
      const physicalGuest = await runWithWorkspaceSource(guestSource, () => runWithRealGitScmRuntime(
        () => realizeWorkspaceCheckoutWithScmWorkspaceSource({ sourcePath: controller, registry,
          checkoutCreation: { kind: 'git_worktree', displayName: 'source-probe', baseRef: guestHead, branchMode: 'new' } }),
      ));
      await expect.soft(lstat(join(controller, '.dev'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect.soft(readFile(join(guest, probe, 'tracked.txt'), 'utf8')).resolves.toBe('guest');
      expect(physicalGuest?.realization.targetPath).toBe(join(controller, probe));

      const [acceptedEnvelope] = harness.acceptedEnvelopes;
      if (!acceptedEnvelope) throw new Error('Expected the Automation to admit the guest');
      const workspaceTransport = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ pluginIds: ['happier.scm.backend.git'] }),
      });
      try {
        const storage = createWorkflowRunStorageTestkit({ runId, machineId, acceptedEnvelope, origin: { kind: 'direct' } });
        const execute = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage,
          resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
          resolveAccountEncryption: async () => ({ kind: 'available', witness }),
          isAcceptedAuthorizationCurrent: async () => true,
          execution: execution(), onCommittedTransition: () => {},
          restoreManagedWorkspaceSource: async () => guestSource,
        });
        const outcome = await execute({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: witness, acceptedEnvelope });
        await expect.soft(lstat(join(controller, '.dev'))).rejects.toMatchObject({ code: 'ENOENT' });
        const worktree = join('.dev', 'worktree', 'workflow-guest');
        await expect(readFile(join(guest, worktree, 'tracked.txt'), 'utf8'), JSON.stringify(outcome)).resolves.toBe('guest');
        expect(await git(join(guest, worktree), ['rev-parse', 'HEAD'])).toBe(guestHead);
      } finally {
        await workspaceTransport.release();
        await pluginReloadController.shutdown();
      }

      const stopped = admissionHarness(prepareWorkflowAcceptedWorkspaceTarget, undefined, {
        resolveCurrentWorkspaceRefs: async () => [ref],
        restoreManagedWorkspaceSource: async () => null,
      });
      await expect(stopped.coordinate(occurrence)).resolves.toMatchObject({
        state: 'failed', reason: 'workspace_unavailable', admission: 'refused',
      });
      expect(stopped.snapshots).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('skips an unchanged claimed tree without freezing a snapshot or starting work', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockResolvedValue({ kind: 'available', fingerprint: 'F-b' });
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      previousCheckpoint('F-b')))).resolves.toEqual({ state: 'skipped', reason: 'diff_unchanged', admission: 'refused' });
    expect(harness.effects).toEqual([]);
    expect(read).toHaveBeenCalledExactlyOnceWith('/repo');
  });

  it('fingerprints the prepared canonical project path rather than its authored home alias', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockImplementation(async (directory) => directory === '/home/reviewer/repo'
      ? { kind: 'available', fingerprint: 'F-b' } : { kind: 'unavailable' });
    const harness = admissionHarness((input) => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
      env: { NODE_ENV: 'test', HOME: '/home/reviewer' }, platform: 'linux', pathIsDirectory: async () => true,
      inspectLocation: async () => ({ inspection: { rootPath: '/home/reviewer/repo' } }),
    }));
    const occurrence = claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] }, previousCheckpoint('F-b'));
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: { inlineDefinition: { ...definition,
      inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      workspace: { directory: '~/repo' }, executionTarget: { kind: 'session' } } });
    await expect(harness.coordinate({ ...occurrence, definitionEnvelope })).resolves.toMatchObject({ state: 'skipped', reason: 'diff_unchanged' });
    expect(read).toHaveBeenCalledExactlyOnceWith('/home/reviewer/repo');
    expect(harness.effects).toEqual([]);
  });

  it.each([
    { current: 'F-c', previous: 'F-b', expected: 'F-c' },
    { current: undefined, previous: 'F-b', expected: undefined },
    { current: 'F-b', previous: undefined, expected: 'F-b' },
  ])('runs with changed or unavailable evidence ($current / $previous)', async ({ current, previous, expected }) => {
    vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockResolvedValue(current
      ? { kind: 'available', fingerprint: current } : { kind: 'unavailable' });
    const harness = admissionHarness();
    await expect(harness.coordinate(claim({ ...definition, inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }] },
      previousCheckpoint(previous)))).rejects.toBe(captured);
    expect(harness.snapshots[0]).toMatchObject({ inputs: expected ? { diffFingerprint: expected } : {} });
  });

  it('does not read SCM when the definition did not opt in', async () => {
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint');
    await expect(admissionHarness().coordinate(claim(definition, previousCheckpoint('F-b')))).rejects.toBe(captured);
    expect(read).not.toHaveBeenCalled();
  });
});
