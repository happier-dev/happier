import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type {
  PluginClientActionHandler,
  PluginClientActionUi,
} from '@happier-dev/plugin-sdk/actions';
import type { VoiceClientToolDefinition, VoiceRealtimeToolResult } from '@happier-dev/plugin-sdk/voice/client';

type VoiceProviderRuntime = Parameters<PluginApi['voiceProviders']['register']>[1];

import { activate as activatePackedTargetedClient } from '../../fixtures/plugin-platform/packed-targeted-contribution-projection/contributor/src/clientRuntime';
import { classifyActionFailure } from '../../fixtures/plugin-platform/packed-targeted-contribution-projection/contributor/ui/providerDetailActionFailure';
import {
  assertColdRestart,
  assertColdTargetedContributionRecords,
  assertPackedTargetedClientBoundaryManifest,
  assertMountedTargetedContributionProjection,
  assertPackedTargetedFixtureSourcesArePublicOnly,
  PACKED_TARGETED_CONTRIBUTION_FIXTURE,
  rewriteExternalContributorManifestForColdSemanticParity,
} from './runPackedTargetedContributionProjection';

const PACKED_TARGETED_FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/plugin-platform/packed-targeted-contribution-projection',
);

// This is a provider-codec transport vector, not a composer assertion. The
// packed browser spec reads the real current-UI composer/reader boundary.
const CANONICAL_PLUGIN_PAGE_CURRENT_UI_CONTEXT = {
  navigation: { area: 'plugin', screen: 'page' },
  commands: [],
} as const;

