import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
} from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  createDiscordGatewaySupervisor,
  requireDiscordGatewayRuntimeFactsFromCoreSnapshot,
  type DiscordGatewaySupervisor,
} from './discordGatewaySupervisor.js';
import type { DiscordGatewayWorkerResult } from './discordGatewayWorker.js';
import { DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID } from './discordPluginConstants.js';

const credentialRef = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.channel.discord', localId: 'discord-bot' }),
  accountId: 'bot:bot-1',
});

function snapshot(
  overrides: Partial<ConversationProviderConnectionReconciliationSnapshotV1> = {},
): ConversationProviderConnectionReconciliationSnapshotV1 {
  return {
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
  };
}

function backgroundContext(
  services: Pick<PluginInvocationContext['services'], 'actions' | 'connectedAccounts' | 'http'>,
  signal: AbortSignal = new AbortController().signal,
): BackgroundServiceContext {
  return {
    plugin: { id: 'happier.channel.discord', version: '0.0.0' },
    contribution: {
      id: 'gateway-supervisor',
      qualifiedId: 'happier.channel.discord/backgroundServices/gateway-supervisor',
    },
    surface: 'background',
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
  connectedAccounts: PluginInvocationContext['services']['connectedAccounts'];
  http: PluginInvocationContext['services']['http'];
  executeCore: (
    action: Readonly<{ pluginId: string; localId: string }>,
    actionInput: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  signal?: AbortSignal;
}>): Readonly<{
  actions: Readonly<{ execute: ReturnType<typeof vi.fn> }>;
  background: BackgroundServiceContext;
}> {
  let background!: BackgroundServiceContext;
  const actions = {
    execute: vi.fn(async (
      action: Readonly<{ pluginId: string; localId: string }>,
      actionInput: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
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
            caller: {
              kind: 'plugin',
              pluginId: background.plugin.id,
              contribution: background.contribution,
            },
            signal: options?.signal ?? background.signal,
            services: background.services,
          } as PluginInvocationContext,
        );
        return undefined;
      }
      return await input.executeCore(action, actionInput, options);
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
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'connection-delete-v1',
        qualifiedId: 'happier.channels/actions/connection-delete-v1',
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
): PluginWebSocketConnection & Readonly<{ sent: ReturnType<typeof vi.fn> }> {
  let helloPending = true;
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
    send: sent,
    receive: vi.fn(async () => {
      if (helloPending) {
        helloPending = false;
        return { kind: 'text' as const, text: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) };
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
  it('consumes the strict core-derived Message Content demand without reading bindings or defaulting it', () => {
    expect(requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
      snapshot({ requiresFullSharedMessageContent: true }),
    )).toEqual({ requiresFullSharedMessageContent: true });
    expect(requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
      snapshot({ requiresFullSharedMessageContent: false }),
    )).toEqual({ requiresFullSharedMessageContent: false });
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
                  reset_after: 86_400_000,
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

  it('stops only the exact frozen old-generation worker and reports its explicit stop after pending-stop reconciliation', async () => {
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

    await expect(supervisor.stop({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'different-bot',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      authorityEpoch: 8,
      reason: 'delete',
    }, channelsCoreContext())).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    expect(worker.stop).not.toHaveBeenCalled();

    await expect(supervisor.stop({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        botUserId: 'bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
        applicationId: 'application-1',
      },
      credentialRef,
      // Core has already committed the pending row at E+1. Its generic
      // execution origin invokes this frozen request in the E worker's
      // provider generation.
      authorityEpoch: 8,
      reason: 'delete',
    }, channelsCoreContext())).resolves.toEqual({ kind: 'stopped' });
    expect(worker.stop).toHaveBeenCalledTimes(1);

    current = snapshot({ authorityEpoch: 8, enabled: false, deletionState: 'pendingStopReconciliation' });
    await supervisor.reconcile(background);
    expect(actions.execute).toHaveBeenCalledWith(
      {
        pluginId: 'happier.channels',
        localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
      },
      {
        connectionId: 'connection-1',
        authorityEpoch: 8,
        fact: { kind: 'stopConfirmed', reason: 'explicitStop' },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await supervisor.dispose();
  });

  it('returns notRunning only when the old provider generation has no local worker', async () => {
    const supervisor = createDiscordGatewaySupervisor();

    await expect(supervisor.stop({
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
      authorityEpoch: 8,
      reason: 'delete',
    }, channelsCoreContext())).resolves.toEqual({ kind: 'notRunning' });

    await supervisor.dispose();
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
      let resolve!: (result: typeof result) => void;
      return {
        worker: {
          result: new Promise<typeof result>((complete) => { resolve = complete; }),
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
      ([action]) => action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
    );
    expect(transportFactCall?.[1]).toEqual({
      connectionId: current.connectionId,
      authorityEpoch: current.authorityEpoch,
      fact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
    });
    await supervisor.dispose();
    expect(second.worker.stop).toHaveBeenCalledTimes(1);
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
      (input as Readonly<{ reportReadiness?: () => void }>).reportReadiness?.();
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

  it('reaches no Automation authority while the Discord Automation Event is withheld from the manifest', async () => {
    // The host builds an adopted-definition owner only for a manifest-declared
    // automation-eligible Event (`resolveExecutablePluginRuntimeRegistry.ts`).
    // Discord withholds its Event, so any `automation.event.sources.list` this
    // loop issued would fail with `automation_event_adopted_definitions_unavailable`
    // once per reconciliation tick, on every Machine, forever.
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
    // Two completed ticks: an unconditional per-tick catalog read would have
    // reached a host Action addressed by bare id rather than by contribution.
    await vi.waitFor(() => expect(actions.execute.mock.calls.filter(
      ([action]) => (action as { localId?: string } | string as { localId?: string })?.localId
        === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
    ).length).toBeGreaterThan(1));
    generation.abort(new Error('Discord plugin generation retired.'));
    await running;

    expect(actions.execute.mock.calls.filter(([action]) => typeof action === 'string')).toEqual([]);
    await supervisor.dispose();
  });

  it('retries an authentication-failed connection after the host reports a Connected Account credential resync', async () => {
    // Gateway close 4004 means the selected bot token is wrong. Repairing it
    // inside the same Connected Account changes nothing the core reconciliation
    // snapshot carries, so the connection fingerprint is byte-identical and
    // only the host's credential resync can retire the terminal memo.
    const workerResults: DiscordGatewayWorkerResult[] = [
      { kind: 'terminal', reason: 'authenticationFailed' },
    ];
    const workerFactory = vi.fn(() => ({
      result: Promise.resolve(workerResults.shift() ?? ({ kind: 'stopped' } as const)),
      stop: vi.fn(),
    }));
    const supervisor = createDiscordGatewaySupervisor({
      workerFactory,
      reconciliationIntervalMs: 3_600_000,
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
    const credentialResyncListeners: Array<() => void> = [];
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { DISCORD_BOT_TOKEN: 'bot-token' } })),
      watch: vi.fn((purpose: string, listener: () => void) => {
        expect(purpose).toBe('discord-bot-credential');
        credentialResyncListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => response(
        request.url.endsWith('/oauth2/applications/@me')
          ? { id: 'application-1', flags: 0, flags_new: '0' }
          : { id: 'bot-1', username: 'Happier Bot', bot: true },
      )),
      openWebSocket: vi.fn(),
    };
    const generation = new AbortController();
    const { background } = supervisorBackgroundHarness({
      supervisor,
      connectedAccounts,
      http,
      executeCore,
      signal: generation.signal,
    });

    const running = supervisor.run(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(1));

    // The terminal memo holds while the credential is unchanged.
    await supervisor.reconcile(background);
    expect(workerFactory).toHaveBeenCalledTimes(1);

    expect(credentialResyncListeners).toHaveLength(1);
    for (const listener of credentialResyncListeners) listener();
    await supervisor.reconcile(background);
    await vi.waitFor(() => expect(workerFactory).toHaveBeenCalledTimes(2));

    generation.abort(new Error('Discord plugin generation retired.'));
    await running;
    await supervisor.dispose();
  });
});
