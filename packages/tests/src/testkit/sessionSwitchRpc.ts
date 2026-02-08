import type { SocketCollector } from './socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from './messageCrypto';
import { waitFor } from './timing';

export async function requestSessionSwitchRpc(opts: {
  ui: SocketCollector;
  sessionId: string;
  to: 'local' | 'remote';
  secret: Uint8Array;
  timeoutMs?: number;
}): Promise<boolean> {
  let result: boolean | null = null;
  const params = encryptLegacyBase64({ to: opts.to }, opts.secret);
  await waitFor(
    async () => {
      const res = await opts.ui.rpcCall<{ ok: boolean; result?: string }>(`${opts.sessionId}:switch`, params);
      if (!res || res.ok !== true || typeof res.result !== 'string') return false;
      const decrypted = decryptLegacyBase64(res.result, opts.secret);
      if (decrypted !== true && decrypted !== false) return false;
      result = decrypted;
      return true;
    },
    { timeoutMs: opts.timeoutMs ?? 20_000, context: `${opts.sessionId}:switch` },
  );
  return result ?? false;
}