async function readPackedTargetedContributorManifest(): Promise<unknown> {
  // Keep the temporary author project below the workspace so its public SDK
  // imports resolve exactly as they do for the source fixture test.
  const fixtureRoot = await mkdtemp(join(
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    '.packed-targeted-manifest-',
  ));
  const contributorRoot = join(fixtureRoot, 'contributor');
  try {
    await cp(join(PACKED_TARGETED_FIXTURE_ROOT, 'contributor'), contributorRoot, {
      recursive: true,
    });
    await cp(
      join(PACKED_TARGETED_FIXTURE_ROOT, 'public-protocol.ts'),
      join(contributorRoot, 'src', 'protocol.ts'),
    );
    const fixtureModule = await import(pathToFileURL(join(contributorRoot, 'src', 'index.ts')).href) as {
      manifest?: unknown;
    };
    assert.ok(fixtureModule.manifest, 'the fixture definePlugin source must export its manifest');
    return PluginManifestV2Schema.parse(fixtureModule.manifest);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function requireClientActionHandler(value: unknown): PluginClientActionHandler {
  assert.equal(typeof value, 'function');
  return value as PluginClientActionHandler;
}

function mountedProjectionFixture() {
  const projectionGeneration = 42;
  const target = {
    pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
    immutableGenerationId: 'target-generation',
  };
  const contributor = {
    pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
    contributionId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId,
    immutableGenerationId: 'contributor-generation',
  };
  const point = {
    pointId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
    protocol: {
      id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.protocolId,
      version: 1,
    },
  };
  const surface = {
    point,
    contributor,
    role: 'detail',
    presentation: 'content',
  };
  return {
    protocolVersion: 1,
    projection: { v: 2, generation: projectionGeneration, familiesById: {} },
    targetedContributions: {
      target,
      points: [{
        pointId: point.pointId,
        protocols: [{
          protocol: point.protocol,
          contributions: [{
            contributor,
            protocol: point.protocol,
            descriptor: { providerId: 'github' },
            operations: [{
              point,
              contributor,
              role: 'setup',
              action: {
                pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
                localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.actionId,
              },
            }],
            surfaces: [surface],
          }],
        }],
      }],
    },
    targetedSurfaceMounts: [{
      kind: 'targetedSurface',
      target,
      ...surface,
      inputSchema: {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { reviewId: { type: 'string' } },
        required: ['reviewId'],
        additionalProperties: false,
      },
      rendererChain: [{
        pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
        localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
      }],
      selectedRenderer: {
        identity: {
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
        },
        renderer: {
          kind: 'reactNative',
          contributionId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
        },
        artifactProjection: {
          id: `${PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId}:reactNativeBundle:provider-detail`,
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
          contributionId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
          contributionKind: 'reactNativeBundle',
        },
        availability: {
          state: 'available',
          reason: 'available',
          diagnostics: [],
        },
      },
      executionOrigin: {
        serverIdentityId: 'srv_targeted',
        materializationRef: {
          machineId: 'machine-id',
          materializationId: 'contributor-materialization',
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
        },
      },
      resourceCapability: { readable: false, dynamic: false },
      contributorTargetedContributions: {
        target: {
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
          immutableGenerationId: 'contributor-generation',
        },
        points: [],
      },
    }],
  };
}

test('requires the real mounted projection to preserve every public and private targeted contract fence', () => {
  const projection = mountedProjectionFixture();

  const evidence = assertMountedTargetedContributionProjection({
    projection,
    targetGeneration: 'target-generation',
    contributorGeneration: 'contributor-generation',
    machineId: 'machine-id',
  });

  assert.deepEqual(evidence, {
    target: projection.targetedContributions.target,
    contributor: projection.targetedContributions.points[0].protocols[0].contributions[0].contributor,
    renderer: {
      pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributorPluginId,
      localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
    },
  });
});

test('requires an externally admitted descriptor to equal the public built-in semantic baseline', () => {
  const projection = mountedProjectionFixture();
  const contribution = projection.targetedContributions.points[0]!
    .protocols[0]!
    .contributions[0]!;
  const builtInSemanticDescriptor = { providerId: 'gitlab' };
  contribution.descriptor = builtInSemanticDescriptor;
  const params = {
    projection,
    targetGeneration: 'target-generation',
    contributorGeneration: 'contributor-generation',
    machineId: 'machine-id',
    builtInSemanticDescriptor,
  };

  assert.doesNotThrow(() => assertMountedTargetedContributionProjection(params));

  const externalDescriptor = {
    providerId: 'gitlab',
    ignoredByTargetParser: true,
  };
  contribution.descriptor = externalDescriptor;
  assert.throws(
    () => assertMountedTargetedContributionProjection(params),
    /targeted_projection_external_built_in_semantic_mismatch/u,
  );
});

test('keeps the generated public descriptor baseline separate from the external cold-manifest probe', () => {
  const sourceManifest = {
    contributes: {
      targetedPluginContributions: [{
        id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId,
        target: {
          pluginId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.targetPluginId,
          pointId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.pointId,
        },
        protocol: {
          id: PACKED_TARGETED_CONTRIBUTION_FIXTURE.protocolId,
          version: 1,
        },
        descriptor: { providerId: 'github' },
        operations: { setup: PACKED_TARGETED_CONTRIBUTION_FIXTURE.actionId },
        surfaces: { detail: { renderer: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId } },
      }],
    },
  };

  const rewritten = rewriteExternalContributorManifestForColdSemanticParity(sourceManifest);

  assert.deepEqual(rewritten.builtInSemanticBaseline, {
    descriptor: { providerId: 'github' },
  });
  assert.deepEqual(rewritten.manifest, {
    contributes: {
      targetedPluginContributions: [{
        ...sourceManifest.contributes.targetedPluginContributions[0],
        descriptor: {
          providerId: 'github',
          ignoredByTargetParser: true,
        },
      }],
    },
  });
  assert.deepEqual(
    sourceManifest.contributes.targetedPluginContributions[0]?.descriptor,
    { providerId: 'github' },
  );
});

test('parses the packed contributor fixture manifest and validates its shared Action and Voice client target', async () => {
  const manifest = await readPackedTargetedContributorManifest();

  assert.doesNotThrow(() => assertPackedTargetedClientBoundaryManifest(manifest));
});

test('activates the fixture client Actions and Voice together and forwards local navigation to the supplied UI port', async () => {
  const actionHandlers = new Map<string, unknown>();
  let voiceRuntime: VoiceProviderRuntime | undefined;
  activatePackedTargetedClient({
    actions: {
      register(id, handler) {
        actionHandlers.set(id, handler);
      },
    },
    voiceProviders: {
      register(id, runtime) {
        assert.equal(id, PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId);
        voiceRuntime = runtime;
      },
    },
  } as PluginClientApi);

  assert.deepEqual([...actionHandlers.keys()].sort(), [
    PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId,
    PACKED_TARGETED_CONTRIBUTION_FIXTURE.webOnlyClientActionId,
    PACKED_TARGETED_CONTRIBUTION_FIXTURE.writesLocalClientActionId,
  ].sort());
  const actionHandler = requireClientActionHandler(
    actionHandlers.get(PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId),
  );
  assert.strictEqual(
    actionHandlers.get(PACKED_TARGETED_CONTRIBUTION_FIXTURE.webOnlyClientActionId),
    actionHandler,
  );
  const localEffectHandler = requireClientActionHandler(
    actionHandlers.get(PACKED_TARGETED_CONTRIBUTION_FIXTURE.writesLocalClientActionId),
  );
  assert.notStrictEqual(localEffectHandler, actionHandler);
  assert.equal(voiceRuntime?.kind, 'conversation');
  assert.equal(voiceRuntime?.microphoneMode, 'provider_managed');
  const result = await actionHandler({}, {
    invocationSurface: 'voice',
    signal: new AbortController().signal,
    currentUiContext: CANONICAL_PLUGIN_PAGE_CURRENT_UI_CONTEXT,
  } as never);
  assert.deepEqual(result, {
    screen: 'page',
    invocationSurface: 'voice',
  });

  const localEffectSignal = new AbortController().signal;
  const openedSurfaces: Array<Parameters<PluginClientActionUi['openSurface']>> = [];
  const openSurface: PluginClientActionUi['openSurface'] = async (...args) => {
    openedSurfaces.push(args);
  };
  const localEffectResult = await localEffectHandler({}, {
    invocationSurface: 'ui',
    signal: localEffectSignal,
    ui: { openSurface },
  } as never);
  assert.equal(openedSurfaces.length, 1);
  const [view, input, options] = openedSurfaces[0]!;
  assert.equal(view, PACKED_TARGETED_CONTRIBUTION_FIXTURE.appPageId);
  assert.equal(input, undefined);
  assert.equal(options?.subPath, 'local-effect');
  assert.strictEqual(options?.signal, localEffectSignal);
  assert.deepEqual(localEffectResult, {
    screen: 'packed-provider-detail',
    invocationSurface: 'ui',
  });
});

test('runs the packed Voice protocol with a React Native-compatible structural abort signal', async () => {
  let voiceRuntime: VoiceProviderRuntime | undefined;
  activatePackedTargetedClient({
    actions: { register() {} },
    voiceProviders: {
      register(id, runtime) {
        assert.equal(id, PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId);
        voiceRuntime = runtime;
      },
    },
  } as PluginClientApi);

  assert.ok(voiceRuntime && voiceRuntime.kind === 'conversation');
  const runtime = voiceRuntime;
  const structuralSignal = { aborted: false, reason: undefined } as AbortSignal;
  assert.equal('throwIfAborted' in structuralSignal, false);

  const prepared = await runtime.protocol.prepare({ signal: structuralSignal } as never);
  assert.equal(prepared.kind, 'prepared');

  const connection = await runtime.createConnection({
    signal: structuralSignal,
    tools: [],
  } as never);
  const controlEvents = connection.controlEvents(structuralSignal)[Symbol.asyncIterator]();
  try {
    await connection.connect(structuralSignal);
    const firstControl = await controlEvents.next();
    assert.equal(firstControl.done, false);
  } finally {
    await connection.close({ code: 'user_stop' });
  }
});

test('settles the exact packed Voice invoke call from the canonical provider-redacted success', async () => {
  const actionHandlers = new Map<string, unknown>();
  let voiceRuntime: VoiceProviderRuntime | undefined;
  activatePackedTargetedClient({
    actions: {
      register(id, handler) {
        actionHandlers.set(id, handler);
      },
    },
    voiceProviders: {
      register(id, runtime) {
        assert.equal(id, PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId);
        voiceRuntime = runtime;
      },
    },
  } as PluginClientApi);

  assert.ok(voiceRuntime && voiceRuntime.kind === 'conversation');
  const runtime = voiceRuntime;
  const tools = [{
    name: 'readCurrentUiContext',
    description: 'Fixture read tool.',
    parameters: { type: 'object' },
    async execute() {
      return {};
    },
  }, {
    name: 'invokeCurrentUiCommand',
    description: 'Fixture invoke tool.',
    parameters: { type: 'object' },
    async execute() {
      return {};
    },
  }] satisfies readonly VoiceClientToolDefinition[];
  const signalController = new AbortController();
  const connection = await runtime.createConnection({
    signal: signalController.signal,
    tools,
  } as never);
  const controlEvents = connection.controlEvents(signalController.signal)[Symbol.asyncIterator]();

  try {
    await connection.connect(signalController.signal);
    const firstControl = await controlEvents.next();
    assert.equal(firstControl.done, false, 'the fixture provider must report its supplied tool catalog');
    const [catalogEvent] = runtime.protocol.decodeControl(firstControl.value);
    assert.equal(catalogEvent?.type, 'transcript');
    assert.ok(catalogEvent && catalogEvent.type === 'transcript');
    assert.equal(
      catalogEvent.event.text,
      'Packed Voice current UI tools: readCurrentUiContext, invokeCurrentUiCommand.',
    );

    const secondControl = await controlEvents.next();
    assert.equal(secondControl.done, false, 'the fixture provider must request its named read tool');
    const [firstEvent] = runtime.protocol.decodeControl(secondControl.value);
    assert.equal(firstEvent?.type, 'tool_calls');
    assert.ok(firstEvent && firstEvent.type === 'tool_calls');
    assert.equal(firstEvent.calls.length, 1);
    const [readCall] = firstEvent.calls;
    assert.ok(readCall);
    assert.equal(readCall?.toolName, 'readCurrentUiContext');

    const readResult = {
      v: 1,
      responseId: readCall.responseId,
      callId: readCall.callId,
      toolName: readCall.toolName,
      order: readCall.order,
      status: 'success',
      output: {
        navigation: CANONICAL_PLUGIN_PAGE_CURRENT_UI_CONTEXT.navigation,
        commands: [{
          id: 'current-ui-command:packed-targeted',
          title: 'Inspect packed provider context',
        }],
      },
    } as const satisfies VoiceRealtimeToolResult;
    for (const control of runtime.encodeToolResults([readResult])) {
      await connection.sendControl(control);
    }

    const thirdControl = await controlEvents.next();
    assert.equal(thirdControl.done, false, 'the fixture provider must request its named invoke tool');
    const [secondEvent] = runtime.protocol.decodeControl(thirdControl.value);
    assert.equal(secondEvent?.type, 'tool_calls');
    assert.ok(secondEvent && secondEvent.type === 'tool_calls');
    assert.equal(secondEvent.calls.length, 1);
    const [invokeCall] = secondEvent.calls;
    assert.ok(invokeCall);
    assert.equal(invokeCall?.toolName, 'invokeCurrentUiCommand');
    assert.deepEqual(invokeCall?.arguments, {
      commandId: 'current-ui-command:packed-targeted',
    });

    const unrelatedInvokeSuccess = {
      v: 1,
      responseId: invokeCall.responseId,
      callId: 'unrelated-packed-current-ui-command-call',
      toolName: invokeCall.toolName,
      order: invokeCall.order,
      status: 'success',
      output: { ok: true },
    } as const satisfies VoiceRealtimeToolResult;
    for (const control of runtime.encodeToolResults([unrelatedInvokeSuccess])) {
      await connection.sendControl(control);
    }
    const automaticContextUpdate = runtime.encodeContextUpdate('CURRENT UI CONTEXT\n\n{"navigation":{"area":"plugin"}}');
    for (const control of automaticContextUpdate) {
      await connection.sendControl(control);
    }
    const unrelatedSuccessProbe = await controlEvents.next();
    assert.equal(unrelatedSuccessProbe.done, false, 'an unrelated success must not settle the pending invoke call');
    const [automaticContextEvent] = runtime.protocol.decodeControl(unrelatedSuccessProbe.value);
    assert.equal(automaticContextEvent?.type, 'transcript');
    assert.ok(automaticContextEvent && automaticContextEvent.type === 'transcript');
    assert.match(automaticContextEvent.event.text, /^Packed Voice automatic context metadata received\./u);

    // The Voice provider boundary intentionally reduces successful Action and
    // current-UI command results to this settlement, retaining no UI result
    // fields. The fixture must correlate it to the call it issued rather than
    // using those private fields as a completion signal.
    const providerRedactedInvokeResult = { ok: true } as const;
    const invokeResult = {
      v: 1,
      responseId: invokeCall.responseId,
      callId: invokeCall.callId,
      toolName: invokeCall.toolName,
      order: invokeCall.order,
      status: 'success',
      output: providerRedactedInvokeResult,
    } as const satisfies VoiceRealtimeToolResult;
    for (const control of runtime.encodeToolResults([invokeResult])) {
      await connection.sendControl(control);
    }

    const completionControl = await new Promise<IteratorResult<unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('packed_voice_completion_missing_after_provider_redacted_invoke_success'));
      }, 500);
      void controlEvents.next().then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    assert.equal(completionControl.done, false, 'the exact issued invoke call must settle the provider flow');
    const [completionEvent] = runtime.protocol.decodeControl(completionControl.value as never);
    assert.equal(completionEvent?.type, 'transcript');
    assert.ok(completionEvent && completionEvent.type === 'transcript');
    assert.equal(completionEvent.event.text, 'Packed Voice action completed for packed-provider-detail.');
  } finally {
    await connection.close({ code: 'user_stop' });
  }
});

