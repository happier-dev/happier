import type { Page } from '@playwright/test';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeSocketPayload(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  // Playwright may surface Node Buffers/Uint8Arrays as `object` payloads.
  if (payload instanceof Uint8Array) {
    try {
      return Buffer.from(payload).toString('utf8');
    } catch {
      return null;
    }
  }
  if (isObject(payload)) {
    try {
      return JSON.stringify(payload);
    } catch {
      return null;
    }
  }
  return null;
}

function redactCapturedText(input: string): string {
  // Avoid leaking auth/session tokens into logs.
  return input
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"')
    .replace(/Bearer\\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}

function truncateCapturedFrame(decoded: string, maxChars: number): string {
  const sanitized = redactCapturedText(decoded);
  if (sanitized.length <= maxChars) return sanitized;
  return `${sanitized.slice(0, maxChars)}…<truncated ${sanitized.length - maxChars} chars>`;
}

function pushLimited(list: string[], value: string, maxEntries: number): void {
  list.push(value);
  if (list.length > maxEntries) {
    list.shift();
  }
}

function shouldCapture(decoded: string): boolean {
  // Socket.IO may surface either:
  // - raw frames containing the event name: `42["transfer.relay.v2", ...]`
  // - or already-decoded JSON payload objects (missing the event name).
  //
  // We capture both by matching either the event name or the distinctive
  // transfer envelope fields.
  return decoded.includes('transfer.relay.v2')
    || decoded.includes('"kind":"open"')
    || decoded.includes('"kind":"ack"')
    || decoded.includes('"kind":"chunk"')
    || decoded.includes('"kind":"finish"')
    || decoded.includes('"kind":"abort"')
    || (decoded.includes('"encryptedDataKeyEnvelopeBase64"') && decoded.includes('"payloadBase64"'));
}

export type TransferRelayV2TrafficCapture = Readonly<{
  sawRelayV2EventName: () => boolean;
  sawAbort: () => boolean;
  sawChunkEnvelope: () => boolean;
  frames: ReadonlyArray<string>;
  updateBodies: ReadonlyArray<string>;
}>;

export function collectTransferRelayV2Traffic(
  page: Page,
  options?: Readonly<{
    maxFrames?: number;
    maxUpdateBodies?: number;
    maxChars?: number;
    captureBulkTransfer?: boolean;
  }>,
): TransferRelayV2TrafficCapture {
  let sawRelayV2EventName = false;
  let sawAbort = false;
  let sawChunkEnvelope = false;

  const frames: string[] = [];
  const updateBodies: string[] = [];
  const maxFrames = Math.max(1, Math.floor(options?.maxFrames ?? 2_000));
  const maxUpdateBodies = Math.max(1, Math.floor(options?.maxUpdateBodies ?? 500));
  const maxChars = Math.max(256, Math.floor(options?.maxChars ?? 12_000));
  const captureBulkTransfer = options?.captureBulkTransfer === true;

  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      const decoded = decodeSocketPayload((event as { payload?: unknown }).payload);
      if (!decoded) return;
      if (!shouldCapture(decoded) && !(captureBulkTransfer && decoded.includes('bulkTransfer'))) return;
      if (decoded.includes('transfer.relay.v2')) sawRelayV2EventName = true;
      if (decoded.includes('"kind":"abort"')) sawAbort = true;
      if (decoded.includes('"kind":"chunk"') && decoded.includes('"encryptedDataKeyEnvelopeBase64"')) {
        sawChunkEnvelope = true;
      }
      pushLimited(frames, truncateCapturedFrame(decoded, maxChars), maxFrames);
    });
    ws.on('framesent', (event) => {
      const decoded = decodeSocketPayload((event as { payload?: unknown }).payload);
      if (!decoded) return;
      if (!shouldCapture(decoded) && !(captureBulkTransfer && decoded.includes('bulkTransfer'))) return;
      if (decoded.includes('transfer.relay.v2')) sawRelayV2EventName = true;
      if (decoded.includes('"kind":"abort"')) sawAbort = true;
      if (decoded.includes('"kind":"chunk"') && decoded.includes('"encryptedDataKeyEnvelopeBase64"')) {
        sawChunkEnvelope = true;
      }
      pushLimited(frames, truncateCapturedFrame(decoded, maxChars), maxFrames);
    });
  });

  page.on('response', (response) => {
    const url = response.url();
    const isUpdates = url.includes('/v1/updates/');
    const isSocketIoPolling = url.includes('/socket.io/') && url.includes('transport=polling');
    if (!isUpdates && !isSocketIoPolling) {
      return;
    }

    void (async () => {
      try {
        const body = await response.text();
        if (!body) return;
        if (!shouldCapture(body) && !(captureBulkTransfer && body.includes('bulkTransfer'))) return;
        if (body.includes('transfer.relay.v2')) sawRelayV2EventName = true;
        if (body.includes('"kind":"abort"')) sawAbort = true;
        if (body.includes('"kind":"chunk"') && body.includes('"encryptedDataKeyEnvelopeBase64"')) {
          sawChunkEnvelope = true;
        }
        pushLimited(
          updateBodies,
          truncateCapturedFrame(`[response ${response.status()}] ${url}\n${body}`, maxChars),
          maxUpdateBodies,
        );
      } catch {
        // ignore
      }
    })();
  });

  page.on('request', (request) => {
    const url = request.url();
    const isUpdates = url.includes('/v1/updates/');
    const isRpc = url.includes('/rpc');
    if (!isUpdates && !isRpc) return;
    if (request.method() !== 'POST') return;
    const postData = request.postData();
    if (!postData) return;
    if (!shouldCapture(postData) && !postData.includes('bulkTransfer')) return;
    if (postData.includes('transfer.relay.v2')) sawRelayV2EventName = true;
    if (postData.includes('"kind":"abort"')) sawAbort = true;
    if (postData.includes('"kind":"chunk"') && postData.includes('"encryptedDataKeyEnvelopeBase64"')) {
      sawChunkEnvelope = true;
    }
    pushLimited(updateBodies, truncateCapturedFrame(`[request POST] ${url}\n${postData}`, maxChars), maxUpdateBodies);
  });

  return {
    sawRelayV2EventName: () => sawRelayV2EventName,
    sawAbort: () => sawAbort,
    sawChunkEnvelope: () => sawChunkEnvelope,
    frames,
    updateBodies,
  };
}
