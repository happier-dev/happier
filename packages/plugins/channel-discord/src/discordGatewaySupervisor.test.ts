import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionReadInputV1Schema,
  ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
} from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createDiscordGatewaySupervisor,
  requireDiscordGatewayRuntimeFactsFromCoreSnapshot,
  type DiscordGatewaySupervisor,
} from './discordGatewaySupervisor.js';
import type { DiscordGatewayWorkerResult } from './discordGatewayWorker.js';
import {
  DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
} from './discordPluginConstants.js';
import { DISCORD_MESSAGE_CONTENT_INTENT } from './discordSetup.js';

const credentialRef = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.channel.discord', localId: 'discord-bot' }),
  accountId: 'bot:bot-1',
});

function snapshot(
  overrides: Partial<ConversationProviderConnectionReconciliationSnapshotV1> = {},
): ConversationProviderConnectionReconciliationSnapshotV1 {
  // The snapshot is a discriminated union on `deletionState`; the spread of an
  // open `Partial` erases that narrowing, so the composed value is reparsed
  // through the canonical protocol schema instead of asserted into an arm.
  return ConversationProviderConnectionReconciliationSnapshotV1Schema.parse({
    v: 1,
    connectionId: 'connection-1',
    providerConnectionKey: 'discord:application:application-1',
    providerConfigVersion: 1,
    providerConfig: {
      applicationId: 'application-1',
      botUserId: 'bot-1',
      inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
    },
    credentialRef,
    authorityEpoch: 7,
    enabled: true,
    deletionState: 'none',
    requiresFullSharedMessageContent: false,
    ...overrides,
  });
}

function backgroundContext(
  services: Readonly<{
    actions: Partial<PluginInvocationContext['services']['actions']>;
    connectedAccounts: Partial<PluginInvocationContext['services']['connectedAccounts']>;
    http: Partial<PluginInvocationContext['services']['http']>;
  }>,
  signal: AbortSignal = new AbortController().signal,
): BackgroundServiceContext {
  return {
    plugin: { id: 'happier.channel.discord', version: '0.0.0' },
    contribution: {
      id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
      qualifiedId: `happier.channel.discord/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}`,
    },
    surface: 'background',
    invokedAtMs: 1_700_000_000_000,
    signal,
    // These are the genuine host boundaries used by the supervisor; no provider
    // parsing, lifecycle, or admission behavior is substituted in this fixture.
    // The host always supplies a logger to a background service, so the
    // fixture supplies one rather than letting an absent boundary look like
    // supervisor behavior.
    services: {
      ...services,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        diagnostic: vi.fn(),
      },
    } as unknown as PluginInvocationContext['services'],
  };
}

function supervisorBackgroundHarness(input: Readonly<{
  supervisor: DiscordGatewaySupervisor;
  connectedAccounts: Partial<PluginInvocationContext['services']['connectedAccounts']>;
  http: Partial<PluginInvocationContext['services']['http']>;
  executeCore: (
    action: Readonly<{ pluginId: string; localId: string }>,
    actionInput: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  executeAutomation?: (action: string, actionInput: unknown) => Promise<unknown>;
  /** Exact current core result for tests that need a list/read race. */
  readConnection?: (connectionId: string) => Promise<ConversationProviderConnectionReconciliationSnapshotV1 | null>;
  signal?: AbortSignal;
}>): Readonly<{
  actions: Readonly<{ execute: ReturnType<typeof vi.fn> }>;
  background: BackgroundServiceContext;
}> {
  let background!: BackgroundServiceContext;
  let lastListedConnections: Record<string, ConversationProviderConnectionReconciliationSnapshotV1> = {};
  const actions = {
    execute: vi.fn(async (
      action: Readonly<{ pluginId: string; localId: string }> | string,
      actionInput: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<void | ProtocolJsonValue> => {
      if (typeof action === 'string') {
        if (input.executeAutomation === undefined) throw new Error(`Unexpected Automation Action ${action}`);
        return await input.executeAutomation(action, actionInput) as void | ProtocolJsonValue;
      }
      if (
        action.pluginId === 'happier.channel.discord'
        && action.localId === DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID
      ) {
        await input.supervisor.runWorkerAttempt(
          ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(actionInput),
          {
            plugin: background.plugin,
            contribution: {
              id: DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
              qualifiedId: `happier.channel.discord/actions/${DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID}`,
            },
            surface: 'plugin',
            invokedAtMs: background.invokedAtMs,
            caller: {
              kind: 'plugin',
              pluginId: background.plugin.id,
              occurrenceId: 'discord-generation-1',
              sourceCustody: { kind: 'managed', immutableGenerationId: 'discord-generation-1', installSource: 'npm' },
              contribution: background.contribution,
              materialization: {
                machineId: 'discord-supervisor-fixture-machine',
                materializationId: 'discord-supervisor-fixture-materialization',
                pluginId: background.plugin.id,
              },
              originSurface: 'background',
            },
            signal: options?.signal ?? background.signal,
            services: {
              ...background.services,
              logger: {
                ...background.services.logger,
                info(message, fields) {
                  // The real host retires an Action's logger on cancellation.
                  if (!(options?.signal ?? background.signal).aborted) background.services.logger.info(message, fields);
                },
              },
            },
          } as PluginInvocationContext,
        );
        return undefined;
      }
      if (
        action.pluginId === 'happier.channels'
        && action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList
      ) {
        const result = await input.executeCore(action, actionInput, options);
        const parsed = ConversationProviderConnectionsSnapshotV1Schema.safeParse(result);
        lastListedConnections = parsed.success ? parsed.data : {};
        return result as void | ProtocolJsonValue;
      }
      if (
        action.pluginId === 'happier.channels'
        && action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead
      ) {
        const parsed = ConversationProviderConnectionReadInputV1Schema.safeParse(actionInput);
        if (!parsed.success) return {};
        const snapshot = input.readConnection === undefined
          ? lastListedConnections[parsed.data.connectionId] ?? null
          : await input.readConnection(parsed.data.connectionId);
        return snapshot === null ? {} : { [snapshot.connectionId]: snapshot };
      }
      return await input.executeCore(action, actionInput, options) as void | ProtocolJsonValue;
    }),
  };
  background = backgroundContext(
    { actions, connectedAccounts: input.connectedAccounts, http: input.http },
    input.signal,
  );
  return Object.freeze({ actions, background });
}

function channelsCoreContext(): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channel.discord', version: '0.0.0' },
    contribution: {
      id: 'channels/connection-stop-v1',
      qualifiedId: 'happier.channel.discord/actions/channels/connection-stop-v1',
    },
    surface: 'plugin',
    invokedAtMs: 1_700_000_000_000,
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      occurrenceId: 'channels-generation-1',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-generation-1', installSource: 'npm' },
      contribution: {
        id: 'connection-delete-v1',
        qualifiedId: 'happier.channels/actions/connection-delete-v1',
      },
      materialization: {
        machineId: 'discord-supervisor-fixture-machine',
        materializationId: 'discord-supervisor-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    signal: new AbortController().signal,
    services: {} as PluginInvocationContext['services'],
  };
}

function response(value: unknown): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status: 200,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function gatewaySocketUntilStopped(
  onIdentify: () => void,
  readySessionId?: string,
): PluginWebSocketConnection & Readonly<{ sent: ReturnType<typeof vi.fn>; push(frame: unknown): void }> {
  let helloPending = true;
  let readyPending = readySessionId !== undefined;
  let resolveBlockedReceive: ((value: Awaited<ReturnType<PluginWebSocketConnection['receive']>>) => void) | null = null;
  const sent = vi.fn(async (message: unknown) => {
    if (
      typeof message === 'object'
      && message !== null
      && 'kind' in message
      && message.kind === 'text'
      && 'text' in message
      && typeof message.text === 'string'
      && JSON.parse(message.text).op === 2
    ) {
      onIdentify();
    }
  });
  const close = vi.fn(() => {
    resolveBlockedReceive?.({
      kind: 'closed',
      close: { kind: 'generationRetired', wasClean: true },
    });
    resolveBlockedReceive = null;
  });
  return {
    url: 'wss://gateway.discord.gg/?v=10&encoding=json',
    protocol: '',
    closed: Promise.resolve({ kind: 'generationRetired', wasClean: true }),
    sent,
    push(frame) {
      if (resolveBlockedReceive === null) throw new Error('Gateway fixture is not waiting for a frame.');
      const receive = resolveBlockedReceive;
      resolveBlockedReceive = null;
      receive({ kind: 'text', text: JSON.stringify(frame) });
    },
    send: sent,
    receive: vi.fn(async () => {
      if (helloPending) {
        helloPending = false;
        return { kind: 'text' as const, text: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) };
      }
      if (readyPending) {
        readyPending = false;
        return { kind: 'text' as const, text: JSON.stringify({ op: 0, s: 1, t: 'READY',
          d: { session_id: readySessionId, resume_gateway_url: 'wss://gateway.discord.gg' } }) };
      }
      return await new Promise<Awaited<ReturnType<PluginWebSocketConnection['receive']>>>((resolve) => {
        resolveBlockedReceive = resolve;
      });
    }),
    close,
    dispose: vi.fn(async () => undefined),
  };
}

