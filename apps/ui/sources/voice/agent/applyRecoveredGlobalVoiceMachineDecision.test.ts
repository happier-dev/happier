import { describe, expect, it } from 'vitest';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import { applyRecoveredGlobalVoiceMachineDecision } from './applyRecoveredGlobalVoiceMachineDecision';
import {
    clearVoiceAgentRecoveryReplaySource,
    readVoiceAgentRecoveryReplaySource,
    setVoiceAgentRecoveryReplaySource,
} from './voiceAgentRecoveryReplayState';

describe('applyRecoveredGlobalVoiceMachineDecision', () => {
    it('stores the replay source when switching with replay enabled', () => {
        clearVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID);

        applyRecoveredGlobalVoiceMachineDecision({
            kind: 'switch',
            nextMachineId: 'machine-b',
            replayConversation: true,
            replaySourceConversationSessionId: 'voice-session-1',
        });

        expect(readVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe('voice-session-1');
    });

    it('clears the replay source when switching without replay', () => {
        setVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID, 'voice-session-stale');

        applyRecoveredGlobalVoiceMachineDecision({
            kind: 'switch',
            nextMachineId: 'machine-b',
            replayConversation: false,
            replaySourceConversationSessionId: null,
        });

        expect(readVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID)).toBeNull();
    });

    it('clears any stale replay source on retry decisions', () => {
        setVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID, 'voice-session-stale');

        applyRecoveredGlobalVoiceMachineDecision({
            kind: 'retry',
        });

        expect(readVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID)).toBeNull();
    });
});
