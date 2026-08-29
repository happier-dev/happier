import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('keeps custom setup presentation subordinate to the setup Action', async () => {
  const definition = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const surface = await readFile(new URL('../ui/repositoryPicker.web.ts', import.meta.url), 'utf8');
  assert.match(definition, /setupActionRef:/);
  assert.match(definition, /setupSurface:/);
  assert.match(surface, /settleEphemeralInput/);
  assert.doesNotMatch(surface, /automation(?:Create|Update|Save|Persist)/i);
});

test('emits a manifest accepted by canonical external-plugin ingestion', async () => {
  const [{ manifest }, { parsePluginManifest }, { createPluginEventAutomationSetupResultV1JsonSchema }] =
    await Promise.all([
      import('../src/index.ts'),
      import('@happier-dev/plugin-sdk/manifest'),
      import('@happier-dev/plugin-sdk/events'),
    ]);
  const parsed = parsePluginManifest(manifest);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics));
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.manifest.contributes.events.map((event) => event.id),
    ['repository-pushed'],
  );
  assert.deepEqual(
    parsed.manifest.contributes.backgroundServices.map((service) => service.id),
    ['repository-push-observer'],
  );

  // The setup binding survived canonical ingestion: same-plugin, exact setup
  // Action reference, and the declared renderer chain intact. Canonical
  // ingestion returns frozen plain-data projections, so the structural
  // comparison goes through the JSON round-trip rather than identity-of-kind.
  const source = parsed.manifest.contributes.events[0]?.automation?.source;
  assert.ok(source);
  assert.deepEqual(JSON.parse(JSON.stringify(source.setupActionRef)), {
    pluginId: manifest.id,
    localId: 'setup-repository',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(source.setupSurface)), {
    renderer: 'repository-picker',
    fallbackRenderers: ['repository-picker-fallback'],
  });

  // The setup Action result schema is the one Protocol-owned builder output
  // over this Event's own source-config schema, never a hand-written copy.
  const setupAction = parsed.manifest.contributes.actions.find(
    (action) => action.id === 'setup-repository',
  );
  assert.ok(setupAction);
  assert.deepEqual(
    setupAction.resultSchema,
    createPluginEventAutomationSetupResultV1JsonSchema(1, setupAction.inputSchema),
  );

  // Renderer declarations stay inside the Protocol-owned host-method union:
  // the hosted picker requires exactly the ephemeral settlement pair, and an
  // unknown method is rejected by canonical ingestion rather than by any
  // example-local vocabulary.
  const hostedPicker = parsed.manifest.contributes.ui?.renderers?.find(
    (renderer) => renderer.id === 'repository-picker',
  );
  assert.ok(hostedPicker);
  assert.deepEqual(hostedPicker.requiredHostMethods, ['context', 'settleEphemeralInput']);
  const drifted = structuredClone(manifest);
  drifted.contributes.ui.renderers.find(
    (renderer) => renderer.id === 'repository-picker',
  ).requiredHostMethods = ['context', 'settleEphemeralInput', 'notAHostMethod'];
  assert.equal(parsePluginManifest(drifted).ok, false);
});

test('runs the complete public list, admit and status lifecycle for one observation', async () => {
  const { runRepositoryPushObserver } = await import('../src/index.ts');
  const controller = new AbortController();
  const calls = [];
  let settledObservation;
  const observationSettled = new Promise((resolve) => { settledObservation = resolve; });
  const definition = {
    automationId: 'automation-example',
    triggerId: 'trigger-example',
    triggerRevision: 0,
    eventRef: {
      pluginId: 'examples.automation-event-source',
      localId: 'repository-pushed',
    },
    sourceSelectorId: '3f5b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d91',
    sourceInstanceId: 'example/repository',
    sourceContractVersion: 1,
  };
  const context = {
    plugin: { id: 'examples.automation-event-source', version: '0.1.0' },
    contribution: {
      id: 'repository-push-observer',
      qualifiedId: 'examples.automation-event-source/repository-push-observer',
    },
    surface: 'background',
    invokedAtMs: 1_725_000_000_001,
    signal: controller.signal,
    services: {
      actions: {
        async execute(actionId, input) {
          calls.push({ actionId, input });
          if (actionId === 'automation.event.sources.list') {
            return {
              kind: 'page',
              revision: 'source-revision-1',
              definitions: [definition],
              nextCursor: null,
            };
          }
          if (actionId === 'automation.event.admit') {
            return {
              results: [{ kind: 'admitted', runId: 'run-example', checkpointSafe: true }],
              continuation: { kind: 'ready' },
            };
          }
          if (actionId === 'automation.event.source.status.report') return {};
          throw new Error(`Unexpected Action: ${actionId}`);
        },
      },
      logger: {
        info(message, facts) {
          if (message === 'automation_event_source.observation_settled') {
            settledObservation({ message, facts });
          }
        },
      },
    },
  };

  const running = runRepositoryPushObserver(context);
  assert.deepEqual(await observationSettled, {
    message: 'automation_event_source.observation_settled',
    facts: {
      occurrenceId: 'example/repository:refs/heads/main:7f6d9d4',
      disposition: { kind: 'checkpointSafe' },
    },
  });
  controller.abort();
  await running;

  assert.deepEqual(calls.map(({ actionId }) => actionId), [
    'automation.event.sources.list',
    'automation.event.source.status.report',
    'automation.event.admit',
    'automation.event.source.status.report',
  ]);
  assert.deepEqual(calls[0].input, { transport: { kind: 'checkpointedPull' } });
  assert.deepEqual(calls[1].input, {
    kind: 'catalogReconciliation',
    scope: { kind: 'checkpointedPull' },
    observedRevision: 'source-revision-1',
    adoptedRevision: 'source-revision-1',
    state: 'current',
    scanStartedAt: null,
    nextRetryAt: null,
  });
  assert.deepEqual(calls[2].input, {
    eventRef: definition.eventRef,
    occurrenceId: 'example/repository:refs/heads/main:7f6d9d4',
    occurredAt: 1_725_000_000_000,
    observationReceivedAt: 1_725_000_000_001,
    payload: { repository: 'example/repository', ref: 'refs/heads/main' },
    definitions: [{
      automationId: definition.automationId,
      triggerId: definition.triggerId,
      triggerRevision: definition.triggerRevision,
      sourceSelectorId: definition.sourceSelectorId,
    }],
  });
  assert.deepEqual(calls[3].input, {
    kind: 'source',
    automationId: definition.automationId,
    triggerId: definition.triggerId,
    triggerRevision: definition.triggerRevision,
    eventRef: definition.eventRef,
    sourceSelectorId: definition.sourceSelectorId,
    state: 'observing',
    code: 'none',
    lastObservedAt: 1_725_000_000_001,
    lastDispositionAt: 1_725_000_000_001,
    nextRetryAt: null,
    observedDelta: 1,
    admittedDelta: 1,
    skippedDelta: 0,
  });
});
