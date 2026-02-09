import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { logger } from '@/utils/logger';
import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';

const MAX_REPLAY_EVENTS = 1_000;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeTextForMatch(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function makeLocalId(params: {
  provider: string;
  remoteSessionId: string;
  sidechainId: string;
  index: number;
  key: string;
}): string {
  const sidechainShort = sha256(params.sidechainId).slice(0, 16);
  const remoteSessionShort = sha256(params.remoteSessionId).slice(0, 16);
  const short = sha256(params.key).slice(0, 12);
  return `acp-sidechain-import:v1:${params.provider}:${sidechainShort}:${remoteSessionShort}:e${params.index}:${short}`;
}

function isSafeRemoteSessionId(remoteSessionId: string): boolean {
  const raw = String(remoteSessionId ?? '');
  if (raw.length === 0) return false;
  if (raw.length > 128) return false;
  // Avoid ambiguous/unsafe identifiers: reject whitespace and path separators.
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return false;
  return true;
}

function isSafeSidechainId(sidechainId: string): boolean {
  const raw = String(sidechainId ?? '');
  if (raw.length === 0) return false;
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return false;
  return true;
}

function makeSidechainCallId(params: { sidechainId: string; toolCallId: string }): string {
  // Avoid collisions with main-thread tool ids: namespace under the parent Task call id.
  return `sc:${params.sidechainId}:${params.toolCallId}`;
}

function safeStringifyForKey(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value ?? null, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      return v;
    });
  } catch (e) {
    try {
      return inspect(value, { depth: 2, breakLength: 120 });
    } catch {
      return '[Unserializable]';
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

export async function importAcpReplaySidechainV1(params: {
  session: AcpReplaySidechainSessionClient;
  provider: ACPProvider;
  remoteSessionId: string;
  sidechainId: string;
  replay: ReadonlyArray<unknown>;
}): Promise<void> {
  if (!isSafeRemoteSessionId(params.remoteSessionId)) {
    logger.debug('[ACP Sidechain Import] Invalid remoteSessionId; skipping sidechain import', {
      provider: params.provider,
      remoteSessionId: String(params.remoteSessionId ?? '').slice(0, 80),
    });
    return;
  }

  const sidechainId = String(params.sidechainId ?? '').trim();
  if (!sidechainId || !isSafeSidechainId(sidechainId)) {
    logger.debug('[ACP Sidechain Import] Invalid sidechainId; skipping sidechain import', {
      provider: params.provider,
      sidechainId: sidechainId.slice(0, 80),
    });
    return;
  }

  const replay = params.replay.length > MAX_REPLAY_EVENTS
    ? params.replay.slice(0, MAX_REPLAY_EVENTS)
    : params.replay;
  if (replay.length !== params.replay.length) {
    logger.warn('[ACP Sidechain Import] Replay exceeded max event limit; truncating import', {
      provider: params.provider,
      remoteSessionId: params.remoteSessionId,
      sidechainId,
      maxEvents: MAX_REPLAY_EVENTS,
      replayEvents: params.replay.length,
    });
  }

  const pendingSyntheticToolCallIds: string[] = [];
  let syntheticToolCallCounter = 0;

  for (let i = 0; i < replay.length; i++) {
    const event = asRecord(replay[i]);
    if (!event) continue;

    const eventType = getString(event, 'type');
    if (!eventType) continue;

    if (eventType === 'message') {
      // For now, import only agent role messages into the sidechain thread.
      // Many providers include user prompts in replay; those can be displayed via the parent Task tool input instead.
      const role = getString(event, 'role');
      const textRaw = getString(event, 'text');
      if (role !== 'agent' || typeof textRaw !== 'string') continue;
      const text = String(textRaw);
      const localId = makeLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        sidechainId,
        index: i,
        key: `message:${normalizeTextForMatch(text)}`,
      });
      await params.session.sendAgentMessageCommitted(
        params.provider,
        { type: 'message', message: text, sidechainId } satisfies ACPMessageData,
        { localId, meta: { importedFrom: 'acp-sidechain', remoteSessionId: params.remoteSessionId, sidechainId } },
      );
      continue;
    }

    if (eventType === 'tool_call') {
      let toolCallId = (getString(event, 'toolCallId') ?? '').trim();
      if (!toolCallId) {
        toolCallId = `synthetic_${syntheticToolCallCounter++}`;
        pendingSyntheticToolCallIds.push(toolCallId);
        logger.debug('[ACP Sidechain Import] Missing toolCallId on tool_call event; using synthetic id', {
          provider: params.provider,
          remoteSessionId: params.remoteSessionId,
          sidechainId,
          index: i,
          toolCallId,
        });
      }
      const callId = makeSidechainCallId({ sidechainId, toolCallId });
      const name = (getString(event, 'kind') ?? getString(event, 'title') ?? 'tool').trim() || 'tool';
      const rawInput = event.rawInput ?? {};
      const localId = makeLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        sidechainId,
        index: i,
        key: `tool_call:${toolCallId}:${name}:${safeStringifyForKey(rawInput)}`,
      });
      await params.session.sendAgentMessageCommitted(
        params.provider,
        { type: 'tool-call', callId, name, input: rawInput, id: `import-${callId}`, sidechainId } satisfies ACPMessageData,
        { localId, meta: { importedFrom: 'acp-sidechain', remoteSessionId: params.remoteSessionId, sidechainId } },
      );
      continue;
    }

    if (eventType === 'tool_result') {
      let toolCallId = (getString(event, 'toolCallId') ?? '').trim();
      if (!toolCallId) {
        const queuedSyntheticId = pendingSyntheticToolCallIds.shift() ?? null;
        toolCallId = queuedSyntheticId ?? `synthetic_${syntheticToolCallCounter++}`;
        const details = {
          provider: params.provider,
          remoteSessionId: params.remoteSessionId,
          sidechainId,
          index: i,
          toolCallId,
          pendingSyntheticToolCalls: pendingSyntheticToolCallIds.length,
          matchedSyntheticToolCall: Boolean(queuedSyntheticId),
        };
        if (queuedSyntheticId) {
          logger.debug('[ACP Sidechain Import] Missing toolCallId on tool_result event; using synthetic id', details);
        } else {
          logger.warn(
            '[ACP Sidechain Import] Missing toolCallId on tool_result event with no pending synthetic tool_call id; generated synthetic id',
            details,
          );
        }
      }
      const callId = makeSidechainCallId({ sidechainId, toolCallId });
      const rawOutput = event.rawOutput ?? event.content ?? null;
      const status = getString(event, 'status');
      const isError = status === 'error' || status === 'failed' || status === 'cancelled';
      const localId = makeLocalId({
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        sidechainId,
        index: i,
        key: `tool_result:${toolCallId}:${String(event.status ?? '')}:${safeStringifyForKey(rawOutput)}`,
      });
      await params.session.sendAgentMessageCommitted(
        params.provider,
        { type: 'tool-result', callId, output: rawOutput, id: `import-${callId}-result`, isError, sidechainId } satisfies ACPMessageData,
        { localId, meta: { importedFrom: 'acp-sidechain', remoteSessionId: params.remoteSessionId, sidechainId } },
      );
      continue;
    }
  }
}
