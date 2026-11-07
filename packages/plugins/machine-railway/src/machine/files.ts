// Railway files bridge v3.16.0: one request per connection, with 64 KiB content frames.
// This transport owns no pool, retries or independent operation deadline.
const ENDPOINT = 'wss://ssh.railway.com:2226/ws/files';
const CHUNK_BYTES = 64 * 1024;

function unavailable(): Error { return new Error('railway_files_unavailable'); }

function transfer(token: string, path: string, write: { bytes: Uint8Array; mode: number } | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      signal?.throwIfAborted();
      socket = new WebSocket(ENDPOINT, ['railway-shell', token]);
    } catch { reject(unavailable()); return; }
    socket.binaryType = 'arraybuffer';
    let settled = false;
    let ready = false;
    let sequence = 0;
    const chunks: Uint8Array[] = [];
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onFailure);
      socket.removeEventListener('close', onFailure);
      try { socket.close(); } catch { /* The operation already has its result. */ }
      if (error) { reject(error); return; }
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      resolve(bytes);
    }
    function onAbort() { finish(unavailable()); }
    function onFailure() { finish(unavailable()); }
    function onOpen() {
      try {
        socket.send(JSON.stringify({ id: '1', type: write ? 'write_start' : 'read', data: write
          ? { path, mode: write.mode, size: write.bytes.length } : { path } }));
      } catch { finish(unavailable()); }
    }
    function onMessage(event: MessageEvent<unknown>) {
      try {
        if (typeof event.data === 'string') {
          const frame: unknown = JSON.parse(event.data);
          if (!frame || typeof frame !== 'object' || !('id' in frame) || frame.id !== '1' || !('type' in frame)) throw unavailable();
          if (frame.type === 'error') throw unavailable();
          if (!write) throw unavailable();
          if (frame.type === 'ok' && ready) { finish(); return; }
          if (frame.type !== 'write_ready' || ready) throw unavailable();
          ready = true;
          let index = 0;
          const send = (type: number, payload: Uint8Array) => {
            const frame = new Uint8Array(12 + payload.length);
            const header = new DataView(frame.buffer);
            header.setUint16(0, 1); header.setUint16(2, type);
            header.setUint32(4, index++); header.setUint32(8, payload.length);
            frame.set(payload, 12);
            socket.send(frame);
          };
          for (let offset = 0; offset < write.bytes.length; offset += CHUNK_BYTES) send(3, write.bytes.subarray(offset, offset + CHUNK_BYTES));
          send(4, new Uint8Array(0));
          return;
        }
        if (write || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 12) throw unavailable();
        const header = new DataView(event.data);
        const type = header.getUint16(2);
        if (header.getUint16(0) !== 1 || ![1, 2].includes(type) || header.getUint32(4) !== sequence++
          || header.getUint32(8) !== event.data.byteLength - 12) throw unavailable();
        chunks.push(new Uint8Array(event.data, 12));
        if (type === 2) finish();
      } catch { finish(unavailable()); }
    }
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onFailure);
    socket.addEventListener('close', onFailure);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function readRailwayFile(token: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  return transfer(token, path, undefined, signal);
}

export async function writeRailwayFile(token: string, path: string, bytes: Uint8Array, mode: number, signal?: AbortSignal): Promise<void> {
  await transfer(token, path, { bytes, mode }, signal);
}
