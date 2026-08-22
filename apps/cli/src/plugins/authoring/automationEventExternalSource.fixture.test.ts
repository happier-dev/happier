import {
  AutomationEventActionHttpRequestSchemasV1,
  AutomationSourceSelectorIdV1Schema,
  createActionExecutor,
  ingestPluginManifestV2,
  parseAutomationRunExecutionRecipeV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  serializeAutomationRunExecutionRecipeV1,
  type ActionExecutorDeps,
  type AutomationEventActionHttpRequestByIdV1,
  type AutomationEventActionIdV1,
  type AutomationRunStateChangedHostEventV1,
} from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { describe, expect, it, vi } from 'vitest';

import type { Update } from '@/api/types';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { resolvePluginActionCaller } from '@/plugins/runtime/invocation/services/actionCaller';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createAutomationEventActionExecutor } from '@/plugins/runtime/automations/automationEventActionExecutor';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createBackgroundServiceRunnerHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServices';
import { getAutomationRunInvalidationAction } from '@/daemon/automation/automationRunInvalidation';
import {
  bindDeclaredEventSubscriptions,
  createStablePluginEventsBroker,
} from '@/plugins/runtime/invocation/services/events';

const fixtureRoot = new URL(
  '../../../../../packages/tests/fixtures/plugin-platform/automation-event-observer/',
  import.meta.url,
);
const fixtureModuleUrl = new URL('index.ts', fixtureRoot).href;

const PLUGIN_ID = 'com.example.automation-event-observer';
const EVENT_LOCAL_ID = 'ledger-entry-appended';
const BACKGROUND_SERVICE_ID = 'ledger-source-observer';
/**
 * Host-owned installation identity. Production reads it from the committed
 * plugin generation registry; a fixture cannot mint one for itself.
 */
const IMMUTABLE_GENERATION_ID = 'external-ledger-immutable-generation';
const AUTOMATION_ID = 'automation-external-ledger';
const TEMPLATE_VERSION = 2;
const ADOPTED_REVISION = '11';

const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '3f5b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d91',
);
const credentials = {
  token: 'token_external_source',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(3) },
};
const eventRef = Object.freeze({ pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID });
/** An external plugin is admitted from a packed archive, not from a bundle. */
const eventDeclarationRelease = Object.freeze({
  release: { pluginId: PLUGIN_ID, version: '1.0.0' },
  archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
});
/** The witness the strict admission body repeats. */
const plainAccountCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 4,
  contentKeyFingerprint: null,
});
/** The server's full Account encryption currentness response. */
const plainAccountEncryptionCurrentness = Object.freeze({
  ...plainAccountCurrentness,
  signingKeyFingerprint: null,
  updatedAt: 1_724_999_000_000,
});

function readLoadedExternalPlugin(manifest: unknown): LoadedPlugin {
  const canonical = readCanonicalPluginManifest(manifest);
  if (!canonical) throw new Error('external fixture manifest must normalize through the CLI owner');
  const pluginRootPath = fixtureRoot.pathname;
  return {
    pluginId: canonical.id,
    pluginRootPath,
    manifestPath: `${pluginRootPath}.happier-plugin/plugin.json`,
    daemonEntryPath: `${pluginRootPath}dist/index.js`,
    devDaemonEntryPath: null,
    manifest: canonical,
    sourceSpec: {
      kind: 'path',
      locator: pluginRootPath,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: canonical.version,
    },
  };
}

