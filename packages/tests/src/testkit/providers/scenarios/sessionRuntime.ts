import type { PendingRequestedActionV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { randomUUID } from 'node:crypto';

import { fetchMessagesSince, fetchSessionV2 } from '../../sessions';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../rpcCrypto';
import { sleep } from '../../timing';
import { enqueuePendingQueueV2 } from '../../pendingQueueV2';
import { createUserScopedSocketCollector } from '../../socketClient';
import { createEncryptedRpcClient, createLegacyRpcClient } from '../../syntheticAgent/rpcClient';
import { unwrapSerializedJsonValue } from '../../unwrapSerializedJsonValue';
import { enrichCapabilityProbeError } from '../harness/capabilityProbeFailure';
import { invokeRpcAcrossMachineIds, waitForDaemonMachineIds } from './runtimeHelpers';

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
  const machineIds = await waitForDaemonMachineIds({ settingsPath, timeoutMs: 15_000 });
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
  encryptionVariant?: 'legacy' | 'dataKey';
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
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000;
    const client = params.encryptionVariant === 'dataKey'
      ? createEncryptedRpcClient(ui, {
        encryptRaw: async value => encryptDataKeyBase64(value, params.secret),
        decryptRaw: async ciphertext => decryptDataKeyBase64(ciphertext, params.secret),
      }, 'session')
      : createLegacyRpcClient(ui, params.secret, 'session');
    const response = await client.call(`${params.sessionId}:${params.method}`, params.payload, timeoutMs);
    if (!response.ok) {
      throw new Error(`session rpc ${params.method} failed (${response.errorCode ?? 'no_error_code'})`);
    }
    return params.encryptionVariant === 'dataKey' ? unwrapSerializedJsonValue(response.result) : response.result;
  } finally {
    ui.close();
  }
}

export async function enqueueSessionPromptForScenario(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  encryptionVariant?: 'legacy' | 'dataKey';
  text: string;
  meta?: Record<string, unknown>;
  requestedAction?: PendingRequestedActionV1;
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
  const ciphertext = params.encryptionVariant === 'dataKey'
    ? encryptDataKeyBase64(payload, params.secret)
    : encryptLegacyBase64(payload, params.secret);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const res = await enqueuePendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId,
      ciphertext,
      ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
      timeoutMs: 20_000,
    }).catch(() => null);
    if (res?.status === 200) return;
    await sleep(100);
  }
  throw new Error(`timed out enqueueing prompt for ${params.sessionId}`);
}

type AssistantCandidateExtractionOptions = {
  streamedTextByKey?: Map<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushTextValue(candidateTexts: string[], value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    candidateTexts.push(value);
  }
}

function pushAssistantContentTexts(candidateTexts: string[], content: unknown): void {
  if (typeof content === 'string') {
    pushTextValue(candidateTexts, content);
    return;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      pushTextValue(candidateTexts, part.text);
    }
    return;
  }

  if (!isRecord(content)) return;

  pushTextValue(candidateTexts, content.text);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    pushTextValue(candidateTexts, part.text);
  }
}

export function extractAssistantCandidateTextsFromDecryptedRecord(
  decrypted: Record<string, unknown>,
  options: AssistantCandidateExtractionOptions = {},
): string[] {
  const role = typeof decrypted.role === 'string' ? decrypted.role : '';
  const candidateTexts: string[] = [];
  const meta = isRecord(decrypted.meta) ? decrypted.meta : null;
  const streamSegmentV1 = isRecord(meta?.happierStreamSegmentV1)
    ? meta.happierStreamSegmentV1
    : null;
  const streamSegmentLocalId = typeof streamSegmentV1?.segmentLocalId === 'string'
    ? streamSegmentV1.segmentLocalId
    : null;
  const streamKey = typeof meta?.happierStreamKey === 'string' ? meta.happierStreamKey : null;
  const sidechainStreamKey = typeof meta?.happierSidechainStreamKey === 'string' ? meta.happierSidechainStreamKey : null;
  const anyStreamKey = streamSegmentLocalId ?? streamKey ?? sidechainStreamKey;

  if (role === 'assistant') {
    pushAssistantContentTexts(candidateTexts, decrypted.content);
  }

  if (role !== 'agent') return candidateTexts;

  const content = isRecord(decrypted.content) ? decrypted.content : null;
  if (content?.type === 'acp') {
    const data = isRecord(content.data) ? content.data : null;
    if (data?.type === 'message' && typeof data.message === 'string') {
      candidateTexts.push(data.message);
      if (anyStreamKey && options.streamedTextByKey) {
        if (streamSegmentLocalId) {
          // `StreamedTranscriptWriter` commits cumulative snapshots (not deltas).
          // Prefer the longest snapshot observed for the segment key.
          const prev = options.streamedTextByKey.get(anyStreamKey) ?? '';
          const next = data.message.length >= prev.length ? data.message : prev;
          options.streamedTextByKey.set(anyStreamKey, next);
          candidateTexts.push(next);
        } else {
          const prev = options.streamedTextByKey.get(anyStreamKey) ?? '';
          const next = prev + data.message;
          options.streamedTextByKey.set(anyStreamKey, next);
          candidateTexts.push(next);
        }
      }
    }
  }

  if (content?.type === 'output') {
    const data = isRecord(content.data) ? content.data : null;
    if (data?.type === 'assistant') {
      const message = isRecord(data.message) ? data.message : null;
      if (message) {
        const messageRole = typeof message.role === 'string' ? message.role : '';
        if (messageRole === '' || messageRole === 'assistant') {
          pushAssistantContentTexts(candidateTexts, message.content);
        }
      } else {
        pushAssistantContentTexts(candidateTexts, data.content);
      }
    }
  }

  return candidateTexts;
}

export async function waitForAssistantMessageContaining(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  encryptionVariant?: 'legacy' | 'dataKey';
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
        const decrypted = (params.encryptionVariant === 'dataKey'
          ? decryptDataKeyBase64(row.content.c, params.secret)
          : decryptLegacyBase64(row.content.c, params.secret)) as Record<string, unknown> | null;
        if (!decrypted || typeof decrypted !== 'object') continue;
        if (params.allowAnyAssistantMessage === true) return;

        const candidateTexts = extractAssistantCandidateTextsFromDecryptedRecord(decrypted, { streamedTextByKey });
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
