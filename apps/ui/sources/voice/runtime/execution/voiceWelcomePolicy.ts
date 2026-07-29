import { storage } from '@/sync/domains/state/storage';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import { isVoiceAgentNotFoundError } from '@/voice/agent/voiceAgentErrorGuards';
import { readPersistedVoiceConversationRuntimeState } from '@/voice/binding/voiceConversationBindingPersistence';
import {
    persistVoiceAgentWelcomedEpoch,
    resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

function readPersistedWelcomedEpoch(metadataSessionId: string | null): number | undefined {
    if (!metadataSessionId) return undefined;
    const metadata = readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId });
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
            const settings: any = storage.getState().settings;
            const agentCfg = readLocalConversationSettingsFromAccountSettings(settings).agent;
            const welcomeCfg = voiceSettingsParse(settings?.voice).welcome;
            const welcomeEnabled = welcomeCfg?.enabled === true;
            const welcomeMode = welcomeCfg?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
            if (!welcomeEnabled || welcomeMode !== 'immediate') {
                await args.getVoiceAgentHandle(sessionId);
                return null;
            }

            const epochRaw = Number(agentCfg?.transcript?.epoch ?? 0);
            const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;

            const handle = await args.getVoiceAgentHandle(sessionId);
            const persistedRuntimeState =
                handle.backend === 'daemon'
                    ? readPersistedVoiceConversationRuntimeState({
                        managedSessionId: sessionId,
                        conversationSessionId: handle.rpcSessionId,
                    })
                    : null;
            const metadataSessionId =
                persistedRuntimeState?.metadataSessionId
                ?? resolveVoiceRunMetadataSessionId(sessionId, handle.backend, handle.rpcSessionId);
            const persistedWelcomedEpoch =
                handle.backend === 'daemon'
                    ? readPersistedWelcomedEpoch(metadataSessionId ?? handle.rpcSessionId)
                    : undefined;
            if (persistedWelcomedEpoch === epoch) {
                return null;
            }

            try {
                const res = await handle.client.welcome({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
                const assistantText = String(res?.assistantText ?? '').trim();
                if (!assistantText) return null;
                if (handle.backend === 'daemon') {
                    await persistVoiceAgentWelcomedEpoch(metadataSessionId, epoch).catch(() => {});
                }
                return assistantText;
            } catch (error) {
                if (isVoiceAgentNotFoundError(error)) {
                    args.resetCachedHandle(sessionId);
                }
                return null;
            }
        },
    };
}
