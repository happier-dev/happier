import type { VoiceAgentTurnV1 } from './voiceAgentTurnV1.js';
import { VoiceAgentTurnV1Schema } from './voiceAgentTurnV1.js';

type VoiceAgentTurnLocalIdInput = Readonly<
  Pick<VoiceAgentTurnV1, 'epoch' | 'role' | 'ts' | 'voiceAgentId'>
  & {
    runId?: string | null;
    streamId?: string | null;
    requestId?: string | null;
  }
>;

type VoiceAgentTurnProvisionalLocalIdInput = Readonly<{
  transcriptSessionId: string;
  role: Extract<VoiceAgentTurnV1['role'], 'user' | 'assistant'>;
  sequence: number;
}>;

function normalizeOptionalId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeProvisionalSequence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function deriveVoiceAgentTurnProvisionalLocalId(turn: VoiceAgentTurnProvisionalLocalIdInput): string {
  return [
    'voice-turn-provisional',
    normalizeOptionalId(turn.transcriptSessionId) ?? 'unknown',
    turn.role,
    String(normalizeProvisionalSequence(turn.sequence)),
  ].join(':');
}

export function readVoiceAgentTurnProvisionalLocalId(value: unknown): VoiceAgentTurnProvisionalLocalIdInput | null {
  if (typeof value !== 'string') return null;
  const [prefix, transcriptSessionId, role, sequence, ...rest] = value.split(':');
  if (prefix !== 'voice-turn-provisional' || rest.length > 0) return null;
  const normalizedSessionId = normalizeOptionalId(transcriptSessionId);
  if (!normalizedSessionId) return null;
  if (role !== 'user' && role !== 'assistant') return null;
  const numericSequence = Number(sequence);
  if (!Number.isFinite(numericSequence)) return null;

  return {
    transcriptSessionId: normalizedSessionId,
    role,
    sequence: normalizeProvisionalSequence(numericSequence),
  };
}

export function deriveVoiceAgentTurnLocalId(turn: VoiceAgentTurnLocalIdInput): string {
  const scopedIdentity = [
    normalizeOptionalId(turn.runId),
    normalizeOptionalId(turn.streamId),
    normalizeOptionalId(turn.requestId),
  ].filter((value): value is string => value !== null);

  return [
    'voice-turn',
    turn.voiceAgentId.trim(),
    ...scopedIdentity,
    String(turn.epoch),
    turn.role,
    String(turn.ts),
  ].join(':');
}

export function readVoiceAgentTurnPayloadFromMeta(meta: unknown): VoiceAgentTurnV1 | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const envelope = (meta as Record<string, unknown>).happier;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if ((envelope as Record<string, unknown>).kind !== 'voice_agent_turn.v1') return null;
  const parsed = VoiceAgentTurnV1Schema.safeParse((envelope as Record<string, unknown>).payload);
  return parsed.success ? parsed.data : null;
}
