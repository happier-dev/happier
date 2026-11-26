import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import { appendVoiceConversationNoteText } from '@/voice/transcript/voiceConversationTranscript';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

function resolveSessionTitle(address: SessionAddress): string | null {
    const state: any = storage.getState();
    const prefs = getVoiceContextFormatterPrefs({ settings: state.settings });
    return resolveVoiceSessionLabel(address, prefs, { fallbackLabel: '' }) || null;
}

/** One short row per switch, naming only where Voice is now (the previous target is the row above it). */
export function appendVoiceTargetSessionSwitchNote(params: Readonly<{
    conversationSessionId: string;
    previousTargetSessionAddress: SessionAddress | null;
    targetSessionAddress: SessionAddress | null;
}>): void {
    const title = params.targetSessionAddress ? resolveSessionTitle(params.targetSessionAddress) : null;
    const text = !params.targetSessionAddress
        ? t('voiceMoments.notTalkingToSession')
        : title ? t('voiceMoments.nowTalkingTo', { title }) : t('voiceMoments.nowTalkingToAnother');
    appendVoiceConversationNoteText({
        conversationSessionId: params.conversationSessionId,
        text,
    });
}