test('round-trips a supplied context update through the fixture provider codec', async () => {
  let voiceRuntime: VoiceProviderRuntime | undefined;
  activatePackedTargetedClient({
    actions: { register() {} },
    voiceProviders: {
      register(id, runtime) {
        assert.equal(id, PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId);
        voiceRuntime = runtime;
      },
    },
  } as PluginClientApi);

  assert.ok(voiceRuntime && voiceRuntime.kind === 'conversation');
  const runtime = voiceRuntime;
  const navigationUpdate = 'CURRENT UI CONTEXT\n\n{"navigation":{"area":"settings","screen":"voice"}}';
  const controls = runtime.encodeContextUpdate(navigationUpdate);
  assert.equal(controls.length, 1, 'the supplied context update must enter the provider codec');
  assert.match(
    JSON.stringify(controls),
    /CURRENT UI CONTEXT.*navigation.*settings.*voice/u,
    'the fixture codec must preserve the supplied provider-bound update',
  );

  const signalController = new AbortController();
  const connection = await runtime.createConnection({
    signal: signalController.signal,
    tools: [],
  } as never);
  const controlEvents = connection.controlEvents(signalController.signal)[Symbol.asyncIterator]();
  try {
    await connection.connect(signalController.signal);
    const catalogControl = await controlEvents.next();
    assert.equal(catalogControl.done, false, 'the fixture provider must report the empty supplied catalog');
    const [catalogEvent] = runtime.protocol.decodeControl(catalogControl.value);
    assert.equal(catalogEvent?.type, 'transcript');
    assert.ok(catalogEvent && catalogEvent.type === 'transcript');
    assert.equal(
      catalogEvent.event.text,
      'Packed Voice current UI tools: none.',
    );
    const [contextControl] = controls;
    assert.ok(contextControl);
    await connection.sendControl(contextControl);
    const transcriptControl = await controlEvents.next();
    assert.equal(transcriptControl.done, false, 'the encoded context update must be observable');
    const [transcriptEvent] = runtime.protocol.decodeControl(transcriptControl.value);
    assert.equal(transcriptEvent?.type, 'transcript');
    assert.ok(transcriptEvent && transcriptEvent.type === 'transcript');
    assert.equal(
      transcriptEvent.event.text,
      `Packed Voice automatic context metadata received.\n${navigationUpdate}`,
    );
  } finally {
    await connection.close({ code: 'user_stop' });
  }
});

