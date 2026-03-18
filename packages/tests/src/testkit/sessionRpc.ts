import type { SocketCollector } from './socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from './messageCrypto';
import { waitFor } from './timing';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

type RpcAck = { ok: boolean; result?: string; error?: string; errorCode?: string };
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };

class LegacyEncryptedSessionRpcApplicationError extends Error {
  readonly name = 'LegacyEncryptedSessionRpcApplicationError';
}

export async function callLegacyEncryptedSessionRpc<TReq, TRes>(params: {
  ui: SocketCollector;
  sessionId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  let lastAck: unknown = null;
  let lastDecrypted: unknown = null;

  const isRpcErrorEnvelope = (value: unknown): value is { ok: false; error?: unknown; errorCode?: unknown } => {
    return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
  };

  const encryptedParams = encryptLegacyBase64(params.req, params.secret);

  try {
    await waitFor(
      async () => {
        const res = await params.ui.rpcCall<RpcAck>(`${params.sessionId}:${params.method}`, encryptedParams);
        lastAck = res;
        if (!res || res.ok !== true || typeof res.result !== 'string') return false;
        const decrypted = unwrapSerializedJsonValue(decryptLegacyBase64(res.result, params.secret));
        lastDecrypted = decrypted;
        if (isRpcErrorEnvelope(decrypted)) {
          const errorCode = typeof decrypted.errorCode === 'string' ? ` (${decrypted.errorCode})` : '';
          const errorMessage = typeof decrypted.error === 'string' ? decrypted.error : 'Unknown RPC error';
          throw new LegacyEncryptedSessionRpcApplicationError(`RPC returned application error${errorCode}: ${errorMessage}`);
        }
        const parsed = params.schema.safeParse(decrypted);
        if (!parsed.success) return false;
        out = parsed.data;
        return true;
      },
      {
        timeoutMs: params.timeoutMs ?? 25_000,
        shouldRetryOnError: (error) => !(error instanceof LegacyEncryptedSessionRpcApplicationError),
      },
    );
  } catch (error) {
    if (error instanceof LegacyEncryptedSessionRpcApplicationError) {
      throw error;
    }
    throw new Error(
      `RPC call timed out waiting for a valid response: ${params.method}; ack=${JSON.stringify(lastAck)} decrypted=${JSON.stringify(lastDecrypted)} cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!out) {
    throw new Error(
      `RPC call did not return a valid response: ${params.method}; ack=${JSON.stringify(lastAck)} decrypted=${JSON.stringify(lastDecrypted)}`,
    );
  }
  return out;
}
