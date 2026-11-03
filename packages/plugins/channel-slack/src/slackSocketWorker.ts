import type { ConversationProviderFailureV1, ConversationProviderObservationIngestInputV1 } from '@happier-dev/channels-protocol/v1';
import type { HttpService, PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import type { createSlackApi, SlackIdentity } from './slackApi.js';
import { mapSlackEventToIngress } from './slackObservation.js';

export type SlackSocketWorkerResult =
  | Readonly<{ kind: 'stopped'; unprovenContinuity?: true }>
  | Readonly<{ kind: 'historyGap'; reason: 'applicationAdmissionLost' | 'providerHistoryUnavailable' }>
  | Readonly<{ kind: 'notReady'; failure: ConversationProviderFailureV1;
      transportFact?: Readonly<{ kind: 'historyGap'; reason: 'applicationAdmissionLost' }> }>;
export type SlackSocketWorkerInput = Readonly<{
  connection: Readonly<{ connectionId: string; authorityEpoch: number; identity: SlackIdentity }>;
  api: Pick<ReturnType<typeof createSlackApi>, 'openConnection' | 'getChannel'>;
  webSockets: Pick<HttpService, 'openWebSocket'>;
  admitObservation(value: ConversationProviderObservationIngestInputV1, options: Readonly<{ signal: AbortSignal }>): Promise<void>;
  reportConnectionStatus?(status: 'ready'): void | Promise<void>;
  signal: AbortSignal;
}>;
export type SlackSocketWorker = Readonly<{ result: Promise<SlackSocketWorkerResult>; stop(): void }>;
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidConfiguration(): ConversationProviderFailureV1 {
  return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Slack Socket Mode did not confirm the selected app identity.' };
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function receiveFrame(socket: PluginWebSocketConnection, signal: AbortSignal): Promise<unknown> {
  const frame = await socket.receive({ signal });
  if (frame.kind !== 'text') return null;
  try { return JSON.parse(frame.text); } catch { return null; }
}

async function verifyHello(socket: PluginWebSocketConnection, identity: SlackIdentity, signal: AbortSignal): Promise<boolean> {
  const hello = await receiveFrame(socket, signal);
  return isRecord(hello) && hello.type === 'hello' && isRecord(hello.connection_info)
    && hello.connection_info.app_id === identity.appId;
}

export function startSlackSocketWorker(input: SlackSocketWorkerInput): SlackSocketWorker {
  const controller = new AbortController();
  let socket: PluginWebSocketConnection | undefined;
  let connected = false;
  let admissionPending = false;
  const stop = (): void => { controller.abort(); socket?.close(); };
  if (input.signal.aborted) stop();
  else input.signal.addEventListener('abort', stop, { once: true });
  const signal = controller.signal;
  const result = (async (): Promise<SlackSocketWorkerResult> => {
    try {
      signal.throwIfAborted();
      const opened = await input.api.openConnection({ signal });
      if ('kind' in opened) return { kind: 'notReady', failure: opened };
      socket = await input.webSockets.openWebSocket({ url: opened.url }, { signal });
      if (!await verifyHello(socket, input.connection.identity, signal)) return { kind: 'notReady', failure: invalidConfiguration() };
      connected = true;
      await input.reportConnectionStatus?.('ready');
      while (!signal.aborted) {
        const frame = await receiveFrame(socket, signal);
        if (!isRecord(frame)) return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        if (frame.type === 'disconnect') {
          if (frame.reason === 'warning') continue;
          if (frame.reason === 'link_disabled') return { kind: 'notReady', failure: {
            kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Enable Socket Mode in the Slack app settings.' },
            transportFact: { kind: 'historyGap', reason: 'applicationAdmissionLost' } };
          return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        if (frame.type !== 'events_api' || typeof frame.envelope_id !== 'string' || !frame.envelope_id) continue;
        const payload = frame.payload;
        if (!isRecord(payload) || payload.team_id !== input.connection.identity.teamId || payload.api_app_id !== input.connection.identity.appId) {
          return { kind: 'notReady', failure: invalidConfiguration() };
        }
        if (isRecord(payload.event) && typeof payload.event.channel === 'string'
          && (payload.event.type === 'message' || payload.event.type === 'app_mention')) {
          admissionPending = true;
          let channel = await input.api.getChannel(payload.event.channel, { signal });
          // Retry-After belongs to this retained provider frame, not a new queue.
          while ('kind' in channel && channel.reason === 'rateLimited' && channel.retryAfterMs !== undefined) {
            await sleep(channel.retryAfterMs, signal);
            channel = await input.api.getChannel(payload.event.channel, { signal });
          }
          if ('kind' in channel) return { kind: 'notReady', failure: channel,
            transportFact: { kind: 'historyGap', reason: 'applicationAdmissionLost' } };
          const observation = mapSlackEventToIngress({ payload, identity: input.connection.identity, channel });
          if (observation) await input.admitObservation({ connectionId: input.connection.connectionId,
            authorityEpoch: input.connection.authorityEpoch, entry: { observation, eventCandidate: null } }, { signal });
          admissionPending = false;
        }
        signal.throwIfAborted();
        // Slack retries an unacknowledged envelope; native event_id equality is
        // handled by core's census, including a lost ACK after durable custody.
        await socket.send({ kind: 'text', text: JSON.stringify({ envelope_id: frame.envelope_id }) }, { signal });
      }
      return { kind: 'stopped', ...(connected ? { unprovenContinuity: true } : {}) };
    } catch {
      if (signal.aborted) return { kind: 'stopped', ...(connected ? { unprovenContinuity: true } : {}) };
      if (connected) return { kind: 'historyGap', reason: admissionPending ? 'applicationAdmissionLost' : 'providerHistoryUnavailable' };
      return { kind: 'notReady', failure: { kind: 'notReady', reason: 'network', diagnostic: 'Slack Socket Mode could not connect.' } };
    } finally {
      input.signal.removeEventListener('abort', stop);
      socket?.close();
      await socket?.dispose();
    }
  })();
  return { result, stop };
}

export async function verifySlackSocketIdentity(input: Readonly<{
  api: Pick<ReturnType<typeof createSlackApi>, 'openConnection'>;
  webSockets: Pick<HttpService, 'openWebSocket'>;
  identity: SlackIdentity;
  signal: AbortSignal;
}>): Promise<ConversationProviderFailureV1 | null> {
  let socket: PluginWebSocketConnection | undefined;
  try {
    input.signal.throwIfAborted();
    const opened = await input.api.openConnection({ signal: input.signal });
    if ('kind' in opened) return opened;
    socket = await input.webSockets.openWebSocket({ url: opened.url }, { signal: input.signal });
    return await verifyHello(socket, input.identity, input.signal) ? null : invalidConfiguration();
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { kind: 'notReady', reason: 'network', diagnostic: 'Slack Socket Mode could not connect.' };
  } finally { socket?.close(); await socket?.dispose(); }
}