test('aborts the fixture\'s deliberately delayed client Action before it settles', async () => {
  let registeredActionHandler: unknown;
  activatePackedTargetedClient({
    actions: {
      register(id, handler) {
        if (id === PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId) {
          registeredActionHandler = handler;
        }
      },
    },
    voiceProviders: { register() {} },
  } as PluginClientApi);

  const actionHandler = requireClientActionHandler(registeredActionHandler);
  const controller = new AbortController();
  const pending = Promise.resolve(actionHandler({ delayMs: 60_000 }, {
    invocationSurface: 'ui',
    signal: controller.signal,
  } as never));
  controller.abort();
  await assert.rejects(
    pending,
    /packed_targeted_fixture_action_cancelled/u,
  );
});

test('only canonical PluginErrors map packed Action failures to retired or unavailable states', () => {
  assert.equal(classifyActionFailure({ code: 'stale_surface' }), 'action-error');
  assert.equal(
    classifyActionFailure(new PluginError({ code: 'stale_surface' })),
    'retired',
  );
  assert.equal(classifyActionFailure({ code: 'plugin_action_unavailable' }), 'action-error');
  assert.equal(
    classifyActionFailure(new PluginError({ code: 'plugin_action_unavailable' })),
    'platform-unavailable',
  );
});

