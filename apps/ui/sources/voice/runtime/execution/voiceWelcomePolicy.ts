import { storage } from '@/sync/domains/state/storage';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import { isVoiceAgentNotFoundError } from '@/voice/agent/voiceAgentErrorGuards';
import {
    persistVoiceAgentWelcomedEpoch,
    resolveBoundTargetSessionAddress,
} from '@/voice/agent/voiceAgentRunState';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { preloadVoiceWelcomeText, resolveVoiceWelcomeText } from '@/voice/agent/voiceWelcomeText';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';

function readPersistedWelcomedEpoch(metadataSessionId: string | null, serverId: string): number | undefined {
    if (!metadataSessionId) return undefined;
    const metadata = readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId, serverId });
    return typeof metadata?.welcomedEpoch === 'number' ? metadata.welcomedEpoch : undefined;
}

export function createVoiceWelcomePolicy(args: Readonly<{
    getVoiceAgentHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    resetCachedHandle: (sessionId: string) => void;
}>): Readonly<{
    ensureRunningAndMaybeWelcome: (sessionId: string) => Promise<string | null>;
}> {
    return {
        ensureRunningAndMaybeWelcome: async (sessionId: string) => {
            const settings = storage.getState().settings;
            const boundTarget = resolveBoundTargetSessionAddress(sessionId);
            const targetKey = boundTarget ? sessionAddressKey(boundTarget) : null;
            const handle = await args.getVoiceAgentHandle(sessionId);
            const isCurrent = () => {
                const currentTarget = resolveBoundTargetSessionAddress(sessionId);
                return handle.accountLifetime.isCurrent() && !handle.signal?.aborted
                    && (currentTarget ? sessionAddressKey(currentTarget) : null) === targetKey;
            };
            if (!isCurrent()) return null;
            const policy = handle.voicePolicy ?? voiceSettingsParse(settings.voice);
            const welcomeCfg = policy.welcome;
            const welcomeEnabled = welcomeCfg?.enabled === true;
            const welcomeMode = welcomeCfg?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
            if (!welcomeEnabled || welcomeMode !== 'immediate') {
                return null;
            }

            const epoch = handle.transcriptEpoch;

            const metadataSessionId = handle.metadataSessionId;
            const persistedWelcomedEpoch =
                handle.backend === 'daemon'
                    ? readPersistedWelcomedEpoch(metadataSessionId ?? handle.rpcSessionId, handle.accountLifetime.scope.serverId)
                    : undefined;
            if (persistedWelcomedEpoch === epoch) {
                return null;
            }

            try {
                await preloadVoiceWelcomeText(policy.assistantLanguage);
                if (!isCurrent()) return null;
                const welcomeText = welcomeCfg && 'text' in welcomeCfg && typeof welcomeCfg.text === 'string'
                    ? welcomeCfg.text
                    : resolveVoiceWelcomeText(policy.assistantLanguage);
                const res = await handle.client.welcome({
                    sessionId: handle.rpcSessionId,
                    voiceAgentId: handle.voiceAgentId,
                    ...(typeof welcomeText === 'string' ? { welcomeText } : {}),
                });
                if (!isCurrent()) return null;
                if (res.preparedInstructionsFor) {
                    voiceConversationRuntimeMachine.setPreparedInstructionsFor({ controlSessionId: sessionId,
                        preparedInstructionsFor: res.preparedInstructionsFor });
                }
                const assistantText = String(res?.assistantText ?? '').trim();
                if (!assistantText) return null;
                if (handle.backend === 'daemon') {
                    await persistVoiceAgentWelcomedEpoch(metadataSessionId, epoch, handle.accountLifetime).catch(() => {});
                }
                return assistantText;
            } catch (error) {
                if (!isCurrent()) return null;
                if (isVoiceAgentNotFoundError(error)) {
                    args.resetCachedHandle(sessionId);
                }
                throw error;
            }
        },
    };
}
