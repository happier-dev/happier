import type { CDPSession } from '@playwright/test';
import { Decoder, PacketType, type Packet } from 'socket.io-parser';

type Bytes = number | 'unavailable';
type Direction = 'sent' | 'received';
type Bucket = { family: string; type: string };
type DecoderState = { decoder: Decoder; direction: Direction; pending: Array<{ phase: string; bytes: number }> };
type HttpRequest = {
  phase: string; method: string; route: string; done: boolean; failed: boolean;
  decoded: number; encoded: number; chunks: number; responseBytes?: number;
  requestBodyBytes: Bytes;
  status?: number; encoding: string; cache: boolean; serviceWorker: boolean; late: boolean;
};
export type HttpTransfer = {
  method: string; route: string; requests: number; failed: number; inFlight: number; lateResponses: number;
  decodedBodyBytes: Bytes; encodedBodyBytes: Bytes; encodedResponseBytes: Bytes;
  requestBodyBytes: Bytes;
  unavailableBodies: number; statuses: Record<string, number>; encodings: Record<string, number>;
  cached: number; serviceWorker: number;
};
export type WebSocketTransfer = Bucket & {
  direction: Direction; frames: number; messages: number; applicationBytes: number;
};
export type NetworkTransferSnapshot = {
  status: 'complete' | 'incomplete';
  wsEncodedBytes: 'unavailable';
  lostEvents: number;
  phases: Array<{
    name: string; durationMs: number; inFlightAtEnd: number; socketDisconnects: number;
    http: HttpTransfer[]; webSocket: WebSocketTransfer[];
  }>;
};

// Export only fixed vocabulary. New protocol events remain measurable without leaking names or contents.
export const NETWORK_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'] as const;
export const NETWORK_ROUTES = ['non-api', 'engine-transport', 'session-list', 'session-list-targeted', 'transcript', 'exact-session', 'organization-scoped', 'organization-full', 'changes', 'features-auth', 'other-api'] as const;
export const NETWORK_EVENT_FAMILIES = ['update', 'ephemeral', 'rpc-call', 'rpc-request', 'rpc-response', 'rpc-register', 'rpc-registered', 'rpc-error', 'session-alive', 'machine-alive'] as const;
export const NETWORK_EVENT_TYPES = ['new-message', 'update-message', 'new-session', 'update-session', 'delete-session', 'update-machine', 'new-machine', 'delete-machine', 'update-account', 'pending-changed', 'session-organization-changed', 'activity', 'usage', 'machine-activity', 'session-runtime', 'session-list-changed'] as const;
const EVENT_FAMILIES: ReadonlySet<string> = new Set(NETWORK_EVENT_FAMILIES);
const EVENT_TYPES: ReadonlySet<string> = new Set(NETWORK_EVENT_TYPES);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function eventBucket(data: unknown): Bucket {
  if (!Array.isArray(data) || !EVENT_FAMILIES.has(data[0])) return { family: 'unknown', type: 'unknown' };
  const payload = record(data[1]);
  const kind = record(payload?.body)?.t ?? payload?.type ?? payload?.t;
  return { family: data[0], type: typeof kind === 'string' && EVENT_TYPES.has(kind) ? kind : 'unknown' };
}

