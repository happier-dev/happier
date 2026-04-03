import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { randomUUID } from 'node:crypto';

import { fetchMessagesSince, fetchSessionV2 } from '../../sessions';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { sleep } from '../../timing';
import { enqueuePendingQueueV2 } from '../../pendingQueueV2';
import { createUserScopedSocketCollector } from '../../socketClient';
import { enrichCapabilityProbeError } from '../harness/capabilityProbeFailure';
import { invokeRpcAcrossMachineIds, resolveMachineIdsFromSettings } from './runtimeHelpers';

type CapabilityRpcMethod = typeof RPC_METHODS.CAPABILITIES_INVOKE | typeof RPC_METHODS.CAPABILITIES_DETECT;

export async function waitForSessionActive(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId).catch(() => null);
    if (snap?.active === true) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session active (${params.sessionId})`);
}

export async function invokeCapabilitiesMethod(params: {
  baseUrl: string;
  token: string;
  cliHome: string;
  secret: Uint8Array;
  rpcMethod: CapabilityRpcMethod;
  payload: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  const settingsPath = `${params.cliHome}/settings.json`;
  const machineIds = await resolveMachineIdsFromSettings({ settingsPath, timeoutMs: 15_000 });
  if (machineIds.length === 0) {
    throw new Error(`machineId not found in settings.json (${settingsPath})`);
  }

  const ui = createUserScopedSocketCollector(params.baseUrl, params.token);
  ui.connect();
  const startedConnectAt = Date.now();
  while (!ui.isConnected() && Date.now() - startedConnectAt < 15_000) {
    await sleep(50);
  }
  if (!ui.isConnected()) {
    ui.close();
    throw await enrichCapabilityProbeError({
      error: new Error('timed out connecting user socket'),
      cliHome: params.cliHome,
      context: params.rpcMethod,
    });
  }

  try {
    try {
      return await invokeRpcAcrossMachineIds({
        ui,
        machineIds,
        method: params.rpcMethod,
        payload: params.payload,
        secret: params.secret,
        timeoutMs: params.timeoutMs ?? 90_000,
      });
    } catch (error) {
      throw await enrichCapabilityProbeError({
        error,
        cliHome: params.cliHome,
        context: params.rpcMethod,
      });
    }
  } finally {
    ui.close();
  }
}

export async function callSessionScopedRpc(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  method: string;
  payload: unknown;
  secret: Uint8Array;
  timeoutMs?: number;
}): Promise<unknown> {
  const ui = createUserScopedSocketCollector(params.baseUrl, params.token);
  ui.connect();
  const startedConnectAt = Date.now();
  while (!ui.isConnected() && Date.now() - startedConnectAt < 15_000) {
    await sleep(50);
  }
  if (!ui.isConnected()) {
    ui.close();
    throw new Error(`timed out connecting user socket for ${params.sessionId}:${params.method}`);
  }

  try {
    const encrypted = encryptLegacyBase64(params.payload, params.secret);
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000;
    const response = await ui.rpcCall<{ ok?: unknown; result?: unknown }>(`${params.sessionId}:${params.method}`, encrypted, timeoutMs);
    if (!response || typeof response !== 'object' || response.ok !== true) {
      throw new Error(`session rpc ${params.method} returned non-ok response`);
    }
    const resultRaw = response.result;
    if (typeof resultRaw !== 'string' || resultRaw.length === 0) return null;
    return decryptLegacyBase64(resultRaw, params.secret);
  } finally {
    ui.close();
  }
}

export async function enqueueSessionPromptForScenario(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  text: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const localId = randomUUID();
  const payload = {
    role: 'user',
    content: { type: 'text', text: params.text },
    localId,
    meta: {
      source: 'ui',
      sentFrom: 'e2e',
      ...(params.meta ?? {}),
    },
  };
  const ciphertext = encryptLegacyBase64(payload, params.secret);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const res = await enqueuePendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId,
      ciphertext,
      timeoutMs: 20_000,
    }).catch(() => null);
    if (res?.status === 200) return;
    await sleep(100);
  }
  throw new Error(`timed out enqueueing prompt for ${params.sessionId}`);
}

export async function waitForAssistantMessageContaining(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  requiredSubstring?: string;
  requiredSubstrings?: string[];
  afterSeqStart?: number;
  allowAnyAssistantMessage?: boolean;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let afterSeq = typeof params.afterSeqStart === 'number' ? params.afterSeqStart : 0;
  const streamedTextByKey = new Map<string, string>();
  const requiredSubstring = typeof params.requiredSubstring === 'string' && params.requiredSubstring.length > 0
    ? params.requiredSubstring
    : null;
  const requiredSubstrings = Array.isArray(params.requiredSubstrings)
    ? params.requiredSubstrings
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    : [];

  while (Date.now() < deadline) {
    const rows = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
    }).catch(() => []);

    if (rows.length > 0) {
      afterSeq = Math.max(afterSeq, ...rows.map((row) => row.seq));
    }

    for (const row of rows) {
      try {
        const decrypted = decryptLegacyBase64(row.content.c, params.secret) as Record<string, unknown> | null;
        if (!decrypted || typeof decrypted !== 'object') continue;
        const role = typeof decrypted.role === 'string' ? decrypted.role : '';
        if (params.allowAnyAssistantMessage === true) return;

        const candidateTexts: string[] = [];
        const meta = decrypted.meta && typeof decrypted.meta === 'object' ? (decrypted.meta as Record<string, unknown>) : null;
        const streamSegmentV1 =
          meta && typeof meta.happierStreamSegmentV1 === 'object' && meta.happierStreamSegmentV1 && !Array.isArray(meta.happierStreamSegmentV1)
            ? (meta.happierStreamSegmentV1 as Record<string, unknown>)
            : null;
        const streamSegmentLocalId =
          streamSegmentV1 && typeof streamSegmentV1.segmentLocalId === 'string' ? String(streamSegmentV1.segmentLocalId) : null;
        const streamKey = meta && typeof meta.happierStreamKey === 'string' ? String(meta.happierStreamKey) : null;
        const sidechainStreamKey =
          meta && typeof meta.happierSidechainStreamKey === 'string' ? String(meta.happierSidechainStreamKey) : null;
        const anyStreamKey = streamSegmentLocalId ?? streamKey ?? sidechainStreamKey;

        if (role === 'assistant') {
          if (typeof decrypted.content === 'string') {
            candidateTexts.push(decrypted.content);
          } else if (decrypted.content && typeof decrypted.content === 'object') {
            const content = decrypted.content as Record<string, unknown>;
            const text = typeof content.text === 'string' ? content.text : '';
            if (text) candidateTexts.push(text);
            const parts = Array.isArray(content.parts) ? content.parts : [];
            for (const part of parts) {
              if (!part || typeof part !== 'object') continue;
              const partText = typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : '';
              if (partText) candidateTexts.push(partText);
            }
          }
        }

        if (role === 'agent') {
          const content = decrypted.content && typeof decrypted.content === 'object'
            ? (decrypted.content as Record<string, unknown>)
            : null;
          if (content?.type === 'acp') {
            const data = content.data && typeof content.data === 'object'
              ? (content.data as Record<string, unknown>)
              : null;
            if (data?.type === 'message' && typeof data.message === 'string') {
              candidateTexts.push(data.message);
              if (anyStreamKey) {
                if (streamSegmentLocalId) {
                  // `StreamedTranscriptWriter` commits cumulative snapshots (not deltas).
                  // Prefer the longest snapshot we observe for the segment key.
                  const prev = streamedTextByKey.get(anyStreamKey) ?? '';
                  const next = data.message.length >= prev.length ? data.message : prev;
                  streamedTextByKey.set(anyStreamKey, next);
                  candidateTexts.push(next);
                } else {
                  const prev = streamedTextByKey.get(anyStreamKey) ?? '';
                  const next = prev + data.message;
                  streamedTextByKey.set(anyStreamKey, next);
                  candidateTexts.push(next);
                }
              }
            }
          }
        }

        const raw = JSON.stringify(decrypted);
        const haystacks = [...candidateTexts, raw];
        if (requiredSubstring && haystacks.some((value) => value.includes(requiredSubstring))) return;
        if (requiredSubstrings.length > 0 && requiredSubstrings.every((needle) => haystacks.some((value) => value.includes(needle)))) return;
      } catch {
        // ignore malformed row
      }
    }

    await sleep(250);
  }

  if (requiredSubstring) {
    throw new Error(`Timed out waiting for assistant message containing ${requiredSubstring}`);
  }
  if (requiredSubstrings.length > 0) {
    throw new Error(`Timed out waiting for assistant message containing all required substrings (${requiredSubstrings.join(', ')})`);
  }
  throw new Error('Timed out waiting for assistant message');
}
