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

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function buildVoiceAgentResumeContextFromCarrierSession(params: Readonly<{
  carrierSessionId: string;
  epoch: number;
  maxTurns?: number;
}>): Promise<string> {
  const carrierSessionId = String(params.carrierSessionId ?? '').trim();
  if (!carrierSessionId) return '';
  const epoch = Number.isFinite(params.epoch) && params.epoch >= 0 ? Math.floor(params.epoch) : 0;
  const maxTurnsRaw = Number(params.maxTurns ?? 24);
  const maxTurns = Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 ? Math.max(1, Math.min(100, Math.floor(maxTurnsRaw))) : 24;

  const initialState: any = storage.getState();
  if (initialState?.sessionMessages?.[carrierSessionId]?.isLoaded !== true) {
    try {
      sync.onSessionVisible(carrierSessionId);
    } catch {
      // Best-effort only; resume context must never block agent start.
    }
    // Cap waiting; agent start should not hang on message sync.
    const timeoutMs = Math.min(1_000, resolveNetworkTimeoutMs(storage.getState() as any));
    await waitForCarrierMessagesLoaded(carrierSessionId, timeoutMs);
  }

  const state: any = storage.getState();
  const messages: any[] = state?.sessionMessages?.[carrierSessionId]?.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const turns: Array<{ ts: number; role: 'user' | 'assistant'; text: string }> = [];
  for (const msg of messages) {
    const meta = msg?.meta ?? null;
    const happier = meta?.happier ?? null;
    if (!happier || happier.kind !== 'voice_agent_turn.v1') continue;
    const payload = happier.payload;
    if (!isTurnPayloadV1(payload)) continue;
    if (payload.epoch !== epoch) continue;
    const text = normalizeText(msg?.text);
    if (!text) continue;
    const ts = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt) ? msg.createdAt : payload.ts;
    turns.push({ ts, role: payload.role, text });
  }

  turns.sort((a, b) => a.ts - b.ts);
  const tail = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
  if (tail.length === 0) return '';

  const lines: string[] = [];
  lines.push('Previous voice conversation (for context):');
  for (const t of tail) {
    lines.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
  }
  return lines.join('\n');
}
