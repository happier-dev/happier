import { encryptLegacyBase64 } from './messageCrypto';
import { encryptDataKeyBase64 } from './rpcCrypto';
import { createLegacyRpcClient, type RpcSocket } from './syntheticAgent/rpcClient';
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
  safeParse: (input: unknown) => { success: true; data: T } | { success: false; error?: unknown };
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

function describeInvalidResponseShape(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  }
  const record = value as Record<string, unknown>;
  const describeKnownField = (key: 'protocolVersion' | 'projection'): string => {
    if (!(key in record)) return 'absent';
    const field = record[key];
    if (key === 'protocolVersion' && (typeof field === 'number' || typeof field === 'string')) {
      return JSON.stringify(field);
    }
    if (field === null) return 'null';
    return Array.isArray(field) ? 'array' : typeof field;
  };
  const errorDetail = ['errorCode', 'error']
    .flatMap((key) => typeof record[key] === 'string' ? [` ${key}=${JSON.stringify(record[key])}`] : [])
    .join('');
  return `object keys=[${Object.keys(record).sort().join(',')}] protocolVersion=${describeKnownField('protocolVersion')} projection=${describeKnownField('projection')}${errorDetail}`;
}

export async function callEncryptedMachineRpc<TReq, TRes>(params: {
  ui: RpcSocket;
  machineId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: MemoryRpcSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  let lastSchemaError: unknown = null;
  let lastInvalidResponseShape: string | null = null;
  const client = createLegacyRpcClient(params.ui, params.secret);

  try {
    await waitFor(
      async () => {
        const res = await client.call(`${params.machineId}:${params.method}`, params.req);
        if (res.ok === false) {
          throw new ExplicitMachineRpcError({
            method: params.method,
            errorCode: res.errorCode,
            error: res.error,
          });
        }
        const decrypted = res.result;
        const parsed = params.schema.safeParse(decrypted);
        if (!parsed.success) {
          const handlerError = normalizeRpcAck(decrypted);
          if (handlerError && (typeof handlerError.errorCode === 'string' || typeof handlerError.error === 'string')) {
            throw new ExplicitMachineRpcError({
              method: params.method,
              errorCode: handlerError.errorCode,
              error: handlerError.error,
            });
          }
          lastSchemaError = parsed.error ?? null;
          lastInvalidResponseShape = describeInvalidResponseShape(decrypted);
          return false;
        }
        out = parsed.data;
        return true;
      },
      {
        timeoutMs: params.timeoutMs ?? 45_000,
        shouldRetryOnError: (error) => !(error instanceof ExplicitMachineRpcError),
        context: params.method,
      },
    );
  } catch (error) {
    if (lastSchemaError) {
      const detail = lastSchemaError instanceof Error
        ? lastSchemaError.message
        : String(lastSchemaError);
      const shapeDetail = lastInvalidResponseShape
        ? `; invalid response shape: ${lastInvalidResponseShape}`
        : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}; last schema error: ${detail}${shapeDetail}`);
    }
    throw error;
  }

  if (!out) throw new Error(`Machine RPC did not return a valid response: ${params.method}`);
  return out;
}

export async function postEncryptedSessionMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  encryptionVariant?: 'legacy' | 'dataKey';
  payload: unknown;
  localId?: string;
  messageRole?: 'user' | 'agent' | 'event' | 'unknown';
}): Promise<void> {
  const ciphertext = params.encryptionVariant === 'dataKey'
    ? encryptDataKeyBase64(params.payload, params.secret)
    : encryptLegacyBase64(params.payload, params.secret);
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
