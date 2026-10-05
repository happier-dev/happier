import { storage } from '@/sync/domains/state/storage';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import { isVoiceAgentNotFoundError } from '@/voice/agent/voiceAgentErrorGuards';
import {
    persistVoiceAgentWelcomedEpoch,
} from '@/voice/agent/voiceAgentRunState';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceWelcomeText } from '@/voice/agent/voiceWelcomeText';

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
            const agentCfg = readLocalConversationSettingsFromAccountSettings(settings).agent;
            const handle = await args.getVoiceAgentHandle(sessionId);
            if (!handle.accountLifetime.isCurrent()) return null;
            const policy = handle.voicePolicy ?? voiceSettingsParse(settings.voice);
            const welcomeCfg = policy.welcome;
            const welcomeEnabled = welcomeCfg?.enabled === true;
            const welcomeMode = welcomeCfg?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
            if (!welcomeEnabled || welcomeMode !== 'immediate') {
                return null;
            }

            const epochRaw = Number(agentCfg?.transcript?.epoch ?? 0);
            const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;

            const metadataSessionId = handle.metadataSessionId;
            const persistedWelcomedEpoch =
                handle.backend === 'daemon'
                    ? readPersistedWelcomedEpoch(metadataSessionId ?? handle.rpcSessionId, handle.accountLifetime.scope.serverId)
                    : undefined;
            if (persistedWelcomedEpoch === epoch) {
                return null;
            }

            try {
                const welcomeText = resolveVoiceWelcomeText(policy.assistantLanguage);
                const res = await handle.client.welcome({
                    sessionId: handle.rpcSessionId,
                    voiceAgentId: handle.voiceAgentId,
                    ...(welcomeText ? { welcomeText } : {}),
                });
                const assistantText = String(res?.assistantText ?? '').trim();
                if (!assistantText) return null;
                if (handle.backend === 'daemon') {
                    await persistVoiceAgentWelcomedEpoch(metadataSessionId, epoch, handle.accountLifetime).catch(() => {});
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