test('refuses a plausible projection that loses the target-owned required Surface input schema', () => {
  const projection = mountedProjectionFixture();
  const invalidProjection = {
    ...projection,
    targetedSurfaceMounts: [{
      ...projection.targetedSurfaceMounts[0],
      inputSchema: {
        ...projection.targetedSurfaceMounts[0].inputSchema,
        required: [],
      },
    }],
  };

  assert.throws(
    () => assertMountedTargetedContributionProjection({
      projection: invalidProjection,
      targetGeneration: 'target-generation',
      contributorGeneration: 'contributor-generation',
      machineId: 'machine-id',
    }),
    /targeted_surface_input_schema_invalid/u,
  );
});

test('refuses a mountable-looking projection that substitutes a declarative renderer', () => {
  const projection = mountedProjectionFixture();
  const invalidProjection = {
    ...projection,
    targetedSurfaceMounts: [{
      ...projection.targetedSurfaceMounts[0],
      selectedRenderer: {
        ...projection.targetedSurfaceMounts[0].selectedRenderer,
        renderer: {
          kind: 'declarative',
          contributionId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.rendererId,
          model: {},
        },
      },
    }],
  };

  assert.throws(
    () => assertMountedTargetedContributionProjection({
      projection: invalidProjection,
      targetGeneration: 'target-generation',
      contributorGeneration: 'contributor-generation',
      machineId: 'machine-id',
    }),
    /targeted_surface_selected_react_native_renderer_invalid/u,
  );
});

