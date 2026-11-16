import * as z from 'zod/mini';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionDetailSchema,
  AutomationDefinitionReconcileRequestSchema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationTriggerDefinitionBindingV1Schema,
  AutomationTriggerIdSchema,
  AutomationSourceSelectorIdV1Schema,
  WorkflowDefinitionV1Schema,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  sealAccountScopedBlobCiphertext,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationDefinitionDetail,
  type AutomationPluginEventDefinitionTrigger,
  type AutomationTriggerDefinitionBindingV1,
} from '@happier-dev/protocol';
import { getRandomBytes } from '@/api/encryption';
import { createCliWorkflowTriggerActions } from './workflowTriggers';
import { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { enrollPlatformFailureSource } from '@/deployments/platformFailureEnrollment';
import { createPlatformFailureNoticeFixture } from '@/deployments/platformFailureNotices.testkit';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

/** Fixture source configs are JSON objects; spread only after proving that shape. */
function sourceConfigObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object source config');
  return Object.fromEntries(Object.entries(value));
}

const network = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn() }));
// HTTP is the external boundary; authoring and crypto remain real.
vi.mock('@/api/client/credentialAxios', () => ({ default: { get: network.get, post: network.post, request: network.request } }));

const secret = new Uint8Array(32).fill(9);
const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret } };
const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});

