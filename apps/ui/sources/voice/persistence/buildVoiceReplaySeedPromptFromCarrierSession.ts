import { buildHappierReplayPromptFromDialog, type HappierReplayDialogItem, type HappierReplayStrategy } from '@happier-dev/agents';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

type VoiceAgentTurnPayloadV1 = Readonly<{
  v: 1;
  epoch: number;
  role: 'user' | 'assistant';
  voiceAgentId: string;
  ts: number;
}>;

function isTurnPayloadV1(value: unknown): value is VoiceAgentTurnPayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return (
    v.v === 1 &&
    typeof v.epoch === 'number' &&
    (v.role === 'user' || v.role === 'assistant') &&
    typeof v.voiceAgentId === 'string' &&
    typeof v.ts === 'number'
  );
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveNetworkTimeoutMs(state: any): number {
  const raw = Number(state?.settings?.voice?.adapters?.local_conversation?.networkTimeoutMs ?? 0);
  if (Number.isFinite(raw) && raw > 0) return Math.max(250, Math.min(60_000, Math.floor(raw)));
  return 5_000;
}

async function waitForCarrierMessagesLoaded(carrierSessionId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const s: any = storage.getState();
    if (s?.sessionMessages?.[carrierSessionId]?.isLoaded === true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function buildVoiceReplaySeedPromptFromCarrierSession(params: Readonly<{
  carrierSessionId: string;
  epoch: number;
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
}>): Promise<string> {
  const carrierSessionId = String(params.carrierSessionId ?? '').trim();
  if (!carrierSessionId) return '';
  const epoch = Number.isFinite(params.epoch) && params.epoch >= 0 ? Math.floor(params.epoch) : 0;

  const initialState: any = storage.getState();
  if (initialState?.sessionMessages?.[carrierSessionId]?.isLoaded !== true) {
    try {
      sync.onSessionVisible(carrierSessionId);
    } catch {
      // Best-effort only; resume context must never block agent start.
    }
    const timeoutMs = Math.min(1_000, resolveNetworkTimeoutMs(storage.getState() as any));
    await waitForCarrierMessagesLoaded(carrierSessionId, timeoutMs);
  }

  const state: any = storage.getState();
  const messages: any[] = state?.sessionMessages?.[carrierSessionId]?.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const dialog: HappierReplayDialogItem[] = [];
  for (const msg of messages) {
    const happier = msg?.meta?.happier ?? null;
    if (!happier || happier.kind !== 'voice_agent_turn.v1') continue;
    const payload = happier.payload;
    if (!isTurnPayloadV1(payload)) continue;
    if (payload.epoch !== epoch) continue;

    const text = normalizeText(msg?.text);
    if (!text) continue;
    const createdAtRaw = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt) ? msg.createdAt : payload.ts;
    const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : 0;
    dialog.push({
      role: payload.role === 'assistant' ? 'Assistant' : 'User',
      createdAt,
      text,
    });
  }

  if (dialog.length === 0) return '';

  return buildHappierReplayPromptFromDialog({
    previousSessionId: carrierSessionId,
    dialog,
    strategy: params.strategy,
    recentMessagesCount: params.recentMessagesCount,
  });
}