test('refuses a React Native renderer that no longer belongs to the packed contributor declaration', () => {
  const projection = mountedProjectionFixture();
  const mount = projection.targetedSurfaceMounts[0];
  const invalidProjection = {
    ...projection,
    targetedSurfaceMounts: [{
      ...mount,
      selectedRenderer: {
        ...mount.selectedRenderer,
        renderer: {
          ...mount.selectedRenderer.renderer,
          contributionId: 'forged-provider-detail',
        },
      },
    }],
  };

  assert.throws(
    () => assertMountedTargetedContributionProjection({
      projection: invalidProjection,
      targetGeneration: 'target-generation',
      contributorGeneration: 'contributor-generation',
      machineId: 'machine-id',
    }),
    /targeted_projection_response_invalid/u,
  );
});

test('refuses a successful restart envelope that leaves the cold daemon identity unchanged', () => {
  const restart = {
    code: 0,
    signal: null,
    stdout: JSON.stringify({ ok: true, status: 'restarted' }),
    stderr: '',
    beforeDaemonPid: 12_345,
    afterDaemonPid: 12_345,
  };

  assert.throws(
    () => assertColdRestart(restart),
    /packed_targeted_daemon_restart_did_not_replace_runtime/u,
  );
});

test('requires target-point and contributor-targeted records to remain cold-static even though the contributor owns an Action', () => {
  const targetInstalled = {
    contributions: {
      contributions: [{
        contribution: { family: 'pluginContributionPoints', localId: 'providers' },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }],
    },
  };
  const contributorInstalled = {
    contributions: {
      contributions: [{
        contribution: { family: 'actions', localId: 'setup' },
        registration: { requirement: 'required', state: 'bound' },
        activation: { state: 'dormant' },
      }, {
        contribution: {
          family: 'actions',
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.clientActionId,
        },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }, {
        contribution: {
          family: 'voiceProviders',
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.voiceProviderId,
        },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }, {
        contribution: {
          family: 'targetedPluginContributions',
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.contributionId,
        },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }, {
        contribution: {
          family: 'actions',
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.webOnlyClientActionId,
        },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }, {
        contribution: {
          family: 'actions',
          localId: PACKED_TARGETED_CONTRIBUTION_FIXTURE.writesLocalClientActionId,
        },
        registration: { requirement: 'notRequired', state: 'notRequired' },
        activation: { state: 'notRequired' },
      }],
    },
  };

  assert.doesNotThrow(() => assertColdTargetedContributionRecords({
    targetInstalled,
    contributorInstalled,
  }));

  contributorInstalled.contributions.contributions[3].activation = { state: 'dormant' };
  assert.throws(
    () => assertColdTargetedContributionRecords({ targetInstalled, contributorInstalled }),
    /targeted_contribution_activation_required/u,
  );

  contributorInstalled.contributions.contributions[3].activation = { state: 'notRequired' };
  contributorInstalled.contributions.contributions[0].activation = { state: 'active' };
  assert.throws(
    () => assertColdTargetedContributionRecords({ targetInstalled, contributorInstalled }),
    /targeted_contributor_action_activated/u,
  );
});

test('keeps the separately packed target and contributor sources on public SDK imports only', async () => {
  await assertPackedTargetedFixtureSourcesArePublicOnly();
});