describe('configured Event source writer consistency', () => {
  afterEach(() => vi.unstubAllGlobals());

  function boundary(mode: 'plain' | 'e2ee') {
    const rows = new Map<string, AutomationDefinitionDetail>();
    let mutations = 0;
    for (const adapter of Object.values(network)) adapter.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected_capability_probe')));
    network.get.mockImplementation(async (url: string) => {
      if (url.includes('/v3/automations?')) return { status: 200, data: { automations: [...rows.values()].map(row => {
        const { executionRecipe: _recipe, observationOnly: _observation, templateCiphertext: _legacy, triggers, ...summary } = row;
        return { ...summary, triggers: triggers.map(trigger => {
          if (trigger.kind !== 'pluginEvent') throw new Error('Expected Event fixture');
          const { triggerDefinitionEnvelope: _private, ...visible } = trigger;
          return visible;
        }) };
      }), nextCursor: null } };
      return { status: 200, data: { mode, version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: mode === 'e2ee'
          ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) : null,
        updatedAt: 1 } };
    });
    network.post.mockImplementation(async () => ({ status: 200,
      data: { automations: [...rows.values()], nextCursor: null } }));
    const storedTrigger = (automationId: string, triggerId: string, revision: number,
      trigger: ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse>['triggers'][number]['trigger']) => {
      if (trigger.kind !== 'pluginEvent') throw new Error('Expected Event fixture');
      const selector = 'sourceSelectorId' in trigger ? trigger.sourceSelectorId : binding.sourceSelectorId;
      const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
        : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
          binding: { ...binding, automationId, triggerId: AutomationTriggerIdSchema.parse(triggerId), triggerRevision: revision,
            eventRef: trigger.eventRef, sourceSelectorId: selector },
          definition: { v: 1, sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig,
            displayLabel: trigger.displayLabel, filter: trigger.filter, maximumObservationAgeMs: trigger.maximumObservationAgeMs } });
      return { ...detail(automationId, triggerId, selector, envelope, revision, undefined,
        { kind: 'observationOnly', templateVersion: 1 }).triggers[0]!, enabled: trigger.enabled, eventRef: trigger.eventRef,
        observation: trigger.observationTransport.kind === 'durablePush'
          ? { kind: 'durablePush' as const, webhookEndpointId: trigger.observationTransport.webhookEndpointId }
          : { kind: trigger.observationTransport.kind, watcher: { ...trigger.observationTransport.watcherMaterializationRef,
              machineInstallationId: 'installation-current' } } };
    };
    // Only authenticated Automation HTTP persistence is substituted. The shared
    // Account writer, envelope codecs and failure projection are production code.
    network.request.mockImplementation(async ({ method, url, data }: { method: string; url: string; data?: unknown }) => {
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
      if (method === 'GET') return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
      if (method === 'POST') {
        const input = AutomationDefinitionCreateRequestSchema.parse(data);
        const first = input.triggers[0]!;
        const row = AutomationDefinitionDetailSchema.parse({ ...detail(input.automationId, first.triggerId, binding.sourceSelectorId,
          {}, 0, undefined, input.observationOnly), name: input.name, enabled: input.enabled,
          triggers: input.triggers.map(item => storedTrigger(input.automationId, item.triggerId, 0, item.trigger)) });
        rows.set(row.id, row); mutations++;
        return { status: 200, data: row };
      }
      if (method !== 'PUT') throw new Error('Unexpected Automation mutation');
      const input = AutomationDefinitionReconcileRequestSchema.parse(data);
      const row = rows.get(id);
      if (!row) throw new Error('Missing current Automation');
      const next = AutomationDefinitionDetailSchema.parse({ ...row, name: input.name, enabled: input.enabled,
        templateVersion: row.templateVersion + 1,
        observationOnly: { ...row.observationOnly, kind: 'observationOnly', templateVersion: row.templateVersion + 1 },
        triggers: input.triggers.map(item => {
          if (item.kind === 'new') return storedTrigger(id, item.triggerId, 0, item.trigger);
          const retained = row.triggers.find(trigger => trigger.id === item.triggerId);
          if (!retained) throw new Error('Missing current trigger');
          if (item.trigger) return storedTrigger(id, item.triggerId, retained.revision + 1,
            { ...item.trigger, enabled: item.enabled ?? retained.enabled });
          return { ...retained, enabled: item.enabled ?? retained.enabled,
            revision: retained.revision + (item.enabled === undefined ? 0 : 1),
            ...(item.triggerDefinitionEnvelope ? { triggerDefinitionEnvelope: JSON.stringify(item.triggerDefinitionEnvelope) } : {}) };
        }) });
      rows.set(id, next); mutations++;
      return { status: 200, data: next };
    });
    return { actions: createCliWorkflowTriggerActions({ credentials: mode === 'plain' ? { token: 'token', encryption: null } : credentials,
      serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow }), rows, mutations: () => mutations };
  }

  const configuredEvent = (period: number, investigation: 'inbox' | 'auto_start' = 'inbox', sourceInstanceId = event.sourceInstanceId):
    AutomationPluginEventDefinitionTrigger & Readonly<{ enabled: boolean }> => ({
    ...event, sourceInstanceId, sourceConfig: { checkPeriodMs: period,
      investigation: investigation === 'inbox' ? { mode: investigation } : { mode: investigation, configuredActionId: 'investigate-errors' } },
  });

  for (const mode of ['plain', 'e2ee'] as const) {
    it(`enrolls a declared production link through the ${mode} source writer and retains its initial baseline`, async () => {
      const f = boundary(mode);
      const fixture = createPlatformFailureNoticeFixture();
      const environment = await fixture.host.readEnvironment();
      const setupInput: unknown[] = [];
      const triggerInputs: unknown[] = [];
      let baseline = 'initial';
      const invoke: NonNullable<import('@happier-dev/protocol').ActionExecutorContext['hostReviewedChild']>['invoke'] = async child => {
        if (typeof child.action !== 'string') {
          setupInput.push(child.input);
          return { ok: true, result: { v: 1, sourceInstanceId: 'platform:target-link', sourceContractVersion: 1,
            sourceConfig: { ...sourceConfigObject(fixture.definition.sourceConfig), baseline }, displayLabel: 'Production platform' } };
        }
        if (child.action !== 'workflow.trigger.add') throw new Error('Unexpected enrollment Action');
        triggerInputs.push(child.input);
        return { ok: true, result: await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse(child.input)) };
      };
      const request = { serverId: 'home', environment, targetLinkId: 'target-link',
        event: { identity: fixture.definition.eventRef, automation: { v: 1 as const, eligible: true as const, source: {
          sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const],
          sourceConfigSchema: { type: 'object' as const, additionalProperties: true },
          setupActionRef: { pluginId: fixture.caller.pluginId, localId: 'setup' },
        } } }, resolveWatcherMaterializationRef: () => fixture.caller, invoke };
      expect(await enrollPlatformFailureSource(request)).toMatchObject({ ok: true });
      baseline = 'later';
      expect(await enrollPlatformFailureSource(request)).toMatchObject({ ok: true });
      expect(setupInput).toEqual(Array(2).fill({ serverId: 'home', environmentId: environment.environment.id, targetLinkId: 'target-link' }));
      expect(f.rows.size).toBe(1);
      expect(f.mutations()).toBe(1);
      const row = [...f.rows.values()][0]!;
      const trigger = row.triggers[0]!;
      if (trigger.kind !== 'pluginEvent') throw new Error('Expected enrolled Event');
      expect(row.observationOnly?.deploymentEnvironment?.environmentId).toBe(environment.environment.id);
      expect(trigger.observation).toMatchObject({ kind: 'checkpointedPull', watcher: fixture.caller });
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        ...(mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, material: snapshot.material }),
        binding: { v: 1, automationId: row.id, triggerId: trigger.id, triggerRevision: trigger.revision,
          triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
        envelope: JSON.parse(trigger.triggerDefinitionEnvelope),
      })).toMatchObject({ kind: 'available', definition: { sourceConfig: { ...sourceConfigObject(fixture.definition.sourceConfig), baseline: 'initial' } } });
      expect(triggerInputs).toHaveLength(2);
    });

    it(`retains and reuses the Environment's ${mode} observation enrollment`, async () => {
      const f = boundary(mode);
      const deploymentEnvironment = { serverId: 'server', projectSourceId: 'source', environmentId: 'environment' };
      const request = { observationOnly: { kind: 'observationOnly' as const, deploymentEnvironment }, trigger: configuredEvent(60_000) };
      const created = await f.actions.add(request);
      expect(created.set.observationOnly).toMatchObject({ deploymentEnvironment });
      const repeated = await f.actions.add(request);
      expect(repeated.set.automationId).toBe(created.set.automationId);
      expect(repeated.triggerId).toBe(created.triggerId);
      expect(f.rows.size).toBe(1);
      expect(f.mutations()).toBe(1);
      const refreshedBaseline = await f.actions.add({ ...request,
        trigger: { ...request.trigger, sourceConfig: { ...request.trigger.sourceConfig, baseline: 'later-provider-head' } } });
      const current = [...f.rows.values()][0]!;
      f.rows.set(current.id, AutomationDefinitionDetailSchema.parse({ ...current, triggers: current.triggers.map(trigger =>
        trigger.kind === 'pluginEvent' ? { ...trigger, observation: { kind: 'checkpointedPull', watcher: null } } : trigger) }));
      await f.actions.add(request);
      expect(f.rows.size).toBe(1);
      expect(f.mutations()).toBe(1);
      expect(refreshedBaseline.set.automationId).toBe(created.set.automationId);
    });

    it(`reads seventy ${mode} trigger sets through one detail page without singleton hydration`, async () => {
      const f = boundary(mode);
      for (let index = 0; index < 70; index++) {
        const automationId = `automation-${index}`;
        const triggerId = `trigger-${index}`;
        const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
          ...(mode === 'plain' ? { mode: 'plain' as const }
            : { mode: 'e2ee' as const, material: snapshot.material, randomBytes: getRandomBytes }),
          binding: { ...binding, automationId, triggerId: AutomationTriggerIdSchema.parse(triggerId), triggerRevision: 0 },
          definition: privateDefinition,
        });
        f.rows.set(automationId, detail(automationId, triggerId, binding.sourceSelectorId, envelope, 0,
          undefined, { kind: 'observationOnly', templateVersion: 1 }));
      }
      const result = await f.actions.list({ scope: 'account_all' });
      expect(network.request.mock.calls.filter(([input]) => input.method === 'GET')).toHaveLength(0);
      expect(network.get.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v3/automations'))).toHaveLength(0);
      expect(network.post).toHaveBeenCalledTimes(1);
      expect(network.post).toHaveBeenCalledWith('https://source.example/v3/automations/query',
        expect.objectContaining({ details: true, limit: 100 }), expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        }));
      expect(result.sets).toHaveLength(70);
      expect(result.sets.every(set => set.health === 'available')).toBe(true);
      const first = result.sets[0]!;
      const readTrigger = first.triggers[0]!;
      if (readTrigger.kind !== 'pluginEvent') throw new Error('Expected Event detail');
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        ...(mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, material: snapshot.material }),
        binding: { ...binding, automationId: first.automationId, triggerId: readTrigger.id,
          triggerRevision: readTrigger.revision },
        envelope: JSON.parse(readTrigger.triggerDefinitionEnvelope),
      })).toEqual({ kind: 'available', definition: privateDefinition });
    });

    it(`shares configured source consistency across event kinds in ${mode}`, async () => {
      const f = boundary(mode);
      const original = await f.actions.add({ name: 'Shared issue source', observationOnly: { kind: 'observationOnly' },
        trigger: configuredEvent(300_000) });
      const second = await f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: {
        ...configuredEvent(300_000), eventRef: { ...event.eventRef, localId: 'issue-updated-v1' },
      } });
      expect(second.set.automationId).not.toBe(original.set.automationId);
      const before = f.mutations();
      const failure = await f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: {
        ...configuredEvent(60_000, 'auto_start'), eventRef: { ...event.eventRef, localId: 'issue-resolved-v1' },
      } }).then(() => null, normalizeWorkflowActionThrownError);
      expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_input', error: expect.stringContaining(original.set.automationId) });
      expect(f.mutations()).toBe(before);
    });

    it.each(['create', 'update', 'restore'] as const)(`rejects conflicting configured sources through ${mode} %s without writing`, async operation => {
      const f = boundary(mode);
      const original = await f.actions.add({ name: 'Existing errors definition', observationOnly: { kind: 'observationOnly' },
        trigger: configuredEvent(300_000) });
      let changed: Awaited<ReturnType<typeof f.actions.add>> | undefined;
      if (operation !== 'create') {
        changed = await f.actions.add({ name: 'Other errors definition', observationOnly: { kind: 'observationOnly' },
          trigger: configuredEvent(60_000, 'auto_start', 'another-source') });
        if (operation === 'restore') {
          const next = configuredEvent(60_000, 'auto_start');
          // A retained conflicting definition can predate this writer rule.
          // Replace only its genuine stored HTTP row, through the same codec.
          const row = f.rows.get(changed.set.automationId)!;
          const trigger = row.triggers[0]!;
          if (trigger.kind !== 'pluginEvent') throw new Error('Expected retained Event');
          const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, material: snapshot.material, randomBytes: getRandomBytes }),
            binding: { ...binding, automationId: row.id, triggerId: trigger.id, triggerRevision: trigger.revision,
              sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
            definition: { ...privateDefinition, sourceInstanceId: next.sourceInstanceId, sourceConfig: next.sourceConfig } });
          f.rows.set(row.id, { ...row, enabled: false,
            triggers: [{ ...trigger, triggerDefinitionEnvelope: JSON.stringify(envelope) }] });
        }
      }
      const before = f.mutations();
      const { enabled: _nextEnabled, ...nextTrigger } = configuredEvent(60_000, 'auto_start');
      for (const surface of ['ui', 'agent'] as const) {
        const attempt = operation === 'create'
          ? f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: configuredEvent(60_000, 'auto_start') }, { surface })
          : f.actions.update({ automationId: changed!.set.automationId, expectedRevision: changed!.set.revision,
              ...(operation === 'update' ? { triggerId: changed!.triggerId,
                patch: { trigger: nextTrigger } } : { patch: { enabled: true } }) }, { surface });
        const failure = await attempt.then(() => null, normalizeWorkflowActionThrownError);
        expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_input', error: expect.stringContaining(original.set.automationId) });
        expect(failure?.error).toContain('Existing errors definition');
      }
      expect(f.mutations()).toBe(before);
    });

    it(`allows identical configs, other identities and replacement of the current ${mode} record`, async () => {
      const f = boundary(mode);
      const first = await f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: configuredEvent(300_000) });
      const duplicate = await f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: {
        ...configuredEvent(300_000), sourceConfig: { investigation: { mode: 'inbox' }, checkPeriodMs: 300_000 },
      } });
      expect(duplicate.set.automationId).not.toBe(first.set.automationId);
      const independent = await f.actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: configuredEvent(60_000, 'auto_start', 'different-source') });
      const { enabled: _replacementEnabled, ...replacement } = configuredEvent(120_000, 'inbox', 'different-source');
      await expect(f.actions.update({ automationId: independent.set.automationId, triggerId: independent.triggerId,
        expectedRevision: independent.set.revision, patch: { trigger: replacement } }))
        .resolves.toMatchObject({ set: { automationId: independent.set.automationId } });
      expect(f.mutations()).toBe(4);
    });

    it(`compares a ${mode} replacement against retained siblings, not its own old revision`, async () => {
      const f = boundary(mode);
      const first = await f.actions.add({ name: 'Sibling sources', observationOnly: { kind: 'observationOnly' }, trigger: configuredEvent(300_000) });
      const row = f.rows.get(first.set.automationId)!;
      const retained = row.triggers[0]!;
      if (retained.kind !== 'pluginEvent') throw new Error('Expected current Event');
      const siblingId = AutomationTriggerIdSchema.parse('retained-sibling');
      const siblingEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
        ...(mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, material: snapshot.material, randomBytes: getRandomBytes }),
        binding: { ...binding, automationId: row.id, triggerId: siblingId, triggerRevision: 0, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(retained.sourceSelectorId) },
        definition: { ...privateDefinition, sourceConfig: configuredEvent(60_000).sourceConfig } });
      // Retained multi-trigger definitions use the same canonical envelope;
      // excluding the current Automation must not exclude its other triggers.
      f.rows.set(row.id, { ...row, triggers: [...row.triggers,
        { ...retained, id: siblingId, revision: 0, triggerDefinitionEnvelope: JSON.stringify(siblingEnvelope) }] });
      const { enabled: _enabled, ...replacement } = configuredEvent(120_000);
      const before = f.mutations();
      const failure = await f.actions.update({ automationId: row.id, triggerId: first.triggerId,
        expectedRevision: row.templateVersion, patch: { trigger: replacement } }).then(() => null, normalizeWorkflowActionThrownError);
      expect(failure).toMatchObject({ errorCode: 'invalid_input', error: expect.stringContaining(row.id) });
      expect(f.mutations()).toBe(before);
    });
  }

  it.each(['production', 'nonProduction'] as const)('consumes a real %s target link through daemon composition and the canonical source writer', async protection => {
    const f = boundary('plain');
    const fixture = createPlatformFailureNoticeFixture(true);
    fixture.changeEnvironment(value => ({ ...value, environment: { ...value.environment, protection } }));
    const environment = await fixture.host.readEnvironment();
    const row = environment.targetLinks[0]!;
    const persistence = network.request.getMockImplementation()!;
    network.request.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/v1/deployments/environments/')) return { status: 200, data: request.method === 'GET'
        ? { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) }
        : { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
          targetLinkId: row.targetLink.id, targetLinkRevision: row.targetLink.revision } };
      return persistence(request);
    });
    const artifacts = createCredentialedAccountArtifactStore(fixture.host.credentials);
    // Mode-opened Artifact persistence is the boundary; the production Environment/link readers remain real.
    artifacts.read = async id => ArtifactDocumentV1Schema.parse({ artifactId: id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
      header: { kind: id === environment.environment.contentArtifactId ? 'deployment-environment.v1' : 'deployment-target-link.v1', title: 'Production' },
      body: JSON.stringify(id === environment.environment.contentArtifactId ? environment.content : row.content),
      revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 });
    const lease = await fixture.host.acquirePluginRuntimeRegistryLease();
    // This fixture supplies only catalog/materialization data at the installed-registry boundary; no executable is invoked.
    const acquire = async () => ({ ...lease, source: 'active', durableRevision: 1,
      resolveCurrentPluginMaterializationRef: () => fixture.caller }) as PluginRuntimeRegistryLease;
    const deps = createDaemonDeploymentActionDeps({ ...fixture.host, accountArtifacts: artifacts, acquirePluginRuntimeRegistryLease: acquire,
      resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
      runtime: { async acquire() { throw new Error('Link enrollment does not execute native services'); } } });
    let baseline = 'initial';
    const context: import('@happier-dev/protocol').ActionExecutorContext = { hostReviewedChild: { async invoke(child) {
      if (typeof child.action !== 'string') return { ok: true, result: { v: 1, sourceInstanceId: 'platform:target-link', sourceContractVersion: 1,
        sourceConfig: { ...sourceConfigObject(fixture.definition.sourceConfig), baseline }, displayLabel: 'Production' } };
      return { ok: true, result: await f.actions.add(WorkflowTriggerAddRequestV1Schema.parse(child.input)) };
    } } };
    const input = { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
      requestKey: 'production-link', role: 'runtime', targetId: 'platform', source: row.targetLink.source,
      targetKind: 'example', machines: [], contentArtifactId: row.targetLink.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(await deps.prepareHostReviewedChildren({ actionId: 'deployments.targets.link', input, context })).toEqual({ children: [
      { action: { pluginId: fixture.caller.pluginId, localId: 'setup' }, role: 'platform-failure.setup' },
      { action: 'workflow.trigger.add', role: 'platform-failure.enroll' },
    ] });
    expect(await deps.deploymentAction('deployments.targets.link', input, context)).toMatchObject({ ok: true, targetLinkId: row.targetLink.id });
    baseline = 'later';
    expect(await deps.deploymentAction('deployments.targets.link', input, context)).toMatchObject({ ok: true, targetLinkId: row.targetLink.id });
    expect(f.rows.size).toBe(1);
    expect(f.mutations()).toBe(1);
    const enrolled = [...f.rows.values()][0]!;
    expect(enrolled).toMatchObject({ observationOnly: { deploymentEnvironment: { environmentId: environment.environment.id } } });
    const trigger = enrolled.triggers[0]!;
    if (trigger.kind !== 'pluginEvent') throw new Error('Expected enrolled Event');
    expect(trigger.observation).toMatchObject({ kind: 'checkpointedPull', watcher: fixture.caller });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, automationId: enrolled.id, triggerId: trigger.id, triggerRevision: trigger.revision,
        triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
      envelope: JSON.parse(trigger.triggerDefinitionEnvelope),
    })).toMatchObject({ kind: 'available', definition: { sourceConfig: { ...sourceConfigObject(fixture.definition.sourceConfig), baseline: 'initial' } } });
  });
});
const event = {
  kind: 'pluginEvent' as const, enabled: true,
  eventRef: { pluginId: 'happier.scm.github', localId: 'issue-opened-v1' },
  sourceInstanceId: 'github:repository:1234', sourceContractVersion: 1,
  sourceConfig: { repository: 'private/repository' }, displayLabel: 'Private repository',
  observationTransport: { kind: 'checkpointedPull' as const,
    watcherMaterializationRef: { machineId: 'machine', materializationId: 'materialization', pluginId: 'happier.scm.github' } },
  filter: null, maximumObservationAgeMs: 60_000,
};
const privateDefinition = { v: 1 as const, sourceInstanceId: event.sourceInstanceId,
  sourceConfig: event.sourceConfig, displayLabel: event.displayLabel, filter: event.filter,
  maximumObservationAgeMs: event.maximumObservationAgeMs };