function buildExecutionRecipe(): string {
  const serialized = serializeAutomationRunExecutionRecipeV1({
    v: 1,
    templateVersion: TEMPLATE_VERSION,
    template: { t: 'plain', v: { v: 1, prompt: 'Triage the new ledger entry' } },
    triggerEvidence: null,
    target: {
      kind: 'newSession',
      spawn: {
        executionTarget: { serverId: 'server-external-source', machineId: 'machine-1' },
        directory: '/tmp/external-automation-source',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    },
  });
  if (serialized.kind !== 'available') throw new Error('fixture recipe must be valid');
  return serialized.serialized;
}

/**
 * Unrelated host Action arms this proof never reaches. Only the Automation
 * Event arm is wired to a real owner.
 */
function createUnrelatedActionExecutorDeps(): ActionExecutorDeps {
  const empty = async () => ({});
  return {
    executionRunStart: empty,
    executionRunList: empty,
    executionRunGet: empty,
    executionRunSend: empty,
    executionRunStop: empty,
    executionRunAction: empty,
    executionRunWait: empty,
    sessionOpen: empty,
    sessionFork: empty,
    sessionRollback: empty,
    sessionSpawnNew: empty,
    sessionModeSet: empty,
    sessionModesList: async () => ({ items: [] }),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: empty,
    sessionPermissionRespond: empty,
    sessionUserActionAnswer: empty,
    sessionTargetPrimarySet: empty,
    sessionTargetTrackedSet: empty,
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: empty,
    sessionRecentMessagesGet: empty,
    daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: empty,
    resetGlobalVoiceAgent: async () => {},
    isActionApprovalRequired: () => false,
  } as unknown as ActionExecutorDeps;
}

describe('External plugin as a first-class Automation Event source', () => {
  it('admits, projects, sources and observes one Automation Run from an external plugin', async () => {
    const { activate, manifest } = await import(fixtureModuleUrl);

    // 1. Host manifest admission accepts the external Automation source
    //    declaration and its exact setup/recovery Action bindings.
    const parsed = ingestPluginManifestV2(manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.contributes.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: EVENT_LOCAL_ID,
        kind: 'event',
        automation: expect.objectContaining({
          v: 1,
          eligible: true,
          source: expect.objectContaining({
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            setupActionRef: { pluginId: PLUGIN_ID, localId: 'setup-ledger-source' },
            historyGapResetActionRef: { pluginId: PLUGIN_ID, localId: 'reset-ledger-baseline' },
          }),
        }),
      }),
    ]));

    // 2. The external cold projection the Automation composer consumes lists
    //    the external Event with its current setup and recovery Actions.
    const registry = createResolvedContributionRegistry({
      ...projectLoadedPluginContributes({
        loadResult: { loadedPlugins: [readLoadedExternalPlugin(manifest)], diagnosticsByPluginId: {} },
        provenance: 'external',
      }),
      immutableGenerationIdsByPluginId: { [PLUGIN_ID]: IMMUTABLE_GENERATION_ID },
    });
    expect(registry.automationEligibleEvents).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
          identity: eventRef,
          immutableGenerationId: IMMUTABLE_GENERATION_ID,
          title: 'Ledger entry appended',
        }),
        setupAction: expect.objectContaining({
          identity: { pluginId: PLUGIN_ID, localId: 'setup-ledger-source' },
          immutableGenerationId: IMMUTABLE_GENERATION_ID,
        }),
        historyGapResetAction: expect.objectContaining({
          identity: { pluginId: PLUGIN_ID, localId: 'reset-ledger-baseline' },
        }),
      }),
    ]);

    // 3. The composer's create arm: the external plugin's own setup Action
    //    returns canonical source facts, and its recovery Action answers the
    //    host-filled history-gap input the same first-party sources answer.
    const testkit = await createPluginTestkit({ manifest, module: { activate } });
    const setupResult = await testkit.invokeAction(
      'setup-ledger-source',
      { ledgerId: 'main' },
      { surface: 'plugin' },
    );
    expect(PluginEventAutomationSetupResultV1Schema.parse(setupResult)).toEqual({
      v: 1,
      sourceInstanceId: 'ledger:main',
      sourceContractVersion: 1,
      sourceConfig: { v: 1, ledgerId: 'main' },
      displayLabel: 'Ledger main',
    });
    await expect(testkit.invokeAction(
      'reset-ledger-baseline',
      { automationId: AUTOMATION_ID, templateVersion: TEMPLATE_VERSION, sourceSelectorId },
      { surface: 'plugin' },
    )).resolves.toEqual({ kind: 'baselined' });

    // 4. The host stamps the external plugin's caller and adopts the stored
    //    Automation trigger definition bound to its Event source.
    const callerFixture = createPluginActionCallerMaterializationFixture(PLUGIN_ID, {
      machineId: 'machine-1',
    });
    const actionCaller = resolvePluginActionCaller({
      plugin: { id: PLUGIN_ID },
      contribution: { id: BACKGROUND_SERVICE_ID },
      immutableGenerationId: IMMUTABLE_GENERATION_ID,
      resolveCurrentPluginMaterializationRef: callerFixture.resolveCurrentPluginMaterializationRef,
    });
    expect(actionCaller).toMatchObject({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      immutableGenerationId: IMMUTABLE_GENERATION_ID,
      materialization: callerFixture.materialization,
    });

    const storedDefinition = {
      automationId: AUTOMATION_ID,
      templateVersion: TEMPLATE_VERSION,
      eventRef,
      sourceSelectorId,
      sourceContractVersion: 1,
      observationTransport: {
        kind: 'checkpointedPull' as const,
        watcherMaterializationRef: callerFixture.materialization,
      },
      storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: 'plain',
        binding: {
          v: 1,
          automationId: AUTOMATION_ID,
          templateVersion: TEMPLATE_VERSION,
          triggerKind: 'pluginEvent',
          eventRef,
          sourceSelectorId,
        },
        definition: {
          v: 1,
          sourceInstanceId: 'ledger:main',
          sourceConfig: { v: 1, ledgerId: 'main' },
          displayLabel: 'Ledger main',
          filter: null,
          maximumObservationAgeMs: null,
        },
      }),
      executionRecipe: buildExecutionRecipe(),
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', minLength: 1, maxLength: 256 },
          summary: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['entryId', 'summary'],
      },
    };
    const adoptedSet = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller: callerFixture.materialization,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      readStoredDefinitions: async ({ input }) => (input.knownRevision === ADOPTED_REVISION
        ? { kind: 'unchanged', revision: ADOPTED_REVISION, eventDeclarationRelease }
        : {
          kind: 'page',
          revision: ADOPTED_REVISION,
          eventDeclarationRelease,
          definitions: [storedDefinition],
          nextCursor: null,
        }),
      resolveAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });
    await expect(adoptedSet.refresh()).resolves.toEqual({
      kind: 'adopted',
      revision: ADOPTED_REVISION,
    });

    // 5. The real host Action pipeline: generic executor -> Automation Event
    //    executor -> adopted definitions -> one strict admission request.
    const transportRequests: AutomationEventActionHttpRequestByIdV1['automation.event.admit'][] = [];
    const automationEventAction = createAutomationEventActionExecutor({
      credentials,
      resolveAccountId: async () => 'account-external-source',
      revalidateCallerMaterialization: async (reference) => (
        reference.materializationId === callerFixture.materialization.materializationId
      ),
      revalidateCallerImmutableGeneration: async (caller) => (
        caller.immutableGenerationId === IMMUTABLE_GENERATION_ID
      ),
      resolveAdoptedDefinitionSet: () => adoptedSet,
      transport: {
        execute: async <TActionId extends AutomationEventActionIdV1>(
          actionId: TActionId,
          request: AutomationEventActionHttpRequestByIdV1[TActionId],
        ) => {
          if (actionId !== 'automation.event.admit') return {};
          transportRequests.push(
            request as AutomationEventActionHttpRequestByIdV1['automation.event.admit'],
          );
          return {
            results: [{ kind: 'admitted', runId: 'run-external-1', checkpointSafe: true }],
            continuation: { kind: 'ready', accountCurrentness: plainAccountCurrentness },
          };
        },
      },
    });
    const hostActionExecutor = createActionExecutor({
      ...createUnrelatedActionExecutorDeps(),
      automationEventAction: async (args) => await automationEventAction(args),
    });

    const invocationController = new AbortController();
    const actionsService = createPluginInvocationActionsService({
      seed: {
        plugin: { id: PLUGIN_ID, version: '1.0.0' },
        contribution: {
          id: BACKGROUND_SERVICE_ID,
          qualifiedId: `${PLUGIN_ID}/${BACKGROUND_SERVICE_ID}`,
        },
        generation: 'external-ledger-generation',
        immutableGenerationId: IMMUTABLE_GENERATION_ID,
        surface: 'background',
        resolveCurrentPluginMaterializationRef:
          callerFixture.resolveCurrentPluginMaterializationRef,
        signal: invocationController.signal,
        isGenerationCurrent: () => true,
      },
      actionExecutor: hostActionExecutor,
      invokeContributedAction: async () => {
        throw new Error('this proof never reaches a contributed Action');
      },
    });

    // 6. The real host background-service owner starts the external plugin's
    //    OWN declared service. The runner comes from the plugin's activation
    //    registration rather than a module export, so the contributed service
    //    is what drives the cycle.
    const logInfo = vi.fn();
    const registeredRunner = testkit.registration('backgroundServices', BACKGROUND_SERVICE_ID);
    expect(registeredRunner).toEqual(expect.any(Function));
    if (!registeredRunner) {
      await testkit.dispose();
      throw new Error('external fixture must register its Automation source background service');
    }
    const serviceDiagnostics: unknown[] = [];
    const serviceHost = createBackgroundServiceRunnerHost({
      registrations: [{
        pluginId: PLUGIN_ID,
        pluginVersion: '1.0.0',
        generation: 'external-ledger-generation',
        localId: BACKGROUND_SERVICE_ID,
        runner: registeredRunner,
      }],
      createContext: ({ signal }) => ({
        context: Object.freeze({
          surface: 'background',
          signal,
          services: Object.freeze({
            actions: actionsService,
            logger: Object.freeze({ info: logInfo }),
          }),
        }) as never,
        complete: () => {},
      }),
      onDiagnostic: (event) => { serviceDiagnostics.push(event); },
    });
    serviceHost.start();
    await serviceHost.settle([PLUGIN_ID]);
    await serviceHost.dispose();
    // A runner that threw or never settled is visible only as a diagnostic.
    expect(serviceDiagnostics).toEqual([]);

    expect(transportRequests).toHaveLength(1);
    const request = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].parse(
      transportRequests[0],
    );
    expect(request.caller).toMatchObject({
      pluginId: PLUGIN_ID,
      immutableGenerationId: IMMUTABLE_GENERATION_ID,
      materialization: callerFixture.materialization,
    });
    expect(request.hostEvidence).toMatchObject({
      v: 1,
      t: 'plain',
      accountCurrentness: plainAccountCurrentness,
    });
    // A plain Account keeps the raw Event input on the request; the E2EE arm
    // replaces it with stripped host evidence and is owned by its own test.
    expect(request.hostEvidence.t).toBe('plain');
    if (!('input' in request)) throw new Error('plain admission keeps its Event input');
    expect(request.input.eventRef).toEqual(eventRef);
    expect(request.input.definitions).toEqual([{
      automationId: AUTOMATION_ID,
      templateVersion: TEMPLATE_VERSION,
      sourceSelectorId,
    }]);
    expect(logInfo).toHaveBeenCalledWith('automation_event_source.admitted', {
      occurrenceId: 'entry-1',
      results: [{ kind: 'admitted', runId: 'run-external-1', checkpointSafe: true }],
    });

    // 7. The Run the external source produced carries the external plugin's
    //    own execution recipe, so the fired Automation is genuinely its own.
    const recipe = parseAutomationRunExecutionRecipeV1(storedDefinition.executionRecipe);
    expect(recipe.kind).toBe('available');

    // 8. The committed Run lifecycle reaches the same external plugin: the
    //    daemon worker's invalidation owner and the plugin's own subscription.
    const lifecyclePayload = Object.freeze({
      runId: 'run-external-1',
      automationId: AUTOMATION_ID,
      originKind: 'pluginEvent',
      previousState: 'claimed',
      currentState: 'running',
      transitionedAt: 1_725_000_000_500,
      claimedByMachineId: 'machine-2',
    } satisfies AutomationRunStateChangedHostEventV1);
    const lifecycleUpdate = {
      body: { t: 'automation-run-state-changed', ...lifecyclePayload },
    } as unknown as Update;
    expect(getAutomationRunInvalidationAction({
      update: lifecycleUpdate,
      active: { runId: 'run-external-1', attempt: 1 },
      machineId: 'machine-1',
    })).toBe('abort');

    const observerHandler = testkit.registration('events', 'observe-run-state-changed');
    expect(observerHandler).toEqual(expect.any(Function));
    if (!observerHandler) {
      await testkit.dispose();
      throw new Error('external fixture must register its lifecycle observer');
    }
    const observed = vi.fn();
    const broker = createStablePluginEventsBroker({ onHostListenerError: () => {} });
    const binding = bindDeclaredEventSubscriptions({
      host: {
        broker,
        declarationsByPluginId: new Map([[PLUGIN_ID, parsed.manifest.contributes.events]]),
        activePluginIds: new Set([PLUGIN_ID]),
      },
      registrations: [{
        pluginId: PLUGIN_ID,
        pluginVersion: '1.0.0',
        generation: 'external-ledger-generation',
        localId: 'observe-run-state-changed',
        handler: observerHandler,
      }],
      isGenerationCurrent: () => true,
      createContext: ({ signal }) => ({
        context: Object.freeze({
          signal,
          services: Object.freeze({ logger: Object.freeze({ info: observed }) }),
        }) as never,
        complete: () => {},
      }),
    });
    try {
      broker.publishHostEventEnvelope({
        eventId: '@happier/automation/run-state-changed',
        scope: { kind: 'account' },
        payload: lifecyclePayload,
      });
      await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(
        'automation_event_observer.received',
        { transition: lifecyclePayload },
      ));
    } finally {
      await binding.dispose();
      await testkit.dispose();
    }
  });
});
