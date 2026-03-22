import { readFile } from 'node:fs/promises';

import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep } from '../../timing';
import { withTimeoutMs } from '../../timing/withTimeout';

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveMachineIdCandidatesFromSettings(settingsLike: unknown): string[] {
  if (!settingsLike || typeof settingsLike !== 'object') return [];
  const settings = settingsLike as Record<string, unknown>;
  const out: string[] = [];

  const push = (value: unknown) => {
    const next = nonEmptyTrimmedString(value);
    if (!next) return;
    if (!out.includes(next)) out.push(next);
  };

  push(settings.machineId);

  const activeServerId = nonEmptyTrimmedString(settings.activeServerId);
  const byServerRaw = settings.machineIdByServerId;
  const byServer = byServerRaw && typeof byServerRaw === 'object' && !Array.isArray(byServerRaw)
    ? (byServerRaw as Record<string, unknown>)
    : null;
  if (activeServerId && byServer) {
    push(byServer[activeServerId]);
  }
  if (byServer) {
    for (const value of Object.values(byServer)) {
      push(value);
    }
  }

  return out;
}

export async function resolveMachineIdsFromSettings(params: {
  settingsPath: string;
  timeoutMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(params.settingsPath, 'utf8').catch(() => '');
    if (raw) {
      try {
        const json = JSON.parse(raw);
        const ids = resolveMachineIdCandidatesFromSettings(json);
        if (ids.length > 0) return ids;
      } catch {
        // ignore and retry
      }
    }
    await sleep(100);
  }
  return [];
}

export async function invokeRpcAcrossMachineIds(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineIds: string[];
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs: number;
}): Promise<unknown> {
  const encrypted = encryptLegacyBase64(params.payload, params.secret);
  const deadline = Date.now() + params.timeoutMs;
  let lastMethodUnavailable: unknown = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const rpcAckTimeoutMs = Math.max(1, Math.min(remainingMs, 300_000));

    for (const machineId of params.machineIds) {
      const rpcMethod = `${machineId}:${params.method}`;
      try {
        const candidate = await withTimeoutMs({
          promise: params.ui.rpcCall<any>(rpcMethod, encrypted, rpcAckTimeoutMs),
          timeoutMs: rpcAckTimeoutMs,
          label: `rpcCall ${rpcMethod}`,
        });
        if (candidate && typeof candidate === 'object' && candidate.ok === true) {
          const decrypted = decryptLegacyBase64(String((candidate as any).result ?? ''), params.secret);
          return decrypted;
        }

        const errorCode =
          candidate && typeof candidate === 'object' && typeof (candidate as any).errorCode === 'string'
            ? String((candidate as any).errorCode)
            : '';
        if (errorCode === 'RPC_METHOD_NOT_AVAILABLE') {
          lastMethodUnavailable = { machineId, candidate };
          continue;
        }

        throw new Error(
          `rpc ${params.method} failed: ${JSON.stringify(
            candidate && typeof candidate === 'object' ? candidate : { candidate },
            null,
            2,
          )}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (normalized.includes('timed out') || normalized.includes('timeout')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        if (message.includes('RPC_METHOD_NOT_AVAILABLE')) {
          lastMethodUnavailable = { machineId, error: message };
          continue;
        }
        throw error;
      }
    }

    const pauseMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (pauseMs > 0) await sleep(pauseMs);
  }

  throw new Error(
    `rpc ${params.method} unavailable after wait (${JSON.stringify(
      lastMethodUnavailable ?? { errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
      null,
      2,
    )})`,
  );
}