describe('Discord Gateway supervisor', () => {
  it.each([CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList, CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead])(
    'settles a Collection update refusal from %s for this generation', async refusedAction => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const supervisor = createDiscordGatewaySupervisor();
      const execute = vi.fn(async (action: Readonly<{ localId: string }>) => {
        if (action.localId === refusedAction) throw new PluginError({ code: 'collection_update_required', retryable: false });
        return { 'connection-1': snapshot() };
      });
      const context = backgroundContext({ actions: { execute }, connectedAccounts: {
        watch: () => ({ dispose() {} }),
      }, http: {} }, controller.signal);
      const running = supervisor.run(context);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const initialReads = execute.mock.calls.length;
        for (let pass = 0; pass < 100; pass += 1) {
          supervisor.invalidateConnections();
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(execute).toHaveBeenCalledTimes(initialReads);
        expect(context.services.logger.warn).toHaveBeenCalledExactlyOnceWith(
          '[Channels] Account Collection requires an update',
          { code: 'collection_update_required', retryable: false, recovery: 'updateHappierOnThisMachine' },
        );
      } finally { controller.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
    },
  );

  it.each([
    ['missing caller', undefined],
    ['different plugin', {
      kind: 'plugin' as const,
      pluginId: 'acme.unrelated',
      contribution: {
        id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
        qualifiedId: `acme.unrelated/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}`,
      },
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'acme.unrelated',
      },
      originSurface: 'background' as const,
    }],
    ['different background service', {
      kind: 'plugin' as const,
      pluginId: 'happier.channel.discord',
      contribution: {
        id: 'another-runner',
        qualifiedId: 'happier.channel.discord/backgroundServices/another-runner',
      },
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'happier.channel.discord',
      },
      originSurface: 'background' as const,
    }],
    ['mismatched qualified contribution', {
      kind: 'plugin' as const,
      pluginId: 'happier.channel.discord',
      contribution: {
        id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
        qualifiedId: `happier.channel.discord/backgroundServices/another-runner`,
      },
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'happier.channel.discord',
      },
      originSurface: 'background' as const,
    }],
    ['non-background origin', {
      kind: 'plugin' as const,
      pluginId: 'happier.channel.discord',
      contribution: {
        id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
        qualifiedId: `happier.channel.discord/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}`,
      },
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'happier.channel.discord',
      },
      originSurface: 'plugin' as const,
    }],
  ])('rejects a worker attempt from %s before provider work', async (_label, caller) => {
    const supervisor = createDiscordGatewaySupervisor();
    const context = {
      ...channelsCoreContext(),
      caller,
    } as PluginInvocationContext;

    await expect(supervisor.runWorkerAttempt(snapshot(), context))
      .rejects.toThrow('Discord Gateway worker attempts may only be started by the Gateway supervisor.');

    await supervisor.dispose();
  });

  it('consumes the strict core-derived Message Content demand without reading bindings or defaulting it', () => {
    expect(requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
      snapshot({ requiresFullSharedMessageContent: true }),
    )).toEqual({ requiresFullSharedMessageContent: true });
    expect(requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
      snapshot({ requiresFullSharedMessageContent: false }),
    )).toEqual({ requiresFullSharedMessageContent: false });
  });

  it('parks a configured connection census and wakes on Channels invalidation without losing an in-read change', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const supervisor = createDiscordGatewaySupervisor();
    const invalidate = () => supervisor.invalidateConnections();
    let current = snapshot({ enabled: false });
    const listedEpochs: number[] = [];
    const actions = {
      execute: vi.fn(async (action: Readonly<{ localId: string }>) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
          listedEpochs.push(current.authorityEpoch);
          if (listedEpochs.length === 2) {
            current = snapshot({ enabled: false, authorityEpoch: 9 });
            invalidate?.();
          }
        }
        return { [current.connectionId]: current };
      }),
    };
    const disposeWatch = vi.fn();
    const background = backgroundContext({
      actions,
      connectedAccounts: { watch: () => ({ dispose: disposeWatch }) },
      http: {},
    }, generation.signal);
    expect(invalidate).not.toThrow();
    const running = supervisor.run(background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(listedEpochs).toEqual([7]);
      expect(vi.mocked(background.services.logger.info).mock.calls).toContainEqual([
        expect.any(String), expect.objectContaining({ phase: 'reconciliation', connectionCount: 1 }),
      ]);
      await vi.advanceTimersByTimeAsync(90_000);
      console.info('FIX-WAKE Discord measurement', {
        startupLists: 1,
        listsPerMinute: (listedEpochs.length - 1) / 1.5,
      });
      expect(listedEpochs).toEqual([7]);
      current = snapshot({ enabled: false, authorityEpoch: 8 });
      invalidate?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(listedEpochs).toEqual([7, 8, 9]);
    } finally {
      generation.abort();
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
    expect(disposeWatch).toHaveBeenCalledOnce();
    expect(invalidate).not.toThrow();
  });

  it('re-reads each listed connection before starting its worker, so stale list evidence cannot select a Gateway generation', async () => {
    const listed = snapshot({ authorityEpoch: 7, requiresFullSharedMessageContent: false });
    const reread = snapshot({ authorityEpoch: 8, requiresFullSharedMessageContent: true });
    let resolveWorker!: (result: Readonly<{ kind: 'stopped' }>) => void;
    const workerFactory = vi.fn(() => ({
      result: new Promise<Readonly<{ kind: 'stopped' }>>((resolve) => { resolveWorker = resolve; }),
      stop: vi.fn(() => resolveWorker({ kind: 'stopped' })),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = vi.fn(async (
      action: Readonly<{ localId: string }>,
      actionInput: unknown,
    ) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [listed.connectionId]: listed };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    });
    const { actions, background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore,
      readConnection: async (connectionId) => {
        expect(connectionId).toBe(listed.connectionId);
        return reread;
      },
    });

    await supervisor.reconcile(background);

    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    expect(workerFactory).toHaveBeenLastCalledWith(expect.objectContaining({
      connection: expect.objectContaining({
        authorityEpoch: 8,
        runtime: { requiresFullSharedMessageContent: true },
      }),
    }));
    expect(actions.execute).toHaveBeenCalledWith(
      {
        pluginId: 'happier.channels',
        localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
      },
      { connectionId: listed.connectionId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await supervisor.dispose();
  });

  it('keeps a retired background runner unsettled through its committed Identify window before the replacement generation starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const retiredGeneration = new AbortController();
    const replacementGeneration = new AbortController();
    try {
      let markRetiredIdentify!: () => void;
      const retiredIdentify = new Promise<void>((resolve) => { markRetiredIdentify = resolve; });
      let markReplacementIdentify!: () => void;
      const replacementIdentify = new Promise<void>((resolve) => { markReplacementIdentify = resolve; });
      const retiredSocket = gatewaySocketUntilStopped(markRetiredIdentify);
      const replacementSocket = gatewaySocketUntilStopped(markReplacementIdentify);
      const executeCore = async (action: Readonly<{ localId: string }>) => {
          if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { 'connection-1': snapshot() };
          }
          throw new Error(`Unexpected core Action ${action.localId}`);
      };
      const connectedAccounts = {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      };
      const contextFor = (
        supervisor: DiscordGatewaySupervisor,
        socket: PluginWebSocketConnection,
        signal: AbortSignal,
      ) => supervisorBackgroundHarness({
        supervisor,
        connectedAccounts,
        signal,
        executeCore,
        http: {
          request: vi.fn(async (request: Readonly<{ url: string }>) => {
            if (request.url.endsWith('/oauth2/applications/@me')) {
              return response({ id: 'application-1', flags: 0, flags_new: '0' });
            }
            if (request.url.endsWith('/users/@me')) {
              return response({ id: 'bot-1', username: 'Happier Bot', bot: true });
            }
            if (request.url.endsWith('/gateway/bot')) {
              return response({
                url: 'wss://gateway.discord.gg/',
                shards: 1,
                session_start_limit: {
                  total: 1_000,
                  remaining: 1_000,
                  reset_after: 0,
                  max_concurrency: 16,
                },
              });
            }
            throw new Error(`Unexpected Discord request ${request.url}`);
          }),
          openWebSocket: vi.fn(async () => socket),
        },
      }).background;
      const retiredSupervisor = createDiscordGatewaySupervisor();
      let retiredRunSettled = false;
      const retiredRun = retiredSupervisor.run(
        contextFor(retiredSupervisor, retiredSocket, retiredGeneration.signal),
      ).then(() => { retiredRunSettled = true; });
      await retiredIdentify;

      const replacementSupervisor = createDiscordGatewaySupervisor();
      let replacementRunStarted = false;
      const replacementRun = (async () => {
        // The host replacement lifecycle starts a background service only after
        // its retired runner settles; exercise that real supervisor boundary.
        await retiredRun;
        replacementRunStarted = true;
        await replacementSupervisor.run(
          contextFor(replacementSupervisor, replacementSocket, replacementGeneration.signal),
        );
      })();

      retiredGeneration.abort(new Error('Discord plugin generation retired.'));
      await vi.advanceTimersByTimeAsync(0);
      expect(retiredRunSettled).toBe(false);
      expect(replacementRunStarted).toBe(false);
      expect(replacementSocket.sent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(retiredRunSettled).toBe(false);
      expect(replacementRunStarted).toBe(false);
      expect(replacementSocket.sent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await retiredRun;
      await replacementIdentify;
      expect(replacementRunStarted).toBe(true);
      expect(Date.now()).toBe(5_000);

      replacementGeneration.abort(new Error('Replacement test complete.'));
      await vi.advanceTimersByTimeAsync(5_000);
      await replacementRun;
    } finally {
      retiredGeneration.abort();
      replacementGeneration.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
    }
  });

  it('stops the local worker naturally when the current connection is disabled', async () => {
    let current = snapshot({ requiresFullSharedMessageContent: true });
    const executeCore = async (action: Readonly<{ localId: string }>) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
          return { [current.connectionId]: current };
        }
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
          return { kind: 'recorded' };
        }
        throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    let resolveWorker!: (result: Readonly<{ kind: 'stopped' }>) => void;
    const worker = {
      result: new Promise<Readonly<{ kind: 'stopped' }>>((resolve) => { resolveWorker = resolve; }),
      stop: vi.fn(() => resolveWorker({ kind: 'stopped' })),
    };
    const workerFactory = vi.fn(() => worker);
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const { actions, background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    const reconciliation = { [current.connectionId]: current };
    expect(ConversationProviderConnectionsSnapshotV1Schema.parse(reconciliation))
      .toEqual(reconciliation);
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    expect(actions.execute).toHaveBeenCalledWith(
      {
        pluginId: 'happier.channels',
        localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
      },
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(workerFactory).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({
        runtime: { requiresFullSharedMessageContent: true },
        applicationMessageContentIntentPermission: { kind: 'enabled', source: 'flagsAndFlagsNew' },
      }),
    }));

    current = snapshot({ authorityEpoch: 8, enabled: false });
    await supervisor.reconcile(background);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    await supervisor.reconcile(background);
    expect(actions.execute.mock.calls.filter(([action]) => typeof action !== 'string'
      && action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport)).toEqual([]);
    await supervisor.dispose();
  });

  it('waits for actual Gateway teardown when the supervisor is disposed', async () => {
    vi.useFakeTimers();
    const supervisor = createDiscordGatewaySupervisor();
    let releaseDispose!: () => void;
    const disposed = new Promise<void>(resolve => { releaseDispose = resolve; });
    let identified = false;
    const socket = {
      ...gatewaySocketUntilStopped(() => { identified = true; }),
      dispose: vi.fn(() => disposed),
    };
    const current = snapshot();
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : request.url.endsWith('/gateway/bot')
            ? { url: 'wss://gateway.discord.gg/', shards: 1,
              session_start_limit: { total: 1_000, remaining: 1_000, reset_after: 0, max_concurrency: 16 } }
            : { id: 'bot-1', username: 'Happier Bot', bot: true })),
        openWebSocket: vi.fn(async () => socket),
      },
      executeCore: async action => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) return { [current.connectionId]: current };
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) return { kind: 'recorded' };
        throw new Error(`Unexpected core Action ${action.localId}`);
      },
    });
    try {
      await supervisor.reconcile(background);
      await vi.advanceTimersByTimeAsync(0);
      expect(identified).toBe(true);
      let settled = false;
      const stopping = supervisor.dispose().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.dispose).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      releaseDispose();
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      expect(settled).toBe(true);
    } finally {
      releaseDispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it('re-identifies a READY Gateway when shared content demand changes without restarting unchanged demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const supervisor = createDiscordGatewaySupervisor();
    let current = snapshot();
    const sockets = [false, true, false].map((_, index) => gatewaySocketUntilStopped(vi.fn(), `session-${index}`));
    let openedSockets = 0;
    const openWebSocket = vi.fn(async () => {
      const socket = sockets[openedSockets++];
      if (!socket) throw new Error('Unexpected extra Gateway session.');
      return socket;
    });
    const reportedFacts: unknown[] = [];
    const admissions: unknown[] = [];
    const { background } = supervisorBackgroundHarness({
      supervisor, signal: controller.signal,
      connectedAccounts: {
        materialize: async () => ({ kind: 'environment', env: { DISCORD_BOT_TOKEN: 'bot-token' } }),
        watch: () => ({ dispose() {} }),
      },
      http: {
        request: async ({ url }) => response(url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
          : url.endsWith('/users/@me') ? { id: 'bot-1', username: 'Happier Bot', bot: true }
          : url.endsWith('/channels/channel-1') ? { id: 'channel-1', type: 1 }
          : { url: 'wss://gateway.discord.gg/', shards: 1,
            session_start_limit: { total: 1_000, remaining: 1_000, reset_after: 86_400_000, max_concurrency: 1 } }),
        openWebSocket,
      },
      executeCore: async (action, input) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) return { [current.connectionId]: current };
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
          reportedFacts.push(input);
          return { kind: 'recorded' };
        }
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) { admissions.push(input); return; }
        throw new Error(`Unexpected core Action ${action.localId}`);
      },
      executeAutomation: async (action) => {
        if (action === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: [], nextCursor: null };
        if (action === 'automation.event.source.status.report') return {};
        throw new Error(`Unexpected Automation Action ${action}`);
      },
    });
    const running = supervisor.run(background);
    const identifiedIntents = (index: number): number => {
      for (const [message] of sockets[index]!.sent.mock.calls) {
        if (typeof message !== 'object' || message === null || !('text' in message) || typeof message.text !== 'string') continue;
        const frame = JSON.parse(message.text);
        if (frame.op === 2 && typeof frame.d?.intents === 'number') return frame.d.intents;
      }
      throw new Error('Expected a Gateway IDENTIFY frame.');
    };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(openWebSocket).toHaveBeenCalledTimes(1);
      expect(vi.mocked(background.services.logger.info).mock.calls).toContainEqual([
        '[Discord Gateway] Session ready', expect.objectContaining({ messageContentIntentActive: false }),
      ]);
      expect(identifiedIntents(0) & DISCORD_MESSAGE_CONTENT_INTENT).toBe(0);

      current = snapshot({ authorityEpoch: 8, providerConfig: { applicationId: 'application-1', botUserId: 'bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot' } });
      supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openWebSocket).toHaveBeenCalledTimes(1);
      sockets[0]!.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'after-generation-change', channel_id: 'channel-1',
        timestamp: '2024-01-01T00:01:00.000Z', type: 0, content: 'hello', author: { id: 'human-1', bot: false }, attachments: [], embeds: [] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(admissions).toEqual([expect.objectContaining({ connectionId: 'connection-1', authorityEpoch: 8 })]);

      current = snapshot({ authorityEpoch: 8, requiresFullSharedMessageContent: true });
      supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openWebSocket).toHaveBeenCalledTimes(2);
      expect(identifiedIntents(1) & DISCORD_MESSAGE_CONTENT_INTENT).toBe(DISCORD_MESSAGE_CONTENT_INTENT);
      expect(vi.mocked(background.services.logger.info).mock.calls).toContainEqual([
        '[Discord Gateway] Session ready', expect.objectContaining({ messageContentIntentActive: true }),
      ]);
      // Diagnostic coverage, not evidence of a product-behavior RED: this
      // demand transition already succeeds before the diagnostic change.
      const records = vi.mocked(background.services.logger.info).mock.calls.map(([, fields]) => fields);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'workerComparison', fingerprintMatches: false,
          oldRequiresFullSharedMessageContent: false, requiresFullSharedMessageContent: true }),
        expect.objectContaining({ phase: 'workerDecision', decision: 'stop-and-replace',
          oldRequiresFullSharedMessageContent: false, requiresFullSharedMessageContent: true }),
        expect.objectContaining({ phase: 'workerStopRequested', intent: 'reconcile', settleOutcome: 'stillPending' }),
        expect.objectContaining({ phase: 'workerSettled', resultKind: 'stopped', settleOutcome: 'settled' }),
        expect.objectContaining({ phase: 'workerAttemptSettled', settleOutcome: 'settled', intent: 'reconcile' }),
        expect.objectContaining({ phase: 'workerDecision', decision: 'start', requiresFullSharedMessageContent: true }),
        expect.objectContaining({ phase: 'workerStart', requiresFullSharedMessageContent: true }),
      ]));
      const replacementDecision = records.findIndex(record => record?.phase === 'workerDecision' && record.decision === 'stop-and-replace');
      const replacementStart = records.findIndex(record => record?.phase === 'workerStart' && record.requiresFullSharedMessageContent === true);
      expect(replacementDecision).toBeLessThan(replacementStart);
      for (let index = 0; index < 3; index += 1) {
        supervisor.invalidateConnections();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(openWebSocket).toHaveBeenCalledTimes(2);
      expect(vi.mocked(background.services.logger.info).mock.calls).toContainEqual([
        expect.any(String), expect.objectContaining({ phase: 'workerDecision', decision: 'keep', fingerprintMatches: true,
          oldRequiresFullSharedMessageContent: true, requiresFullSharedMessageContent: true }),
      ]);

      current = snapshot({ authorityEpoch: 8 });
      supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openWebSocket).toHaveBeenCalledTimes(3);
      expect(identifiedIntents(2) & DISCORD_MESSAGE_CONTENT_INTENT).toBe(0);
      expect(reportedFacts).toContainEqual(expect.objectContaining({ fact: { kind: 'providerReadiness', status: 'ready' } }));
    } finally {
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['list', 'read', 'fact'] as const)('keeps the real Gateway socket alive across a transient authority %s failure', async failure => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const supervisor = createDiscordGatewaySupervisor();
    const current = snapshot();
    let failRead = failure === 'fact';
    const sockets = [gatewaySocketUntilStopped(vi.fn(), 'before-loss'), gatewaySocketUntilStopped(vi.fn(), 'after-repair')];
    const openWebSocket = vi.fn(async () => sockets[openWebSocket.mock.calls.length - 1]!);
    const reportedFacts: unknown[] = [];
    let failedFactReports = 0;
    let acceptedFactReports = 0;
    const { background } = supervisorBackgroundHarness({
      supervisor, signal: controller.signal,
      connectedAccounts: {
        materialize: async () => ({ kind: 'environment', env: { DISCORD_BOT_TOKEN: 'bot-token' } }),
        watch: () => ({ dispose() {} }),
      },
      http: {
        request: async ({ url }) => response(url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
          : url.endsWith('/users/@me') ? { id: 'bot-1', username: 'Happier Bot', bot: true }
          : { url: 'wss://gateway.discord.gg/', shards: 1,
            session_start_limit: { total: 1_000, remaining: 1_000, reset_after: 86_400_000, max_concurrency: 1 } }),
        openWebSocket,
      },
      readConnection: async () => {
        if (failRead && failure === 'read') throw new PluginError({ code: 'channels_reconciliation_snapshot_changed', message: 'Account cursor moved.', retryable: true });
        return current;
      },
      executeCore: async (action, input) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
          if (failRead && failure === 'list') throw new PluginError({ code: 'channels_reconciliation_snapshot_changed', message: 'Account cursor moved.', retryable: true });
          return { [current.connectionId]: current };
        }
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
          if (failure === 'fact' && failRead) {
            failedFactReports += 1;
            throw new PluginError({ code: 'network_error', message: 'Account transport unavailable.', retryable: true });
          }
          acceptedFactReports += 1;
          if (typeof input === 'object' && input !== null && 'fact' in input
            && typeof input.fact === 'object' && input.fact !== null && 'kind' in input.fact && input.fact.kind === 'historyGap') {
            reportedFacts.push(input);
            throw new PluginError({ code: 'plugin_collection_value_invalid', message: 'Closed Collection schema rejected the write.' });
          }
          return { kind: 'recorded' };
        }
        throw new Error(`Unexpected core Action ${action.localId}`);
      },
      executeAutomation: async action => {
        if (action === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: [], nextCursor: null };
        if (action === 'automation.event.source.status.report') return {};
        throw new Error(`Unexpected Automation Action ${action}`);
      },
    });
    const running = supervisor.run(background);
    const records = () => vi.mocked(background.services.logger.info).mock.calls.map(([, fields]) => fields);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(openWebSocket).toHaveBeenCalledTimes(1);
      expect(records()).toContainEqual(expect.objectContaining({ phase: 'gatewayReady', messageContentIntentActive: false }));
      failRead = true;
      supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(records()).not.toContainEqual(expect.objectContaining({ phase: 'workerStopRequested' }));
      failRead = false;
      supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(reportedFacts).toHaveLength(0);
      expect(openWebSocket).toHaveBeenCalledTimes(1);
      expect(records().filter(record => record?.phase === 'workerStart')).toHaveLength(1);
      expect(records()).toContainEqual(expect.objectContaining(failure === 'read'
        ? { phase: 'workerDecision', decision: 'skip', reason: 'authorityReadFailed', errorCode: 'channels_reconciliation_snapshot_changed' }
        : failure === 'fact'
          ? { phase: 'workerDecision', decision: 'skip', reason: 'transportFactReportFailed', errorCode: 'network_error' }
          : { phase: 'reconciliationFailed', errorCode: 'channels_reconciliation_snapshot_changed' }));
      if (failure === 'fact') {
        expect(failedFactReports).toBeGreaterThan(0);
        expect(acceptedFactReports).toBeGreaterThan(0);
      }
    } finally {
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it('projects a role-proof admission loss before a changed strict demand can create a fresh Identify worker', async () => {
    let current = snapshot({ requiresFullSharedMessageContent: false });
    const lifecycle: string[] = [];
    const executeCore = async (action: Readonly<{ localId: string }>) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
          return { [current.connectionId]: current };
        }
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
          lifecycle.push('applicationAdmissionLost reported');
          return { kind: 'recorded' };
        }
        throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const makeWorker = <Result extends DiscordGatewayWorkerResult>(result: Result) => {
      let resolve!: (value: Result) => void;
      return {
        worker: {
          result: new Promise<Result>((complete) => { resolve = complete; }),
          stop: vi.fn(() => resolve(result)),
        },
      };
    };
    const first = makeWorker({
      kind: 'notReady' as const,
      failure: { kind: 'notReady' as const, reason: 'network' as const },
      transportFact: { kind: 'historyGap' as const, reason: 'applicationAdmissionLost' as const },
    });
    const second = makeWorker({ kind: 'stopped' });
    const workerFactory = vi.fn((input: Readonly<{
      connection: Readonly<{ runtime: Readonly<{ requiresFullSharedMessageContent: boolean }> }>;
    }>) => {
      lifecycle.push(`worker:${input.connection.runtime.requiresFullSharedMessageContent}`);
      return workerFactory.mock.calls.length === 1 ? first.worker : second.worker;
    });
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const { actions, background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    expect(workerFactory).toHaveBeenLastCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ runtime: { requiresFullSharedMessageContent: false } }),
    }));

    current = snapshot({ requiresFullSharedMessageContent: true });
    await supervisor.reconcile(background);
    expect(first.worker.stop).toHaveBeenCalledTimes(1);
    expect(workerFactory).toHaveBeenCalledTimes(1);

    await vi.waitFor(async () => {
      await supervisor.reconcile(background);
      expect(workerFactory).toHaveBeenCalledTimes(2);
    });
    expect(workerFactory).toHaveBeenLastCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ runtime: { requiresFullSharedMessageContent: true } }),
    }));
    expect(lifecycle).toEqual([
      'worker:false',
      'applicationAdmissionLost reported',
      'worker:true',
    ]);
    const transportFactCall = actions.execute.mock.calls.find(
      ([action]) => typeof action !== 'string'
        && action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
    );
    expect(transportFactCall?.[1]).toEqual({
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
    });
    await supervisor.dispose();
    expect(second.worker.stop).toHaveBeenCalledTimes(1);
  });


  it('projects Gateway backoff and recovery through exact current socket sources', async () => {
    const current = snapshot();
    const reports: unknown[] = [];
    const workerFactory = vi.fn((input: Readonly<{
      reportConnectionStatus?: (status: 'ready' | 'reconnecting') => void | Promise<void>;
    }>) => ({
      result: (async () => {
        await input.reportConnectionStatus?.('ready');
        await input.reportConnectionStatus?.('reconnecting');
        await input.reportConnectionStatus?.('ready');
        return { kind: 'stopped' as const };
      })(),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 0, flags_new: '0' }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore: async (action) => {
        if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
          return { [current.connectionId]: current };
        }
        throw new Error(`Unexpected core Action ${action.localId}`);
      },
      executeAutomation: async (action, input) => {
        if (action === 'automation.event.sources.list') {
          return {
            kind: 'page',
            revision: '23',
            definitions: [
              {
                automationId: '11111111-1111-4111-8111-111111111111',
                triggerId: 'discord-current',
                triggerRevision: 4,
                eventRef: { pluginId: 'happier.channel.discord', localId: 'automation/channel-message-observed-v1' },
                sourceInstanceId: 'discord:application:application-1:channel:123',
                sourceSelectorId: '22222222-2222-4222-8222-222222222222',
                sourceContractVersion: 1,
                sourceConfig: { v: 1 },
                observationTransport: {
                  kind: 'socket',
                  watcherMaterializationRef: {
                    pluginId: 'happier.channel.discord',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                  },
                },
                filter: null,
                maximumObservationAgeMs: null,
              },
              {
                automationId: '33333333-3333-4333-8333-333333333333',
                triggerId: 'discord-other-application',
                triggerRevision: 4,
                eventRef: { pluginId: 'happier.channel.discord', localId: 'automation/channel-message-observed-v1' },
                sourceInstanceId: 'discord:application:application-2:channel:123',
                sourceSelectorId: '44444444-4444-4444-8444-444444444444',
                sourceContractVersion: 1,
                sourceConfig: { v: 1 },
                observationTransport: {
                  kind: 'socket',
                  watcherMaterializationRef: {
                    pluginId: 'happier.channel.discord',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                  },
                },
                filter: null,
                maximumObservationAgeMs: null,
              },
            ],
            nextCursor: null,
          };
        }
        if (action === 'automation.event.source.status.report') {
          reports.push(input);
          return {};
        }
        throw new Error(`Unexpected Automation Action ${action}`);
      },
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(reports).toHaveLength(6));
    expect(reports).toEqual([
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'socket' }, observedRevision: '23' }),
      expect.objectContaining({ kind: 'source', triggerId: 'discord-current', state: 'observing', code: 'none' }),
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'socket' }, observedRevision: '23' }),
      expect.objectContaining({ kind: 'source', triggerId: 'discord-current', state: 'backingOff', code: 'admissionUnavailable' }),
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'socket' }, observedRevision: '23' }),
      expect.objectContaining({ kind: 'source', triggerId: 'discord-current', state: 'observing', code: 'none' }),
    ]);
    await supervisor.dispose();
  });

  it('reports a Developer Portal permission absence through the provider-neutral connection readiness owner', async () => {
    const current = snapshot({ requiresFullSharedMessageContent: true });
    const reportedFacts: unknown[] = [];
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const workerFactory = vi.fn(() => ({
      result: Promise.resolve({
        kind: 'messageContentIntentRecoveryRequired' as const,
        source: 'applicationFlags' as const,
        coreDemand: true,
        applicationPermission: 'disabled' as const,
        gatewayIntentRequested: false,
        gatewayIntentActive: false,
        failure: {
          kind: 'notReady' as const,
          reason: 'permissionMissing' as const,
          diagnostic: 'Discord Message Content must be enabled for this application in the Developer Portal.',
        },
      }),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    await supervisor.reconcile(background);

    expect(reportedFacts).toEqual([{
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerPermissionMissing',
        diagnostic: 'Discord Message Content must be enabled for this application in the Developer Portal.',
      },
    }]);
    await supervisor.dispose();
  });

  it('reports Gateway 4014, then rechecks remote repair without a local connection mutation', async () => {
    const messageContentRecheckDelayMs = 300_000;
    let now = 1_000;
    const current = snapshot({ requiresFullSharedMessageContent: true });
    let portalRepairCompleted = false;
    const reportedFacts: unknown[] = [];
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const gateway4014 = {
      kind: 'messageContentIntentRecoveryRequired' as const,
      source: 'gateway4014' as const,
      coreDemand: true,
      applicationPermission: 'enabled' as const,
      gatewayIntentRequested: true,
      gatewayIntentActive: false,
      failure: {
        kind: 'notReady' as const,
        reason: 'permissionMissing' as const,
        diagnostic: 'Discord refused the requested Message Content intent (Gateway close 4014).',
      },
    };
    let stopRepairedWorker!: () => void;
    const repairedWorker = {
      result: new Promise<DiscordGatewayWorkerResult>((resolve) => {
        stopRepairedWorker = () => resolve({ kind: 'stopped' });
      }),
      stop: vi.fn(() => stopRepairedWorker()),
    };
    const workerFactory = vi.fn((input: unknown) => {
      if (workerFactory.mock.calls.length === 1) {
        return { result: Promise.resolve(gateway4014), stop: vi.fn() };
      }
      if (!portalRepairCompleted) throw new Error('The retry must follow the simulated remote Portal repair.');
      (input as Readonly<{
        reportConnectionStatus?: (status: 'ready' | 'reconnecting') => void;
      }>).reportConnectionStatus?.('ready');
      return repairedWorker;
    });
    const supervisor = createDiscordGatewaySupervisor({
      workerFactory,
      reconciliationIntervalMs: 30_000,
      clock: {
        now: () => now,
        sleep: async () => undefined,
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      },
    });
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    await supervisor.reconcile(background);
    expect(reportedFacts).toEqual([{
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerPermissionMissing',
        diagnostic: 'Discord refused the requested Message Content intent (Gateway close 4014).',
      },
    }]);

    now += messageContentRecheckDelayMs - 1;
    await supervisor.reconcile(background);
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledTimes(2);

    // A Developer Portal repair is remote state, so it must not require a
    // connection edit, a changed authority epoch, or a synthetic local retry.
    portalRepairCompleted = true;
    now += 1;
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(2));
    expect(http.request).toHaveBeenCalledTimes(4);

    await supervisor.reconcile(background);
    expect(reportedFacts).toEqual([
      {
        connectionId: current.connectionId,
        authorityEpoch: current.authorityEpoch,
        fact: {
          kind: 'providerReadiness',
          status: 'attention',
          code: 'providerPermissionMissing',
          diagnostic: 'Discord refused the requested Message Content intent (Gateway close 4014).',
        },
      },
      {
        connectionId: current.connectionId,
        authorityEpoch: current.authorityEpoch,
        fact: { kind: 'providerReadiness', status: 'ready' },
      },
    ]);
    expect(current.authorityEpoch).toBe(7);
    await supervisor.dispose();
  });

  it('reaches only Channels reconciliation authority and never admits Automation sources directly', async () => {
    // Event candidates flow through the Channels observation-ingress owner.
    // Gateway reconciliation must not create a competing direct Automation
    // list/admit loop on every Machine.
    const supervisor = createDiscordGatewaySupervisor({
      workerFactory: vi.fn(() => ({
        result: Promise.resolve({ kind: 'stopped' } as const),
        stop: vi.fn(),
      })),
      reconciliationIntervalMs: 5,
    });
    const executeCore = async (action: Readonly<{ localId: string }>) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { 'connection-1': snapshot() };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const generation = new AbortController();
    const { actions, background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      } as unknown as PluginInvocationContext['services']['connectedAccounts'],
      http: {
        request: vi.fn(async () => { throw new Error('Unexpected Discord request'); }),
        openWebSocket: vi.fn(),
      } as unknown as PluginInvocationContext['services']['http'],
      executeCore,
      signal: generation.signal,
    });

    const running = supervisor.run(background);
    // The supervisor may read the catalog to project its connection health,
    // but it must never create an Automation admission directly.
    await vi.waitFor(() => expect(actions.execute.mock.calls.filter(
      ([action]) => (action as { localId?: string } | string as { localId?: string })?.localId
        === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
    ).length).toBeGreaterThan(1));
    generation.abort(new Error('Discord plugin generation retired.'));
    await running;

    expect(actions.execute.mock.calls
      .filter(([action]) => typeof action === 'string')
      .map(([action]) => action))
      .not.toContain('automation.event.admit');
    await supervisor.dispose();
  });

  it.each([
    ['invalidApiVersion', 'providerConfigurationInvalid'],
    ['disallowedIntents', 'providerPermissionMissing'],
    // Close 4004 rejects the selected bot token. Only repairing or resyncing
    // the Connected Account credential can retire that terminal memo, so
    // naming it a configuration problem sends the user somewhere that cannot
    // fix it.
    ['authenticationFailed', 'providerCredentialInvalid'],
  ] as const)('reports terminal Gateway %s attention without retrying', async (reason, code) => {
    const current = snapshot();
    const reportedFacts: unknown[] = [];
    const workerFactory = vi.fn(() => ({
      result: Promise.resolve({ kind: 'terminal', reason } as const),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));
    await supervisor.reconcile(background);

    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(reportedFacts).toEqual([{
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: expect.objectContaining({
        kind: 'providerReadiness',
        status: 'attention',
        code,
      }),
    }]);
    await supervisor.dispose();
  });

  it('reports a rejected Connected Account credential as credential attention rather than silence', async () => {
    // The worker cannot even attempt a Gateway session without the selected
    // credential. Publishing nothing left the connection stopped with no
    // reason the user could act on.
    const current = snapshot({ credentialRef: null });
    const reportedFacts: unknown[] = [];
    const supervisor = createDiscordGatewaySupervisor({
      workerFactory: vi.fn(() => ({
        result: Promise.resolve({ kind: 'stopped' } as const),
        stop: vi.fn(),
      })),
    });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http: { request: vi.fn(), openWebSocket: vi.fn() },
      executeCore,
    });

    await supervisor.reconcile(background);
    await supervisor.reconcile(background);

    expect(reportedFacts).toEqual([expect.objectContaining({
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: expect.objectContaining({
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerCredentialInvalid',
      }),
    })]);
    await supervisor.dispose();
  });

  it('discards a queued transport fact whose connection left reconciliation before it was reported', async () => {
    const current = snapshot();
    const reportedFacts: unknown[] = [];
    let listedConnections: Record<string, unknown> = { [current.connectionId]: current };
    const workerFactory = vi.fn(() => ({
      result: Promise.resolve({ kind: 'terminal', reason: 'invalidApiVersion' } as const),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return listedConnections;
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    // The connection leaves reconciliation before its queued readiness fact can
    // be published, so nothing can ever select that connection/epoch pair again.
    listedConnections = {};
    await supervisor.reconcile(background);
    await supervisor.reconcile(background);
    expect(reportedFacts).toEqual([]);

    // Re-listing the same connection and authority epoch must not resurrect the
    // evidence the supervisor already had no addressee for.
    listedConnections = { [current.connectionId]: current };
    await supervisor.reconcile(background);

    expect(reportedFacts).toEqual([]);
    await supervisor.dispose();
  });

  it('keeps a healthy Gateway worker across an unavailable reconciliation list and recovery', async () => {
    const current = snapshot();
    let listAvailable = true;
    const reportedFacts: unknown[] = [];
    const events: string[] = [];
    const workerResults: DiscordGatewayWorkerResult[] = [];
    const workerStops: Array<() => void> = [];
    const workerFactory = vi.fn(() => {
      events.push('worker');
      return {
        result: new Promise<DiscordGatewayWorkerResult>((resolve) => {
          workerStops.push(() => resolve(workerResults.shift() ?? { kind: 'stopped' }));
        }),
        stop: vi.fn(() => workerStops.at(-1)?.()),
      };
    });
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        if (!listAvailable) throw new Error('Channels connections list is unavailable.');
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        events.push('fact');
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 0, flags_new: '0' }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    // A read outage is not evidence that the retained authority was revoked.
    listAvailable = false;
    await supervisor.reconcile(background);
    await supervisor.reconcile(background);

    listAvailable = true;
    await supervisor.reconcile(background);
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(reportedFacts).toEqual([]);
    expect(events).toEqual(['worker']);
    await supervisor.dispose();
  });

  it('keeps a healthy Gateway worker across an unavailable authoritative connection read and recovery', async () => {
    const current = snapshot();
    let readAvailable = true;
    const reportedFacts: unknown[] = [];
    const workerResults: DiscordGatewayWorkerResult[] = [];
    const workerStops: Array<() => void> = [];
    const workerFactory = vi.fn(() => ({
      result: new Promise<DiscordGatewayWorkerResult>((resolve) => {
        workerStops.push(() => resolve(workerResults.shift() ?? { kind: 'stopped' }));
      }),
      stop: vi.fn(() => workerStops.at(-1)?.()),
    }));
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 0, flags_new: '0' }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore,
      readConnection: async () => {
        if (!readAvailable) return null;
        return current;
      },
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    readAvailable = false;
    await supervisor.reconcile(background);

    readAvailable = true;
    await supervisor.reconcile(background);
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(reportedFacts).toEqual([]);
    await supervisor.dispose();
  });

  it('does not publish retired stop proofs when a disabled resumable worker settles', async () => {
    let current = snapshot({ requiresFullSharedMessageContent: true });
    const reportedFacts: unknown[] = [];
    let resolveWorker!: (result: DiscordGatewayWorkerResult) => void;
    const worker = {
      result: new Promise<DiscordGatewayWorkerResult>((resolve) => { resolveWorker = resolve; }),
      stop: vi.fn(() => resolveWorker({ kind: 'stopped', unprovenContinuity: true })),
    };
    const workerFactory = vi.fn(() => worker);
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 1 << 18, flags_new: String(1 << 18) }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    current = snapshot({ authorityEpoch: 8, enabled: false });
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledOnce());
    await supervisor.reconcile(background);
    expect(reportedFacts).toEqual([]);
    await supervisor.dispose();
  });

