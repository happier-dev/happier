import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { t } from '@/text';

type CaptionedState = 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'interrupted' | 'reconnecting';
const CAPTIONED: ReadonlySet<string> = new Set<CaptionedState>(['connecting', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'reconnecting']);

/** Failures caption with the projection's own reason (how to unblock, or why it failed). */
const FAILED: ReadonlySet<string> = new Set(['permission_required', 'error']);

/** States in which what the call needs matters more than the last thing said. */
const CALL_FIRST: ReadonlySet<string> = new Set(['connecting', 'reconnecting', 'permission_required', 'error']);

type CaptionFacts = Pick<VoiceAttemptControlProjection, 'live' | 'muted' | 'surfaceState' | 'captionLabel'>;

/**
 * The call state's one helpful line (lab `voice-presence` captions): muted wins, then a failure's
 * reason from the projection (`captionLabel`), otherwise the conversing/connection state's caption.
 */
export function resolveVoicePresenceCaption(voice: CaptionFacts): string | null {
    if (voice.live && voice.muted) return t('voicePresence.captions.muted');
    if (FAILED.has(voice.surfaceState)) return voice.captionLabel.trim() || null;
    if (CAPTIONED.has(voice.surfaceState)) return t(`voicePresence.captions.${voice.surfaceState as CaptionedState}`);
    return null;
}

/**
 * The compact containers' quiet second line: while the call itself needs attention (muted, opening,
 * reconnecting, blocked, failed) that caption — never the stale last line, which would read as if
 * the call were fine; otherwise the last line said, or the caption until there is one.
 */
export function resolveVoiceCompactLine(
    voice: CaptionFacts,
    latestTranscriptText: string | null,
): Readonly<{ kind: 'caption' | 'transcript'; text: string }> | null {
    const caption = resolveVoicePresenceCaption(voice);
    const callFirst = (voice.live && voice.muted) || CALL_FIRST.has(voice.surfaceState);
    if (callFirst) return caption ? { kind: 'caption', text: caption } : null;
    const line = latestTranscriptText?.trim();
    if (line) return { kind: 'transcript', text: line };
    return caption ? { kind: 'caption', text: caption } : null;
}

/** A sentence end (with any closing quote or bracket) followed by more words. */
const SENTENCE_BREAK = /[.!?…][”’"')\]]*\s+(?=\S)/g;

/**
 * The newest sentence of a transcript line, for a one-line glimpse that cannot ellipsize its head
 * (web): the island shows what was just said, not how the line began. `tail` marks that earlier
 * words were left out.
 */
export function resolveVoiceTranscriptTail(text: string): Readonly<{ text: string; tail: boolean }> {
    const line = text.trim();
    let start = 0;
    for (const match of line.matchAll(SENTENCE_BREAK)) start = (match.index ?? 0) + match[0].length;
    return start > 0 ? { text: line.slice(start), tail: true } : { text: line, tail: false };
}