const binding: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }> = AutomationTriggerDefinitionBindingV1Schema._zod.def.options[0].parse({ v: 1, automationId: 'automation', triggerId: 'trigger',
  triggerRevision: 3, triggerKind: 'pluginEvent', eventRef: event.eventRef,
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631' });
const resolveUnusedWorkflow = async (): Promise<Readonly<{ definition: typeof definition }>> => {
  throw new Error('Inline triggers must not resolve a saved Workflow');
};

function detail(automationId: string, triggerId: string, sourceSelectorId: string, envelope: unknown, revision: number,
  executionRecipe: AutomationDefinitionDetail['executionRecipe'], observationOnly?: AutomationDefinitionDetail['observationOnly']): AutomationDefinitionDetail {
  return AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Triggers', description: null,
    enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
    lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
    ...(observationOnly ? { observationOnly } : { executionRecipe }),
    assignments: observationOnly ? [] : [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }],
    triggers: [{ id: triggerId, revision, enabled: true, createdAt: 1, updatedAt: 1,
      kind: 'pluginEvent', eventRef: event.eventRef, sourceSelectorId, sourceContractVersion: 1,
      observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
      triggerDefinitionEnvelope: JSON.stringify(envelope) }],
  });
}

describe('Workflow trigger encrypted Event HTTP authoring', () => {
  let stored: AutomationDefinitionDetail | undefined;
  beforeEach(() => {
    stored = undefined;
    for (const adapter of Object.values(network)) adapter.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected_capability_probe')));
    network.get.mockImplementation(async (url: string) => {
      if (url.includes('/v3/automations?')) {
        const summaries = stored ? [stored].map(({ executionRecipe: _recipe, observationOnly: _observation,
          templateCiphertext: _legacy, triggers, ...summary }) => ({ ...summary,
          triggers: triggers.map(({ triggerDefinitionEnvelope: _private, ...trigger }) => trigger) })) : [];
        return { status: 200, data: { automations: summaries, nextCursor: null } };
      }
      return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 1 } };
    });
    network.post.mockImplementation(async () => ({ status: 200,
      data: { automations: stored ? [stored] : [], nextCursor: null } }));
    network.request.mockImplementation(async ({ method, data }: { method: string; data?: unknown }) => {
      if (method === 'GET') return { status: 200, data: stored };
      if (method === 'POST') {
        const input = AutomationDefinitionCreateRequestSchema.parse(data);
        const trigger = input.triggers[0]!;
        if (trigger.trigger.kind !== 'pluginEvent' || !('triggerDefinitionEnvelope' in trigger.trigger)) {
          // The canonical E2EE server does not accept caller private Event facts in the plain arm.
          return { status: 400, data: { error: 'invalid_request' } };
        }
        stored = detail(input.automationId, trigger.triggerId, trigger.trigger.sourceSelectorId,
          trigger.trigger.triggerDefinitionEnvelope, 0, input.executionRecipe);
        return { status: 200, data: stored };
      }
      if (!stored) throw new Error('Missing current Automation');
      const input = AutomationDefinitionReconcileRequestSchema.parse(data);
      const trigger = input.triggers[0]!;
      if (trigger.kind !== 'existing' || !trigger.triggerDefinitionEnvelope) {
        // Enable-only E2EE Event mutation requires the exact next-revision envelope.
        return { status: 400, data: { error: 'invalid_request' } };
      }
      stored = AutomationDefinitionDetailSchema.parse({ ...stored, templateVersion: 2, executionRecipe: input.executionRecipe ?? stored.executionRecipe,
        triggers: stored.triggers.map((item) => item.kind === 'pluginEvent' && item.id === trigger.triggerId
          ? { ...item, enabled: trigger.enabled!, revision: item.revision + 1,
              triggerDefinitionEnvelope: JSON.stringify(trigger.triggerDefinitionEnvelope) }
          : item) });
      return { status: 200, data: stored };
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('authors and manages observation-only Events without a Workflow, workspace, or execution assignment', async () => {
    let row: AutomationDefinitionDetail | undefined;
    network.request.mockImplementation(async ({ method, data }: { method: string; data?: unknown }) => {
      if (method === 'POST') {
        const input = AutomationDefinitionCreateRequestSchema.parse(data);
        const item = input.triggers[0]!;
        if (item.trigger.kind !== 'pluginEvent' || !('triggerDefinitionEnvelope' in item.trigger)) throw new Error('Expected sealed Event');
        row = detail(input.automationId, item.triggerId,
          item.trigger.sourceSelectorId, item.trigger.triggerDefinitionEnvelope, 0, undefined, input.observationOnly);
        return { status: 200, data: row };
      }
      if (!row) throw new Error('Missing observation definition');
      if (method === 'GET') return { status: 200, data: row };
      const input = AutomationDefinitionReconcileRequestSchema.parse(data);
      const item = input.triggers[0]!;
      row = AutomationDefinitionDetailSchema.parse({ ...row, enabled: input.enabled,
        triggers: row.triggers.map((trigger) => {
          if (item.kind !== 'existing' || trigger.id !== item.triggerId || trigger.kind !== 'pluginEvent') return trigger;
          if (item.trigger?.kind === 'pluginEvent' && 'triggerDefinitionEnvelope' in item.trigger) {
            const transport = item.trigger.observationTransport;
            if (transport.kind !== 'checkpointedPull') throw new Error('Expected pull watcher');
            return { ...trigger, revision: trigger.revision + 1,
              triggerDefinitionEnvelope: JSON.stringify(item.trigger.triggerDefinitionEnvelope),
              observation: { kind: 'checkpointedPull', watcher: { ...transport.watcherMaterializationRef,
                machineInstallationId: 'installation-current' } } };
          }
          return item.enabled === undefined ? trigger : { ...trigger, enabled: item.enabled, revision: trigger.revision + 1,
            triggerDefinitionEnvelope: JSON.stringify(item.triggerDefinitionEnvelope) };
        }) });
      return { status: 200, data: row };
    });
    const actions = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow });
    const result = await actions.add({ observationOnly: { kind: 'observationOnly' }, trigger: event });
    expect(result.set).toMatchObject({ observationOnly: { kind: 'observationOnly', templateVersion: 1 }, health: 'available' });
    expect(result.set).not.toHaveProperty('target');
    expect(result.set).not.toHaveProperty('project');
    const body = AutomationDefinitionCreateRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'POST')?.[0].data);
    expect(body).toMatchObject({ observationOnly: { kind: 'observationOnly', templateVersion: 1 }, assignments: [] });
    expect(body).not.toHaveProperty('executionRecipe');
    network.get.mockImplementation(async (url: string) => {
      if (url.includes('/v3/automations?') && row) {
        const { executionRecipe: _recipe, templateCiphertext: _legacy, triggers, ...summary } = row;
        return { status: 200, data: { automations: [{ ...summary,
          triggers: triggers.map(({ triggerDefinitionEnvelope: _private, ...trigger }) => trigger) }], nextCursor: null } };
      }
      return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint), updatedAt: 1 } };
    });
    network.post.mockImplementation(async () => ({ status: 200,
      data: { automations: row ? [row] : [], nextCursor: null } }));
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([result.set]);
    const paused = await actions.update({ automationId: result.set.automationId, expectedRevision: 1, patch: { enabled: false } });
    expect(paused.set).toMatchObject({ enabled: false, observationOnly: { kind: 'observationOnly' } });
    const resumed = await actions.update({ automationId: result.set.automationId, expectedRevision: paused.set.revision, patch: { enabled: true } });
    expect(resumed.set.enabled).toBe(true);
    const patch = AutomationDefinitionReconcileRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'PUT')?.[0].data);
    expect(patch.assignments).toEqual([]);
    expect(patch).not.toHaveProperty('executionRecipe');
    const { enabled: _enabled, ...movedTrigger } = event;
    const moved = await actions.update({ automationId: result.set.automationId, triggerId: result.triggerId,
      expectedRevision: resumed.set.revision, patch: { trigger: { ...movedTrigger,
        observationTransport: { ...event.observationTransport,
          watcherMaterializationRef: { ...event.observationTransport.watcherMaterializationRef, machineId: 'machine-two' } } } } });
    expect(moved.set).toMatchObject({ observationOnly: { kind: 'observationOnly' },
      triggers: [{ observation: { watcher: { machineId: 'machine-two' } } }] });
    expect(row?.assignments).toEqual([]);
  });
  it('seals caller-visible Event facts before POST using actual Automation and trigger identities', async () => {
    const actions = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow });
    const result = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger: event });
    expect(result.set.health).toBe('available');
    const body = AutomationDefinitionCreateRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'POST')?.[0].data);
    const trigger = body.triggers[0]!;
    expect(trigger.trigger).not.toHaveProperty('sourceInstanceId');
    expect(trigger.trigger).not.toHaveProperty('sourceConfig');
    expect(trigger.trigger).not.toHaveProperty('displayLabel');
    expect(trigger.trigger.kind === 'pluginEvent' && 'sourceSelectorId' in trigger.trigger).toBe(true);
    if (trigger.trigger.kind !== 'pluginEvent' || !('triggerDefinitionEnvelope' in trigger.trigger)) throw new Error('sealed Event missing');
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding: { ...binding, automationId: body.automationId, triggerId: AutomationTriggerIdSchema.parse(trigger.triggerId), triggerRevision: 0,
        sourceSelectorId: trigger.trigger.sourceSelectorId }, envelope: trigger.trigger.triggerDefinitionEnvelope }))
      .toEqual({ kind: 'available', definition: privateDefinition });
  });
  it('reseals an enable-only Event patch to the next trigger revision without changing source identity', async () => {
    const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/work' },
      executionTarget: { kind: 'session' }, inlineDefinition: definition });
    stored = detail(binding.automationId, binding.triggerId, binding.sourceSelectorId,
      sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
        randomBytes: getRandomBytes, binding, definition: privateDefinition }), 3,
      { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'automation_template_payload', material: snapshot.material, payload: context, randomBytes: getRandomBytes }) } });
    const actions = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow });
    const result = await actions.update({ automationId: binding.automationId, triggerId: binding.triggerId, expectedRevision: 1, patch: { enabled: false } });
    expect(result.triggerRevision).toBe(4);
    expect(result.set.triggers[0]?.enabled).toBe(false);
    const body = AutomationDefinitionReconcileRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'PUT')?.[0].data);
    const trigger = body.triggers[0]!;
    if (trigger.kind !== 'existing') throw new Error('existing Event missing');
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding: { ...binding, triggerRevision: 4 }, envelope: trigger.triggerDefinitionEnvelope }))
      .toEqual({ kind: 'available', definition: privateDefinition });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding, envelope: trigger.triggerDefinitionEnvelope }).kind).toBe('bindingMismatch');
  });
});
