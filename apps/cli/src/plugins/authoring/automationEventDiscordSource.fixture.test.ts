import {
  AutomationEventActionHttpRequestSchemasV1,
  AutomationSourceSelectorIdV1Schema,
  createActionExecutor,
  ingestPluginManifestV2,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  serializeAutomationRunExecutionRecipeV1,
  type ActionExecutorDeps,
  type AutomationEventActionHttpRequestByIdV1,
  type AutomationEventActionIdV1,
} from '@happier-dev/protocol';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createAutomationEventActionExecutor } from '@/plugins/runtime/automations/automationEventActionExecutor';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createBackgroundServiceRunnerHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServices';

/**
 * The Discord Channels plugin is loaded from its own source module by URL, the
 * way an installed path plugin is loaded, so this proof exercises the plugin's
 * real manifest and activation rather than a restatement of them.
 */
const discordPluginRoot = new URL(
  '../../../../../packages/plugins/channel-discord/',
  import.meta.url,
);
const discordPluginModuleUrl = new URL('src/plugin.ts', discordPluginRoot).href;
const discordEventModuleUrl = new URL('src/discordAutomationEvent.ts', discordPluginRoot).href;

const PLUGIN_ID = 'happier.channel.discord';
const EVENT_LOCAL_ID = 'automation/channel-message-observed-v1';
const SETUP_ACTION_ID = 'automation/setup-channel-message-source-v1';
const GATEWAY_WORKER_ATTEMPT_ACTION_ID = 'discord/gateway-worker-attempt';
const BACKGROUND_SERVICE_ID = 'gateway-supervisor';
const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const IMMUTABLE_GENERATION_ID = 'discord-immutable-generation';
const AUTOMATION_ID = 'automation-discord-triage';
const TEMPLATE_VERSION = 2;
const ADOPTED_REVISION = '11';

const APPLICATION_ID = '111222333444555666';
const BOT_USER_ID = '999888777666555444';
const CHANNEL_ID = '424242424242424242';
const MESSAGE_ID = '900190019001900190';
const MESSAGE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '7c2f9b41-3d55-4a08-9e6b-1f2c3d4e5a6b',
);
const credentials = {
  token: 'token_discord_source',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(5) },
};
const eventRef = Object.freeze({ pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID });
const credentialRef = Object.freeze({
  service: Object.freeze({ pluginId: PLUGIN_ID, localId: 'discord-bot' }),
  accountId: 'bot:happier',
});
const eventDeclarationRelease = Object.freeze({
  release: { pluginId: PLUGIN_ID, version: '0.0.0' },
  archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
});
const plainAccountCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 4,
  contentKeyFingerprint: null,
});
const plainAccountEncryptionCurrentness = Object.freeze({
  ...plainAccountCurrentness,
  signingKeyFingerprint: null,
  updatedAt: 1_767_225_000_000,
});

