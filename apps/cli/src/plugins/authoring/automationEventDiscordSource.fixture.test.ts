import {
  createActionExecutor,
  ingestPluginManifestV2,
  StrictJsonValueSchema,
  type ActionExecutorDeps,
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

const PLUGIN_ID = 'happier.channel.discord';
const EVENT_LOCAL_ID = 'automation/channel-message-observed-v1';
const SETUP_ACTION_ID = 'automation/setup-channel-message-source-v1';
const ADMIT_ACTION_ID = 'discord/admit-automation-event';
const GATEWAY_WORKER_ATTEMPT_ACTION_ID = 'discord/gateway-worker-attempt';
const BACKGROUND_SERVICE_ID = 'gateway-supervisor';
const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const IMMUTABLE_GENERATION_ID = 'discord-immutable-generation';

const APPLICATION_ID = '111222333444555666';
const BOT_USER_ID = '999888777666555444';
const CHANNEL_ID = '424242424242424242';
const MESSAGE_ID = '900190019001900190';
const MESSAGE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const credentialRef = Object.freeze({
  service: Object.freeze({ pluginId: PLUGIN_ID, localId: 'discord-bot' }),
  accountId: 'bot:happier',
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
    // own worker proof does; the observation reaches Channels before teardown.
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
  it('projects its Event and sends the real Gateway candidate through Channels ingress', async () => {
    const { PLUGIN_MANIFEST, activate } = await import(discordPluginModuleUrl);
    const parsed = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('the Discord manifest must ingest');

    // The cold CLI registry is the projection the Automation composer actually
    // reads. This is not a fixture TargetedContributionsService.
    const registry = createResolvedContributionRegistry({
      ...projectLoadedPluginContributes({
        loadResult: {
          loadedPlugins: [readLoadedDiscordPlugin(PLUGIN_MANIFEST)],
          diagnosticsByPluginId: {},
        },
        // This source module is the bundled first-party plugin under test;
        // treating it as an external path plugin would add the same bundled
        // locator as a reference and manufacture a duplicate identity.
        provenance: 'first_party',
      }),
      immutableGenerationIdsByPluginId: { [PLUGIN_ID]: IMMUTABLE_GENERATION_ID },
    });
    expect(registry.automationEligibleEvents).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
          identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
          immutableGenerationId: IMMUTABLE_GENERATION_ID,
        }),
        setupAction: expect.objectContaining({
          identity: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_ID },
          immutableGenerationId: IMMUTABLE_GENERATION_ID,
        }),
      }),
    ]);
    expect(registry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definition: expect.objectContaining({
          id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
          automation: expect.objectContaining({
            eligible: true,
            source: expect.objectContaining({
              supportedObservationTransports: ['checkpointedPull'],
              setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_ID },
            }),
          }),
        }),
      }),
    ]));
    expect(registry.actions.map((action) => action.identity?.localId)).toEqual(expect.arrayContaining([
      SETUP_ACTION_ID,
      ADMIT_ACTION_ID,
      GATEWAY_WORKER_ATTEMPT_ACTION_ID,
    ]));

    const callerFixture = createPluginActionCallerMaterializationFixture(PLUGIN_ID, {
      machineId: 'machine-1',
    });
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { DISCORD_BOT_TOKEN: 'bot-token' },
      })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
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
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { http, connectedAccounts } as never,
    });
    const invocationController = new AbortController();
    const observationIngests: unknown[] = [];
    const coreActionIds: string[] = [];

    let pluginActions: ReturnType<typeof createPluginInvocationActionsService>;
    pluginActions = createPluginInvocationActionsService({
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
      actionExecutor: createActionExecutor(createUnrelatedActionExecutorDeps()),
      invokeContributedAction: async ({ action, input, signal }) => {
        const executed = (value: unknown) => ({
          status: 'executed' as const,
          value: StrictJsonValueSchema.parse(value),
        });
        if (action.pluginId === CHANNELS_CORE_PLUGIN_ID) {
          coreActionIds.push(action.localId);
          if (action.localId === 'provider/connections-list-v1') {
            return executed({ 'connection-1': connectionSnapshot });
          }
          if (action.localId === 'provider/connection-read-v1') {
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
              ...(signal === undefined ? {} : { signal }),
              services: { http, connectedAccounts, actions: pluginActions } as never,
            },
          ));
        }
        throw new Error(`Unexpected contributed Action ${action.pluginId}/${action.localId}`);
      },
    });

    const serviceDiagnostics: unknown[] = [];
    const registeredRunner = testkit.registration('backgroundServices', BACKGROUND_SERVICE_ID);
    expect(registeredRunner).toEqual(expect.any(Function));
    if (!registeredRunner) {
      await testkit.dispose();
      throw new Error('the Discord plugin must register its Gateway supervisor');
    }
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
      const setupResult = await testkit.invokeAction(
        SETUP_ACTION_ID,
        { credentialRef, channelId: CHANNEL_ID },
        { surface: 'plugin' },
      );
      const source = PluginEventAutomationSetupResultV1Schema.parse(setupResult);
      expect(source).toEqual({
        v: 1,
        sourceInstanceId: `discord:application:${APPLICATION_ID}:channel:${CHANNEL_ID}`,
        sourceContractVersion: 1,
        sourceConfig: { v: 1, applicationId: APPLICATION_ID, channelId: CHANNEL_ID },
        displayLabel: '#deploys',
      });

      serviceHost.start();
      await vi.waitFor(() => expect(coreActionIds).toContain('provider/connections-list-v1'), { timeout: 15_000 });
      await vi.waitFor(() => expect(observationIngests).toHaveLength(1), { timeout: 15_000 });
    } finally {
      invocationController.abort(new Error('Discord fixture complete.'));
      await serviceHost.dispose();
      await testkit.dispose();
    }

    expect(serviceDiagnostics).toEqual([]);
    expect(coreActionIds).toEqual(expect.arrayContaining([
      'provider/connections-list-v1',
      'provider/connection-read-v1',
      'provider/observation-ingest-v1',
    ]));
    expect(http.openWebSocket).toHaveBeenCalledWith(
      { url: 'wss://gateway.discord.gg/?v=10&encoding=json' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(socket.receive.mock.calls.length).toBeGreaterThanOrEqual(GATEWAY_FRAMES.length);
    expect(observationIngests).toEqual([{
      connectionId: 'connection-1',
      entry: {
        observation: {
          kind: 'fullText',
          observation: expect.objectContaining({
            occurrenceId: `discord:message:${MESSAGE_ID}`,
            message: expect.objectContaining({
              text: '<@999888777666555444> please triage the failing deploy',
            }),
          }),
        },
        eventCandidate: {
          eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
          sourceInstanceId: `discord:application:${APPLICATION_ID}:channel:${CHANNEL_ID}`,
          sourceContractVersion: 1,
          payload: {
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
          },
        },
      },
    }]);
  }, 30_000);
});
