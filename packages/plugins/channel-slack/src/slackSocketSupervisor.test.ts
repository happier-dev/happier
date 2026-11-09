import { describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1, ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProviderObservationIngestInputV1Schema, ConversationTransportFactReportInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { createSlackSocketSupervisor } from './slackSocketSupervisor.js';
import { SLACK_SOCKET_BACKGROUND_SERVICE_ID, SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID } from './slackPluginConstants.js';

const credentialRef = { service: { pluginId: 'happier.channel.slack', localId: 'slack-bot' }, accountId: 'slack:T1:U1' };
const snapshot = ConversationProviderConnectionReconciliationSnapshotV1Schema.parse({ v: 1, connectionId: 'connection-1',
  providerConnectionKey: 'slack:team:T1:app:A1', providerConfigVersion: 1,
  providerConfig: { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' }, credentialRef,
  authorityEpoch: 7, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false });

function harness(input: Readonly<{ empty?: boolean; unreadable?: boolean; disconnect?: 'refresh_requested' | 'unexpected'; failFacts?: boolean; retryAfterSeconds?: number }> = {}) {
  const supervisor = createSlackSocketSupervisor();
  const controller = new AbortController();
  const frames: unknown[] = [{ type: 'hello', connection_info: { app_id: 'A1' } }, {
    type: 'events_api', envelope_id: 'envelope-1', payload: { type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', user: 'U2', text: 'hello', ts: '1700000000.000001' } },
  }, ...(input.disconnect ? [{ type: 'disconnect', reason: input.disconnect }] : [])];
  const openSocket = (initialFrames: readonly unknown[]): PluginWebSocketConnection => {
    const queue = [...initialFrames];
    let close!: () => void;
    let closedOnce = false;
    const closed = new Promise<Readonly<{ kind: 'local'; wasClean: true }>>(resolve => { close = () => {
      if (closedOnce) return;
      closedOnce = true;
      socketsClosed += 1;
      resolve({ kind: 'local', wasClean: true });
    }; });
    return { url: 'wss://wss-primary.slack.com/link', protocol: '', closed,
      async send() {},
      async receive(options) {
        options?.signal?.throwIfAborted();
        const frame = queue.shift();
        if (frame) return { kind: 'text', text: JSON.stringify(frame) };
        const value = await closed;
        return { kind: 'closed', close: value };
      },
      close,
      dispose() { close(); },
    };
  };
  const admissions: unknown[] = [];
  const facts: ReturnType<typeof ConversationTransportFactReportInputV1Schema.parse>[] = [];
  let reads = 0;
  let lists = 0;
  let socketsOpened = 0;
  let socketsClosed = 0;
  const listed = !input.empty;
  let current = snapshot;
  const unavailable = { list: false, read: input.unreadable ?? false };
  let rateLimitedOnce = input.retryAfterSeconds !== undefined;
  let resyncCredentials = (_event: ConnectedAccountBindingEvent) => {};
  let background!: BackgroundServiceContext;
  const execute = vi.fn(async (action: string | Readonly<{ pluginId: string; localId: string }>, value: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
    if (typeof action === 'string') throw new Error('Unexpected host Action.');
    if (action.pluginId === 'happier.channel.slack' && action.localId === SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID) {
      await supervisor.runWorkerAttempt(ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(value), {
        ...background, surface: 'plugin', signal: options?.signal ?? controller.signal,
        contribution: { id: SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID, qualifiedId: `happier.channel.slack/actions/${SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID}` },
        caller: { kind: 'plugin', pluginId: 'happier.channel.slack', occurrenceId: 'slack-generation-1',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'slack-generation-1', installSource: 'npm' },
          contribution: background.contribution, originSurface: 'background',
          materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'happier.channel.slack' } },
      });
      return;
    }
    if (action.pluginId !== 'happier.channels') throw new Error('Unexpected plugin Action.');
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
      lists += 1;
      if (unavailable.list) throw new Error('Account is unavailable');
      return listed ? { [current.connectionId]: current } : {};
    }
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead) {
      reads += 1;
      return unavailable.read || !listed ? {} : { [current.connectionId]: current };
    }
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) { admissions.push(ConversationProviderObservationIngestInputV1Schema.parse(value)); return; }
    if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
      const report = ConversationTransportFactReportInputV1Schema.parse(value);
      if (input.failFacts && report.fact.kind === 'historyGap') throw new Error('Account is unavailable');
      facts.push(report);
      return { kind: 'recorded' };
    }
    throw new Error(`Unexpected Action ${action.localId}`);
  });
  // Host transport, credential materialization and logging are genuine external
  // boundaries. The worker, provider API, classifier and protocol stay real.
  const services = {
    actions: { execute },
    connectedAccounts: { async materialize() { return { kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }; },
      watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => void) { resyncCredentials = listener; return { dispose() {} }; } },
    http: { async openWebSocket() { socketsOpened += 1; return openSocket(socketsOpened === 1 ? frames : [{ type: 'hello', connection_info: { app_id: 'A1' } }]); }, async request({ url }: Readonly<{ url: string }>) {
      if (rateLimitedOnce && url.includes('auth.test')) {
        rateLimitedOnce = false;
        return { status: 429, finalUrl: url, headers: { 'retry-after': String(input.retryAfterSeconds) },
          body: new TextEncoder().encode(JSON.stringify({ ok: false, error: 'ratelimited' })) };
      }
      const body = url.includes('auth.test') ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
        : url.includes('bots.info') ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
          : url.includes('conversations.info') ? { ok: true, channel: { id: 'C1', is_im: false, is_mpim: false, is_private: false, is_archived: false } }
            : { ok: true, url: 'wss://wss-primary.slack.com/link?ticket=fixture' };
      return { status: 200, finalUrl: url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } },
    logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {} },
  } as unknown as PluginInvocationContext['services'];
  background = { plugin: { id: 'happier.channel.slack', version: '0.0.0' }, contribution: { id: SLACK_SOCKET_BACKGROUND_SERVICE_ID,
    qualifiedId: `happier.channel.slack/backgroundServices/${SLACK_SOCKET_BACKGROUND_SERVICE_ID}` },
    surface: 'background', invokedAtMs: 1700000000000, signal: controller.signal, services };
  return { supervisor, background, admissions, facts, controller, unavailable,
    setSnapshot(value: typeof snapshot) { current = value; },
    resyncCredentials: (authorityChanged = true) => resyncCredentials({ kind: 'resync', authorityChanged }),
    get lists() { return lists; }, get reads() { return reads; }, get socketsOpened() { return socketsOpened; },
    get socketsClosed() { return socketsClosed; } };
}

