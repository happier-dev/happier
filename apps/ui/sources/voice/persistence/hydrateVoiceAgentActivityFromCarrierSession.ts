import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { findVoiceCarrierSessionId } from '@/voice/agent/voiceCarrierSession';

type VoiceAgentTurnPayloadV1 = Readonly<{
  v: 1;
  epoch: number;
  role: 'user' | 'assistant';
  voiceAgentId: string;
  ts: number;
}>;

function resolveTranscriptConfig(state: any): Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }> {
  const cfg = state?.settings?.voice?.adapters?.local_conversation?.agent?.transcript ?? null;
  const persistenceMode = cfg?.persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';
  const epochRaw = Number(cfg?.epoch ?? 0);
  const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
  return { persistenceMode, epoch };
}

function resolveNetworkTimeoutMs(state: any): number {
  const raw = Number(state?.settings?.voice?.adapters?.local_conversation?.networkTimeoutMs ?? 0);
  if (Number.isFinite(raw) && raw > 0) return Math.max(250, Math.min(60_000, Math.floor(raw)));
  return 5_000;
}

function isTurnPayloadV1(value: unknown): value is VoiceAgentTurnPayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return (
    v.v === 1 &&
    typeof v.epoch === 'number' &&
    typeof v.role === 'string' &&
    (v.role === 'user' || v.role === 'assistant') &&
    typeof v.voiceAgentId === 'string' &&
    typeof v.ts === 'number'
  );
}

function buildEventsFromCarrierMessages(params: Readonly<{
  carrierMessages: ReadonlyArray<any>;
  epoch: number;
}>): ReadonlyArray<any> {
  const out: any[] = [];

  for (const msg of params.carrierMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const meta = (msg as any).meta ?? null;
    const happier = meta?.happier ?? null;
    if (!happier || happier.kind !== 'voice_agent_turn.v1') continue;

    const payload = happier.payload;
    if (!isTurnPayloadV1(payload)) continue;
    if (payload.epoch !== params.epoch) continue;

    const createdAtRaw = Number((msg as any).createdAt ?? payload.ts);
    const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : payload.ts;
    const id = typeof (msg as any).id === 'string' ? (msg as any).id : null;
    const text = typeof (msg as any).text === 'string' ? String((msg as any).text) : '';
    if (!id || !text.trim()) continue;

    out.push({
      id,
      ts: createdAt,
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      adapterId: 'local_conversation',
      kind: payload.role === 'user' ? 'user.text' : 'assistant.text',
      text: text.trim(),
    });
  }

  out.sort((a, b) => (a.ts === b.ts ? String(a.id).localeCompare(String(b.id)) : a.ts - b.ts));
  return out;
}

async function waitForCarrierMessagesLoaded(carrierSessionId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const s: any = storage.getState();
    if (s?.sessionMessages?.[carrierSessionId]?.isLoaded === true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Hydrate the global voice agent activity feed from the persisted transcript messages
 * inside the hidden voice carrier session (if present + transcript persistence enabled).
 */
export async function hydrateVoiceAgentActivityFromCarrierSession(): Promise<void> {
  const state: any = storage.getState();
  const transcript = resolveTranscriptConfig(state);
  if (transcript.persistenceMode !== 'persistent') return;

  const carrierSessionId = findVoiceCarrierSessionId(state);
  if (!carrierSessionId) return;

  if (state?.sessionMessages?.[carrierSessionId]?.isLoaded !== true) {
    try {
      sync.onSessionVisible(carrierSessionId);
    } catch {
      // Best-effort only; hydration should never crash the UI if sync isn't ready yet.
    }
    await waitForCarrierMessagesLoaded(carrierSessionId, resolveNetworkTimeoutMs(storage.getState() as any));
  }

  const nextState: any = storage.getState();
  const carrierMessages = nextState?.sessionMessages?.[carrierSessionId]?.messages ?? [];
  const events = buildEventsFromCarrierMessages({ carrierMessages, epoch: transcript.epoch });
  useVoiceActivityStore.getState().replaceSessionEvents(VOICE_AGENT_GLOBAL_SESSION_ID, events as any);
}