function readLoadedDiscordPlugin(manifest: unknown): LoadedPlugin {
  const canonical = readCanonicalPluginManifest(manifest);
  if (!canonical) throw new Error('the Discord manifest must normalize through the CLI owner');
  const pluginRootPath = discordPluginRoot.pathname;
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
    template: { t: 'plain', v: { v: 1, prompt: 'Triage the new Discord message' } },
    triggerEvidence: null,
    target: {
      kind: 'newSession',
      spawn: {
        executionTarget: { serverId: 'server-discord-source', machineId: 'machine-1' },
        directory: '/tmp/discord-automation-source',
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

function discordRestResponse(value: unknown) {
  return {
    status: 200,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

/** The exact Discord Gateway frames a watched channel message arrives in. */
const GATEWAY_FRAMES: readonly unknown[] = Object.freeze([
  { op: 10, d: { heartbeat_interval: 60_000 } },
  {
    op: 0,
    s: 1,
    t: 'READY',
    d: {
      session_id: 'session-1',
      resume_gateway_url: 'wss://gateway.discord.gg/?v=10&encoding=json',
    },
  },
  {
    op: 0,
    s: 2,
    t: 'MESSAGE_CREATE',
    d: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
      timestamp: MESSAGE_TIMESTAMP,
      type: 0,
      content: '<@999888777666555444> please triage the failing deploy',
      author: { id: '555444333222111000', bot: false },
      mentions: [{ id: BOT_USER_ID }],
      attachments: [],
      embeds: [],
    },
  },
]);

function discordGatewaySocket() {
  const pending = [...GATEWAY_FRAMES];
  return {
    url: 'wss://gateway.discord.gg/?v=10&encoding=json',
    protocol: '',
    // 4004 ends the session after the dispatch drains, exactly as the provider's
    // own worker proof does; the observation is admitted before teardown.
    closed: Promise.resolve({ kind: 'remote', code: 4_004, wasClean: true }),
    send: vi.fn(async () => undefined),
    receive: vi.fn(async () => {
      const frame = pending.shift();
      return frame === undefined
        ? { kind: 'closed' as const, close: { kind: 'remote' as const, code: 4_004, wasClean: true } }
        : { kind: 'text' as const, text: JSON.stringify(frame) };
    }),
    close: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

const connectionSnapshot = Object.freeze({
  v: 1,
  connectionId: 'connection-1',
  providerConnectionKey: `discord:application:${APPLICATION_ID}`,
  providerConfigVersion: 1,
  providerConfig: { applicationId: APPLICATION_ID, botUserId: BOT_USER_ID },
  credentialRef,
  authorityEpoch: 7,
  enabled: true,
  deletionState: 'none',
  requiresFullSharedMessageContent: false,
});

describe('Discord Channels as a first-class Automation Event source', () => {
  it('withholds the Discord Event while keeping the observer vertical provable end to end', async () => {
    const { PLUGIN_MANIFEST, activate } = await import(discordPluginModuleUrl);
    const { DISCORD_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA } = await import(discordEventModuleUrl);

    // 1. The withheld claim. This provider persists no Gateway position, so
    //    `checkpointedPull` has nothing to resume from after process loss or a
    //    plugin reload, and `durablePush` is unrepresentable without a webhook
    //    endpoint id. Until a real history-capable observer exists the plugin
    //    declares no Event at all, so the host admits none.
    const parsed = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.contributes.events).toEqual([]);

    // 2. The exact cold projection the Automation composer reads. Discord must
    //    not appear in it: "when Discord does X" is not a selectable trigger.
    const registry = createResolvedContributionRegistry({
      ...projectLoadedPluginContributes({
        loadResult: {
          loadedPlugins: [readLoadedDiscordPlugin(PLUGIN_MANIFEST)],
          diagnosticsByPluginId: {},
        },
        provenance: 'external',
      }),
      immutableGenerationIdsByPluginId: { [PLUGIN_ID]: IMMUTABLE_GENERATION_ID },
    });
    expect(registry.automationEligibleEvents ?? []).toEqual([]);

    // Everything below is the retained observer work the withheld declaration
    // would activate: the plugin's own setup Action, its live Gateway ingress,
    // its Automation fan-out, and the real host admission pipeline. It is
    // driven here from an adopted definition supplied directly to the host, so
    // it stays an executable proof — and the harness a follow-up lane re-points
    // at the manifest once a history-capable observer earns the declaration.

    // 3. Host wiring shared by the composer's setup arm and the running
    //    provider: one caller materialization and one adopted definition set.
    const callerFixture = createPluginActionCallerMaterializationFixture(PLUGIN_ID, {
      machineId: 'machine-1',
    });
    const admitRequests: AutomationEventActionHttpRequestByIdV1['automation.event.admit'][] = [];
    const observationIngests: unknown[] = [];

    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { DISCORD_BOT_TOKEN: 'bot-token' },
      })),
    };
    const socket = discordGatewaySocket();
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => {
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return discordRestResponse({ id: APPLICATION_ID, flags: 0, flags_new: '0' });
        }
        if (request.url.endsWith('/users/@me')) {
          return discordRestResponse({ id: BOT_USER_ID, username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/gateway/bot')) {
          return discordRestResponse({
            url: 'wss://gateway.discord.gg/',
            shards: 1,
            session_start_limit: {
              total: 1_000,
              remaining: 1_000,
              reset_after: 86_400_000,
              max_concurrency: 16,
            },
          });
        }
        if (request.url.endsWith(`/channels/${CHANNEL_ID}`)) {
          return discordRestResponse({ id: CHANNEL_ID, type: 0, name: 'deploys' });
        }
        throw new Error(`Unexpected Discord request ${request.url}`);
      }),
      openWebSocket: vi.fn(async () => socket),
    };

    // 4. The composer's create arm runs the plugin's OWN registered setup
    //    Action against the real Discord REST boundary.
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { http, connectedAccounts } as never,
    });
    let setupResult: unknown;
    try {
      setupResult = await testkit.invokeAction(
        SETUP_ACTION_ID,
        { credentialRef, channelId: CHANNEL_ID },
        { surface: 'plugin' },
      );
    } catch (error) {
      await testkit.dispose();
      throw error;
    }
    const source = PluginEventAutomationSetupResultV1Schema.parse(setupResult);
    expect(source).toEqual({
      v: 1,
      sourceInstanceId: `discord:application:${APPLICATION_ID}:channel:${CHANNEL_ID}`,
      sourceContractVersion: 1,
      sourceConfig: { v: 1, applicationId: APPLICATION_ID, channelId: CHANNEL_ID },
      displayLabel: '#deploys',
    });

    // 5. The stored Automation the host adopts for this Machine's watcher. Its
    //    payload schema is still the plugin's own retained contract, read from
    //    the module the withheld declaration would have pointed the manifest at,
    //    not a restatement.
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
          sourceInstanceId: source.sourceInstanceId,
          sourceConfig: source.sourceConfig,
          displayLabel: source.displayLabel,
          filter: null,
          maximumObservationAgeMs: null,
        },
      }),
      executionRecipe: buildExecutionRecipe(),
      payloadSchema: DISCORD_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA,
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

    // 6. The real host Action pipeline the plugin reaches through the SDK.
    const automationEventAction = createAutomationEventActionExecutor({
      credentials,
      resolveAccountId: async () => 'account-discord-source',
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
          admitRequests.push(
            request as AutomationEventActionHttpRequestByIdV1['automation.event.admit'],
          );
          return {
            results: [{ kind: 'admitted', runId: 'run-discord-1', checkpointSafe: true }],
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
        plugin: { id: PLUGIN_ID, version: '0.0.0' },
        contribution: {
          id: BACKGROUND_SERVICE_ID,
          qualifiedId: `${PLUGIN_ID}/${BACKGROUND_SERVICE_ID}`,
        },
        generation: 'discord-generation',
        immutableGenerationId: IMMUTABLE_GENERATION_ID,
        surface: 'background',
        resolveCurrentPluginMaterializationRef:
          callerFixture.resolveCurrentPluginMaterializationRef,
        signal: invocationController.signal,
        isGenerationCurrent: () => true,
      },
      actionExecutor: hostActionExecutor,
      // Channels core and the provider's own worker-attempt Action are real
      // contributed Actions. Core is the boundary this proof stands in for; the
      // provider's own Action is dispatched to its OWN registered handler.
      invokeContributedAction: async ({ action, input, signal }: Readonly<{
        action: Readonly<{ pluginId: string; localId: string }>;
        input: unknown;
        signal?: AbortSignal;
      }>) => {
        const executed = (value: unknown) => ({ status: 'executed' as const, value });
        if (action.pluginId === CHANNELS_CORE_PLUGIN_ID) {
          if (action.localId === 'provider/connections-list-v1') {
            return executed({ 'connection-1': connectionSnapshot });
          }
          if (action.localId === 'provider/observation-ingest-v1') {
            observationIngests.push(input);
            return executed({});
          }
          if (action.localId === 'provider/transport-fact-report-v1') {
            return executed({ kind: 'recorded' });
          }
        }
        if (action.pluginId === PLUGIN_ID && action.localId === GATEWAY_WORKER_ATTEMPT_ACTION_ID) {
          return executed(await testkit.invokeAction(
            GATEWAY_WORKER_ATTEMPT_ACTION_ID,
            input as never,
            {
              surface: 'plugin',
              ...(signal ? { signal } : {}),
              services: { http, connectedAccounts, actions: pluginActions } as never,
            },
          ));
        }
        throw new Error(`Unexpected contributed Action ${action.pluginId}/${action.localId}`);
      },
    } as never);

    // One activation-local Actions binding reaches the host for the background
    // reconciliation loop and for the provider's own worker-attempt Action.
    const pluginActions = actionsService;

    // 7. The real host background-service owner starts the plugin's OWN
    //    declared Gateway supervisor, which opens the socket, receives the
    //    Discord dispatch, and admits it to Channels and to the Automation.
    const registeredRunner = testkit.registration('backgroundServices', BACKGROUND_SERVICE_ID);
    expect(registeredRunner).toEqual(expect.any(Function));
    if (!registeredRunner) {
      await testkit.dispose();
      throw new Error('the Discord plugin must register its Gateway supervisor');
    }
    const serviceDiagnostics: unknown[] = [];
    const serviceHost = createBackgroundServiceRunnerHost({
      registrations: [{
        pluginId: PLUGIN_ID,
        pluginVersion: '0.0.0',
        generation: 'discord-generation',
        localId: BACKGROUND_SERVICE_ID,
        runner: registeredRunner,
      }],
      createContext: ({ signal }) => ({
        context: Object.freeze({
          plugin: { id: PLUGIN_ID, version: '0.0.0' },
          contribution: {
            id: BACKGROUND_SERVICE_ID,
            qualifiedId: `${PLUGIN_ID}/${BACKGROUND_SERVICE_ID}`,
          },
          surface: 'background',
          signal,
          services: Object.freeze({
            actions: pluginActions,
            connectedAccounts,
            http,
            logger: Object.freeze({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
              diagnostic: vi.fn(),
            }),
          }),
        }) as never,
        complete: () => {},
      }),
      onDiagnostic: (event) => { serviceDiagnostics.push(event); },
    });
    try {
      serviceHost.start();
      await vi.waitFor(() => expect(admitRequests).toHaveLength(1), { timeout: 15_000 });
    } finally {
      await serviceHost.dispose();
      await testkit.dispose();
    }
    expect(serviceDiagnostics).toEqual([]);
    // The proof ran the provider's real Gateway path, not a stand-in for it.
    expect(http.openWebSocket).toHaveBeenCalledWith(
      { url: 'wss://gateway.discord.gg/?v=10&encoding=json' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(socket.receive.mock.calls.length).toBeGreaterThanOrEqual(GATEWAY_FRAMES.length);

    // 8. Channels still received the same observation: the Automation Event is
    //    an additive consumer of the one ingress, not a second one.
    expect(observationIngests).toEqual([expect.objectContaining({
      connectionId: 'connection-1',
      observation: expect.objectContaining({ kind: 'fullText' }),
    })]);

    // 9. The strict admission request the host actually sends for the Run.
    const request = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].parse(
      admitRequests[0],
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
    if (!('input' in request)) throw new Error('plain admission keeps its Event input');
    expect(request.input.eventRef).toEqual(eventRef);
    expect(request.input.occurrenceId).toBe(`discord:message:${MESSAGE_ID}`);
    expect(request.input.occurredAt).toBe(Date.parse(MESSAGE_TIMESTAMP));
    expect(request.input.payload).toEqual({
      v: 1,
      channelId: CHANNEL_ID,
      channelKind: 'shared',
      messageId: MESSAGE_ID,
      text: '<@999888777666555444> please triage the failing deploy',
      textTruncated: false,
      addressingEvidence: 'directIntegrationMention',
      contentProvenance: 'original',
      actorKind: 'human',
      actorPrincipalId: 'discord:user:555444333222111000',
    });
    expect(request.input.definitions).toEqual([{
      automationId: AUTOMATION_ID,
      templateVersion: TEMPLATE_VERSION,
      sourceSelectorId,
    }]);
  }, 30_000);
});
