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
      import('../dist/index.js'),
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
