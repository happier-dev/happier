import { decryptLegacyBase64, encryptLegacyBase64 } from './messageCrypto';
import { waitFor } from './timing';

type RpcAck = { ok?: boolean; result?: string; error?: string; errorCode?: string };

class ExplicitMachineRpcError extends Error {
  constructor(params: Readonly<{ method: string; errorCode?: string; error?: string }>) {
    const details = [
      params.errorCode ? `errorCode=${params.errorCode}` : '',
      params.error ? `error=${params.error}` : '',
    ].filter(Boolean).join(' ');
    super(`Machine RPC failed explicitly: ${params.method}${details ? ` (${details})` : ''}`);
    this.name = 'ExplicitMachineRpcError';
  }
}

export type MemoryRpcSchema<T> = {
  safeParse: (input: unknown) => { success: true; data: T } | { success: false };
};

export const MemoryEnsureUpToDateAckSchema: MemoryRpcSchema<Readonly<{ ok: true }>> = {
  safeParse: (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as { ok?: unknown }).ok === true) {
      return { success: true, data: { ok: true } };
    }
    return { success: false };
  },
};

function normalizeRpcAck(value: unknown): RpcAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ok: typeof record.ok === 'boolean' ? record.ok : undefined,
    result: typeof record.result === 'string' ? record.result : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
  };
}

export async function callEncryptedMachineRpc<TReq, TRes>(params: {
  ui: { rpcCall: (method: string, encryptedParams: string) => Promise<unknown> };
  machineId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: MemoryRpcSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  const encryptedParams = encryptLegacyBase64(params.req, params.secret);

  await waitFor(
    async () => {
      const res = normalizeRpcAck(await params.ui.rpcCall(`${params.machineId}:${params.method}`, encryptedParams));
      if (res && (res.ok === false || typeof res.errorCode === 'string' || typeof res.error === 'string')) {
        throw new ExplicitMachineRpcError({
          method: params.method,
          errorCode: res.errorCode,
          error: res.error,
        });
      }
      if (!res || res.ok !== true || typeof res.result !== 'string') return false;
      const decrypted = decryptLegacyBase64(res.result, params.secret);
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) return false;
      out = parsed.data;
      return true;
    },
    {
      timeoutMs: params.timeoutMs ?? 45_000,
      shouldRetryOnError: (error) => !(error instanceof ExplicitMachineRpcError),
      context: params.method,
    },
  );

  if (!out) throw new Error(`Machine RPC did not return a valid response: ${params.method}`);
  return out;
}

export async function postEncryptedSessionMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  payload: unknown;
  localId?: string;
  messageRole?: 'user' | 'agent' | 'event' | 'unknown';
}): Promise<void> {
  const ciphertext = encryptLegacyBase64(params.payload, params.secret);
  const res = await fetch(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      ...(params.localId ? { 'Idempotency-Key': params.localId } : {}),
    },
    body: JSON.stringify({
      ...(params.localId ? { localId: params.localId } : {}),
      ...(params.messageRole ? { messageRole: params.messageRole } : {}),
      ciphertext,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post session message (status=${res.status})`);
  }
}