function routeClass(raw: string, apiOrigin: string): string {
  const url = new URL(raw);
  if (url.origin !== apiOrigin || !/^\/v\d+\//.test(url.pathname)) return 'non-api';
  const path = url.pathname;
  if (path === '/v1/updates' || path.startsWith('/v1/updates/')) return 'engine-transport';
  if (/\/sessions\/read-batch$/.test(path)) return 'session-list-targeted';
  if (/^\/v\d+\/sessions$/.test(path)) {
    return ['requiredSessionIds', 'requiredOnly', 'pinnedSessionIds'].some((key) => url.searchParams.has(key))
      ? 'session-list-targeted' : 'session-list';
  }
  if (/\/sessions\/[^/]+\/(messages|turns|transcript|history)/.test(path)) return 'transcript';
  if (/^\/v\d+\/sessions\/[^/]+$/.test(path)) return 'exact-session';
  if (path.startsWith('/v2/session-organization')) {
    return ['assignmentSessionIds', 'folderIds', 'tagIds', 'orderScopes'].some((key) => url.searchParams.has(key))
      || ['includeAllFolderAssignments', 'includeAllTagAssignments', 'includeFolders', 'includeTags', 'includeLabels'].some((key) => url.searchParams.get(key) === 'false')
      ? 'organization-scoped' : 'organization-full';
  }
  if (/\/changes(?:\/|$)/.test(path)) return 'changes';
  if (/\/(features|auth)(?:\/|$)/.test(path)) return 'features-auth';
  return 'other-api';
}

function bodyBytes(request: HttpRequest, kind: 'decoded' | 'encoded'): Bytes {
  if (!request.done || request.failed) return 'unavailable';
  if (request.method === 'HEAD' || request.status === 204 || request.status === 304) return 0;
  if (!request.chunks || (kind === 'encoded' && request.encoded === 0 && request.decoded > 0)) return 'unavailable';
  return request[kind];
}

function sumEvidence(values: Bytes[]): Bytes {
  return values.includes('unavailable') ? 'unavailable' : (values as number[]).reduce((sum, value) => sum + value, 0);
}

/** CDP body chunks are distinct from loadingFinished's header-inclusive response bytes.
 * WS payloads are already decompressed; they cannot establish encoded network bytes.
 */
export async function collectNetworkTransfer(session: CDPSession, apiBaseUrl: string) {
  const apiOrigin = new URL(apiBaseUrl).origin;
  const requests = new Map<string, HttpRequest>();
  const nonHttpRequests = new Set<string>();
  const completed: HttpRequest[] = [];
  const phases: Array<{ name: string; started: number; ended?: number; inFlightAtEnd?: number; socketDisconnects: number }> = [];
  const frames = new Map<string, WebSocketTransfer & { phase: string }>();
  const sockets = new Map<string, boolean>();
  const decoders = new Map<string, DecoderState>();
  const on = session.on.bind(session);
  let lostEvents = 0;
  let active = 'setup';
  let stopped = false;

  function wsRow(direction: Direction, bucket: Bucket, phase = active): WebSocketTransfer {
    const key = `${phase}:${direction}:${bucket.family}:${bucket.type}`;
    let row = frames.get(key);
    if (!row) {
      row = { phase, direction, ...bucket, frames: 0, messages: 0, applicationBytes: 0 };
      frames.set(key, row);
    }
    return row;
  }
  function flushFrames(state: DecoderState, bucket: Bucket) {
    for (const observation of state.pending) {
      const row = wsRow(state.direction, bucket, observation.phase);
      row.frames += 1;
      row.applicationBytes += observation.bytes;
    }
    state.pending = [];
  }
  function inFlight() {
    return [...requests.values()].filter((request) => !request.done && !['non-api', 'engine-transport'].includes(request.route)).length;
  }
  function closePhase() {
    const phase = phases.at(-1);
    if (phase && phase.ended === undefined) {
      phase.ended = Date.now();
      phase.inFlightAtEnd = inFlight();
    }
  }
  function finish(id: string, failed: boolean, responseBytes?: number) {
    if (nonHttpRequests.has(id)) return;
    const request = requests.get(id);
    if (!request) { lostEvents += 1; return; }
    request.done = true;
    request.failed = failed;
    request.responseBytes = responseBytes;
    request.late = request.phase !== active || phases.find((phase) => phase.name === request.phase)?.ended !== undefined;
  }

  on('Network.requestWillBeSent', (event) => {
    if (!/^https?:/.test(event.request.url)) { nonHttpRequests.add(event.requestId); return; }
    const previous = requests.get(event.requestId);
    if (previous) {
      // Redirect hops reuse CDP IDs; retain the hop as incomplete rather than losing it.
      completed.push(previous);
    }
    requests.set(event.requestId, {
      phase: active, method: NETWORK_HTTP_METHODS.some((method) => method === event.request.method) ? event.request.method : 'OTHER',
      route: routeClass(event.request.url, apiOrigin), done: false, failed: false,
      decoded: 0, encoded: 0, chunks: 0, encoding: 'unavailable', cache: false, serviceWorker: false, late: false,
      requestBodyBytes: typeof event.request.postData === 'string' ? Buffer.byteLength(event.request.postData) : event.request.hasPostData ? 'unavailable' : 0,
    });
  });
  on('Network.responseReceived', ({ requestId, response }) => {
    if (nonHttpRequests.has(requestId)) return;
    const request = requests.get(requestId);
    if (!request) { lostEvents += 1; return; }
    request.status = response.status;
    const encoding = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-encoding')?.[1];
    request.encoding = encoding === undefined ? 'identity' : ['gzip', 'br', 'deflate', 'zstd'].includes(String(encoding)) ? String(encoding) : 'other';
    request.cache ||= response.fromDiskCache === true;
    request.serviceWorker = response.fromServiceWorker === true;
  });
  on('Network.requestServedFromCache', ({ requestId }) => {
    const request = requests.get(requestId);
    if (request) request.cache = true;
  });
  on('Network.dataReceived', (event) => {
    if (nonHttpRequests.has(event.requestId)) return;
    const request = requests.get(event.requestId);
    if (!request) { lostEvents += 1; return; }
    request.decoded += event.dataLength;
    request.encoded += event.encodedDataLength;
    request.chunks += 1;
  });
  on('Network.loadingFinished', (event) => finish(event.requestId, false, event.encodedDataLength));
  on('Network.loadingFailed', (event) => finish(event.requestId, true));
  on('Network.webSocketCreated', ({ requestId, url }) => {
    const parsed = new URL(url);
    sockets.set(requestId, parsed.host === new URL(apiBaseUrl).host && /^\/(v1\/updates|socket\.io)(\/|$)/.test(parsed.pathname));
  });
  on('Network.webSocketClosed', ({ requestId }) => {
    if (sockets.get(requestId)) {
      const phase = phases.at(-1);
      if (phase) phase.socketDisconnects += 1;
    }
    for (const direction of ['sent', 'received'] as const) {
      const key = `${requestId}:${direction}`;
      const state = decoders.get(key);
      if (state && state.pending.length > 0) { lostEvents += 1; flushFrames(state, { family: 'unknown', type: 'unknown' }); }
      state?.decoder.destroy();
      decoders.delete(key);
    }
    sockets.delete(requestId);
  });
  on('Network.webSocketFrameError', () => { lostEvents += 1; });

  function frame(direction: Direction, event: { requestId: string; response: { payloadData: string; opcode: number } }) {
    const { payloadData: payload, opcode } = event.response;
    const bytes = opcode === 1 ? Buffer.byteLength(payload) : Buffer.from(payload, 'base64').length;
    let bucket: Bucket = { family: 'unknown', type: 'unknown' };
    if (sockets.get(event.requestId) === false) bucket = { family: 'development', type: 'transport' };
    else if ([8, 9, 10].includes(opcode)) bucket = { family: 'websocket', type: opcode === 8 ? 'close' : opcode === 9 ? 'ping' : 'pong' };
    else if (opcode === 2 || (opcode === 1 && payload.startsWith('4'))) {
      const key = `${event.requestId}:${direction}`;
      let state = decoders.get(key);
      if (!state) {
        state = { decoder: new Decoder(), direction, pending: [] };
        const decoderState = state;
        state.decoder.on('decoded', (packet: Packet) => {
          const decodedBucket = packet.type === PacketType.EVENT || packet.type === PacketType.BINARY_EVENT
            ? eventBucket(packet.data as unknown) : { family: 'socket', type: packet.type === PacketType.ACK || packet.type === PacketType.BINARY_ACK ? 'ack' : packet.type === PacketType.CONNECT ? 'connect' : packet.type === PacketType.DISCONNECT ? 'disconnect' : 'error' };
          wsRow(direction, decodedBucket).messages += 1;
          flushFrames(decoderState, decodedBucket);
        });
        decoders.set(key, state);
      }
      // Let the owned decoder interpret namespaces, ack IDs and binary reconstruction.
      // Keep only frame sizes/phase until it emits the completed packet's classification.
      state.pending.push({ phase: active, bytes });
      try {
        state.decoder.add(opcode === 2 ? Buffer.from(payload, 'base64') : payload.slice(1));
      } catch {
        lostEvents += 1;
        flushFrames(state, { family: 'unknown', type: 'unknown' });
        state.decoder.destroy();
        decoders.delete(key);
      }
      return;
    } else if (opcode === 1 && /^[012356]/.test(payload)) {
      bucket = { family: 'engine', type: ({ '0': 'open', '1': 'close', '2': 'ping', '3': 'pong', '5': 'upgrade', '6': 'noop' } as Record<string, string>)[payload[0]] };
    }
    const row = wsRow(direction, bucket);
    row.frames += 1;
    row.applicationBytes += bytes;
  }
  on('Network.webSocketFrameReceived', (event) => frame('received', event));
  on('Network.webSocketFrameSent', (event) => frame('sent', event));
  await session.send('Network.enable');

  return {
    beginPhase(name: string) {
      closePhase(); active = name;
      phases.push({ name, started: Date.now(), socketDisconnects: 0 });
    },
    endPhase() {
      closePhase();
      active = 'setup';
    },
    inFlight,
    async setCacheDisabled(cacheDisabled: boolean) { await session.send('Network.setCacheDisabled', { cacheDisabled }); },
    snapshot(): NetworkTransferSnapshot {
      const allRequests = [...completed, ...requests.values()];
      const snapshotFrames = new Map([...frames].map(([key, row]) => [key, { ...row }]));
      for (const state of decoders.values()) {
        for (const observation of state.pending) {
          const key = `${observation.phase}:${state.direction}:unknown:unknown`;
          const row = snapshotFrames.get(key) ?? { phase: observation.phase, direction: state.direction, family: 'unknown', type: 'unknown', frames: 0, messages: 0, applicationBytes: 0 };
          row.frames += 1; row.applicationBytes += observation.bytes;
          snapshotFrames.set(key, row);
        }
      }
      const resultPhases = phases.map((phase) => {
        const groups = new Map<string, HttpRequest[]>();
        for (const request of allRequests.filter((request) => request.phase === phase.name)) {
          const key = `${request.method}:${request.route}`;
          const group = groups.get(key) ?? []; group.push(request); groups.set(key, group);
        }
        const http = [...groups.values()].map((group): HttpTransfer => ({
          method: group[0].method, route: group[0].route, requests: group.length,
          failed: group.filter((request) => request.failed).length,
          inFlight: group.filter((request) => !request.done).length,
          lateResponses: group.filter((request) => request.late).length,
          decodedBodyBytes: sumEvidence(group.map((request) => bodyBytes(request, 'decoded'))),
          encodedBodyBytes: sumEvidence(group.map((request) => bodyBytes(request, 'encoded'))),
          encodedResponseBytes: sumEvidence(group.map((request) => request.responseBytes ?? 'unavailable')),
          requestBodyBytes: sumEvidence(group.map((request) => request.requestBodyBytes)),
          unavailableBodies: group.filter((request) => bodyBytes(request, 'decoded') === 'unavailable' || bodyBytes(request, 'encoded') === 'unavailable').length,
          statuses: group.reduce<Record<string, number>>((counts, request) => { const status = String(request.status ?? 'unavailable'); counts[status] = (counts[status] ?? 0) + 1; return counts; }, {}),
          encodings: group.reduce<Record<string, number>>((counts, request) => { counts[request.encoding] = (counts[request.encoding] ?? 0) + 1; return counts; }, {}),
          cached: group.filter((request) => request.cache).length,
          serviceWorker: group.filter((request) => request.serviceWorker).length,
        })).sort((a, b) => `${a.route}:${a.method}`.localeCompare(`${b.route}:${b.method}`));
        return {
          name: phase.name, durationMs: (phase.ended ?? Date.now()) - phase.started,
          inFlightAtEnd: phase.inFlightAtEnd ?? inFlight(), socketDisconnects: phase.socketDisconnects,
          http, webSocket: [...snapshotFrames.values()].filter((row) => row.phase === phase.name).map(({ phase: _, ...row }) => ({ ...row })),
        };
      });
      const incomplete = lostEvents > 0 || [...decoders.values()].some((state) => state.pending.length > 0)
        || resultPhases.some((phase) => phase.inFlightAtEnd > 0 || phase.http.some((row) =>
          row.failed > 0 || Object.keys(row.statuses).some((status) => Number(status) >= 400)
          || (!['non-api', 'engine-transport'].includes(row.route)
            && (row.inFlight > 0 || row.unavailableBodies > 0 || row.statuses.unavailable > 0))));
      return { status: incomplete ? 'incomplete' : 'complete', wsEncodedBytes: 'unavailable', lostEvents, phases: resultPhases };
    },
    async stop() {
      if (stopped) return;
      closePhase(); stopped = true;
      // The spec gives this collector a dedicated session; detach owns its event lifetime.
      for (const state of decoders.values()) state.decoder.destroy();
      await session.detach();
    },
  };
}