it('reports the continuity gap of a resumable worker whose runner generation retired before the replacement runner admits', async () => {
    const current = snapshot();
    const reportedFacts: unknown[] = [];
    const events: string[] = [];
    const workerResults: DiscordGatewayWorkerResult[] = [];
    const workerStops: Array<() => void> = [];
    const workerFactory = vi.fn(() => {
      events.push('worker');
      return {
        result: new Promise<DiscordGatewayWorkerResult>((resolve) => {
          workerStops.push(() => resolve(workerResults.shift() ?? { kind: 'stopped' }));
        }),
        stop: vi.fn(() => workerStops.at(-1)?.()),
      };
    });
    const supervisor = createDiscordGatewaySupervisor({ workerFactory });
    const executeCore = async (action: Readonly<{ localId: string }>, actionInput: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        events.push('fact');
        reportedFacts.push(actionInput);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const harnessInput = {
      supervisor,
      connectedAccounts: {
        materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      },
      http: {
        request: vi.fn(async (request: Readonly<{ url: string }>) => response(
          request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 0, flags_new: '0' }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
        )),
        openWebSocket: vi.fn(),
      },
      executeCore,
    } as const;

    // One activation-local supervisor serves every background runner
    // generation, exactly like the plugin's activation bindings: the host can
    // retire a runner and start the next one against the same instance.
    const retiredSignal = new AbortController();
    const { background: retiredBackground } = supervisorBackgroundHarness({
      ...harnessInput,
      signal: retiredSignal.signal,
    });
    const retiredRun = supervisor.run(retiredBackground);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    // The runner retires while the worker still holds Discord resume
    // coordinates. Those coordinates are process-local and die with the
    // retired runner, so the replacement runner can only Identify fresh and
    // may miss everything dispatched in the interval: the existing
    // history-gap fact must be queued through the pending fact owner before
    // the replacement admits.
    workerResults.push({ kind: 'stopped', unprovenContinuity: true });
    retiredSignal.abort(new Error('Discord Gateway runner generation retired.'));
    await retiredRun;

    const replacementSignal = new AbortController();
    const { background: replacementBackground } = supervisorBackgroundHarness({
      ...harnessInput,
      signal: replacementSignal.signal,
    });
    const replacementRun = supervisor.run(replacementBackground);
    await vi.waitFor(() => expect(reportedFacts).toHaveLength(1));
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(2));

    expect(reportedFacts).toEqual([
      {
        connectionId: 'connection-1',
        authorityEpoch: 7,
        fact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
      },
    ]);
    expect(events).toEqual(['worker', 'fact', 'worker']);
    replacementSignal.abort(new Error('Replacement runner test complete.'));
    await replacementRun;
    await supervisor.dispose();
  });

  it('retries an authentication-failed connection after the host reports a Connected Account credential resync', async () => {
    const generation = new AbortController();
    // Gateway close 4004 means the selected bot token is wrong. Repairing it
    // inside the same Connected Account changes nothing the core reconciliation
    // snapshot carries, so the connection fingerprint is byte-identical and
    // only the host's credential resync can retire the terminal memo.
    const supervisor = createDiscordGatewaySupervisor();
    const reportedFacts: unknown[] = [];
    const executeCore = async (action: Readonly<{ localId: string }>, value: unknown) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { 'connection-1': snapshot() };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        reportedFacts.push(value);
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const credentialResyncListeners: Array<(event: ConnectedAccountBindingEvent) => void> = [];
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn((purpose: string, listener: (event: ConnectedAccountBindingEvent) => void) => {
        expect(purpose).toBe('discord-bot-credential');
        credentialResyncListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/gateway/bot')
          ? { url: 'wss://gateway.discord.gg/', shards: 1,
            session_start_limit: { total: 1_000, remaining: 1_000, reset_after: 0, max_concurrency: 16 } }
          : request.url.endsWith('/oauth2/applications/@me')
            ? { id: 'application-1', flags: 0, flags_new: '0' }
            : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      // Discord's HTTP/WebSocket boundary returns the real terminal close;
      // the Gateway worker and its failure classification stay real.
      openWebSocket: vi.fn(async (): Promise<PluginWebSocketConnection> => ({
        ...gatewaySocketUntilStopped(() => {}),
        async receive() { return { kind: 'closed', close: { kind: 'remote', code: 4004, wasClean: false } }; },
      })),
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
      signal: generation.signal,
    });

    const running = supervisor.run(background);
    try {
      await vi.waitFor(() => expect(reportedFacts).toContainEqual(expect.objectContaining({
        fact: expect.objectContaining({ code: 'providerCredentialInvalid' }),
      })));
      // The terminal memo holds through presentation-only resyncs.
      await supervisor.reconcile(background);
      expect(http.openWebSocket).toHaveBeenCalledTimes(1);
      const acquired = connectedAccounts.materialize.mock.calls.length;
      expect(credentialResyncListeners).toHaveLength(1);
      for (const listener of credentialResyncListeners) listener({ kind: 'resync', authorityChanged: false });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(http.openWebSocket).toHaveBeenCalledTimes(1);
      expect(connectedAccounts.materialize).toHaveBeenCalledTimes(acquired);

      for (const listener of credentialResyncListeners) listener({ kind: 'resync', authorityChanged: true });
      await vi.waitFor(() => expect(http.openWebSocket).toHaveBeenCalledTimes(2));
    } finally {
      generation.abort(new Error('Discord plugin generation retired.'));
      await running;
      await supervisor.dispose();
    }
  });

  it('forgets terminal fingerprints after their credential selection leaves reconciliation', async () => {
    let currentSnapshot = snapshot();
    const workerFactory = vi.fn(() => ({
      result: Promise.resolve({ kind: 'terminal', reason: 'invalidApiVersion' } as const),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({
      workerFactory,
      reconciliationIntervalMs: 3_600_000,
    });
    const executeCore = async (action: Readonly<{ localId: string }>) => {
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { 'connection-1': currentSnapshot };
      }
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        return { kind: 'recorded' };
      }
      throw new Error(`Unexpected core Action ${action.localId}`);
    };
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
    });

    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    currentSnapshot = snapshot({ authorityEpoch: 8, credentialRef: { ...credentialRef, accountId: 'bot:replacement' } });
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(2));

    currentSnapshot = snapshot({ authorityEpoch: 9 });
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(3));

    await supervisor.dispose();
  });
});