describe('Slack socket supervisor through real target worker Action', () => {
  it('keeps the socket for generation-only changes and replaces it for a credential change', async () => {
    vi.useFakeTimers();
    const h = harness();
    const running = h.supervisor.run(h.background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socketsOpened).toBe(1);
      h.setSnapshot({ ...snapshot, authorityEpoch: 8, requiresFullSharedMessageContent: true,
        providerConfig: { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Updated display label' } });
      h.supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socketsOpened).toBe(1);
      h.setSnapshot({ ...snapshot, authorityEpoch: 9, credentialRef: { ...credentialRef, accountId: 'replacement' } });
      h.supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socketsOpened).toBe(2);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it.each(['list', 'read'] as const)('keeps an active socket across a transient %s failure and recovery', async boundary => {
    vi.useFakeTimers();
    const h = harness();
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.admissions).toHaveLength(1));
      h.unavailable[boundary] = true;
      h.supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      h.unavailable[boundary] = false;
      h.supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socketsOpened).toBe(1);
      expect(h.facts.filter(report => report.fact.kind === 'historyGap')).toEqual([]);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });
  it.each([CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList, CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead])(
    'settles a Collection update refusal from %s for this generation', async refusedAction => {
      vi.useFakeTimers();
      const h = harness();
      const execute = vi.fn(async (action: Readonly<{ localId: string }>) => {
        if (action.localId === refusedAction) throw new PluginError({ code: 'collection_update_required', retryable: false });
        return { 'connection-1': snapshot };
      });
      const warn = vi.fn();
      const context = { ...h.background, services: { ...h.background.services,
        actions: { ...h.background.services.actions, execute }, logger: { ...h.background.services.logger, warn },
      } } as BackgroundServiceContext;
      const running = h.supervisor.run(context);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const initialReads = execute.mock.calls.length;
        for (let pass = 0; pass < 100; pass += 1) {
          h.supervisor.invalidateConnections(); h.resyncCredentials();
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(execute).toHaveBeenCalledTimes(initialReads);
        expect(warn).toHaveBeenCalledExactlyOnceWith('[Channels] Account Collection requires an update',
          { code: 'collection_update_required', retryable: false, recovery: 'updateHappierOnThisMachine' });
      } finally { h.controller.abort(); await running; await h.supervisor.dispose(); vi.useRealTimers(); }
    },
  );

  it.each([true, false])('does no reconciliation reads or timer work in a settled minute (empty: %s)', async empty => {
    vi.useFakeTimers();
    const h = harness({ empty });
    const running = h.supervisor.run(h.background);
    try {
      if (empty) await vi.waitFor(() => expect(h.lists).toBe(1));
      else await vi.waitFor(() => expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7,
        fact: { kind: 'providerReadiness', status: 'ready' } }));
      await vi.advanceTimersByTimeAsync(0);
      const before = { lists: h.lists, reads: h.reads };
      await vi.advanceTimersByTimeAsync(60_000);
      expect({ lists: h.lists - before.lists, reads: h.reads - before.reads }).toEqual({ lists: 0, reads: 0 });
      expect(vi.getTimerCount()).toBe(0);

      h.supervisor.invalidateConnections();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.lists).toBe(before.lists + 1);
      expect(h.reads).toBe(before.reads + (empty ? 0 : 1));
      expect(h.socketsOpened).toBe(empty ? 0 : 1);
      for (let arrival = 0; arrival < 100; arrival += 1) h.resyncCredentials(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.lists).toBe(before.lists + 1);
      expect(h.reads).toBe(before.reads + (empty ? 0 : 1));
      h.resyncCredentials();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.lists).toBe(before.lists + 2);
      expect(h.reads).toBe(before.reads + (empty ? 0 : 2));
      expect(h.socketsOpened).toBe(empty ? 0 : 1);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it.each(['list', 'read'] as const)('retains a repair deadline after an unavailable %s, then parks after recovery', async boundary => {
    vi.useFakeTimers();
    const h = harness();
    h.unavailable[boundary] = true;
    const running = h.supervisor.run(h.background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.lists).toBe(1);
      expect(h.socketsOpened).toBe(0);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(h.lists).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.lists).toBe(2);
      h.unavailable[boundary] = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7,
        fact: { kind: 'providerReadiness', status: 'ready' } });
      const before = h.lists;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.lists).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it('waits for the provider retry deadline without periodic reads and parks once the worker recovers', async () => {
    vi.useFakeTimers();
    const h = harness({ retryAfterSeconds: 45 });
    const running = h.supervisor.run(h.background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const before = h.lists;
      expect(h.socketsOpened).toBe(0);
      h.resyncCredentials(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.lists).toBe(before);
      expect(h.socketsOpened).toBe(0);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(h.lists).toBe(before);
      expect(h.socketsOpened).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.admissions).toHaveLength(1);
      expect(h.socketsOpened).toBe(1);
      const recovered = h.lists;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.lists).toBe(recovered);
      expect(vi.getTimerCount()).toBe(0);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it('rereads authority, ingests and stops naturally when the connection is disabled', async () => {
    const h = harness();
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.admissions).toHaveLength(1));
      expect(h.reads).toBeGreaterThan(0);
      await vi.waitFor(() => expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7, fact: { kind: 'providerReadiness', status: 'ready' } }));
      h.setSnapshot({ ...snapshot, authorityEpoch: 8, enabled: false });
      h.supervisor.invalidateConnections();
      await vi.waitFor(() => expect(h.socketsClosed).toBe(1));
      expect(h.socketsOpened).toBe(1);
      expect(h.facts.some(report => report.fact.kind === 'stopConfirmed')).toBe(false);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; }
  });

  it('never materializes or opens a worker from a list snapshot with an unreadable current authority', async () => {
    const h = harness({ unreadable: true });
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.reads).toBeGreaterThan(0));
      expect(h.socketsOpened).toBe(0);
      expect(h.admissions).toEqual([]);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; }
  });

  it('reconnects a routine refresh without publishing history loss', async () => {
    vi.useFakeTimers();
    const h = harness({ disconnect: 'refresh_requested' });
    const running = h.supervisor.run(h.background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socketsOpened).toBe(2);
      expect(h.facts.some(report => report.fact.kind === 'historyGap')).toBe(false);
      expect(h.admissions).toHaveLength(1);
      const before = h.lists;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.lists).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it('retains a failed history-gap report and does not reconnect around unavailable core custody', async () => {
    vi.useFakeTimers();
    const h = harness({ disconnect: 'unexpected', failFacts: true });
    const running = h.supervisor.run(h.background);
    try {
      await vi.waitFor(() => expect(h.admissions).toHaveLength(1));
      await vi.waitFor(() => expect(h.reads).toBeGreaterThan(1));
      const reads = h.reads;
      // Cross the existing 30-second repair deadline: an initial worker retry
      // delay alone must not masquerade as retained gap-custody protection.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.reads).toBeGreaterThan(reads);
      const retriedReads = h.reads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.reads).toBeGreaterThan(retriedReads);
      expect(h.socketsOpened).toBe(1);
      expect(h.facts.some(report => report.fact.kind === 'historyGap')).toBe(false);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });

  it('reports actual transport loss and reconnects while the notice remains recorded', async () => {
    vi.useFakeTimers();
    const h = harness({ disconnect: 'unexpected' });
    const running = h.supervisor.run(h.background);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.facts).toContainEqual({ connectionId: 'connection-1', authorityEpoch: 7,
        fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.socketsOpened).toBe(2);
      expect(h.admissions).toHaveLength(1);
    } finally { h.controller.abort(); await h.supervisor.dispose(); await running; vi.useRealTimers(); }
  });
});
