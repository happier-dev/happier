import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { VOICE_PROVIDER_IDS } from '@/voice/voiceProviders';

type ByoElevenLabsSectionProps = Readonly<{
    voiceProviderId: string | null;
    byoConfigured: boolean;
    isAutoprovCreating: boolean;
    isAutoprovUpdating: boolean;
    voiceByoElevenLabsAgentId: string | null;
    hasByoApiKey: boolean;
    onAutoprovCreate: () => void;
    onAutoprovUpdate: () => void;
    onSetAgentId: () => void;
    onSetApiKey: () => void;
    onDisconnect: () => void;
}>;

export function ByoElevenLabsSection(props: ByoElevenLabsSectionProps) {
    if (props.voiceProviderId !== VOICE_PROVIDER_IDS.BYO_ELEVENLABS_AGENTS) {
        return null;
    }

    return (
        <ItemGroup
            title={t('settingsVoice.byo.title')}
            footer={props.byoConfigured ? t('settingsVoice.byo.configured') : t('settingsVoice.byo.notConfigured')}
        >
            <Item
                title={t('settingsVoice.byo.autoprovCreate')}
                subtitle={t('settingsVoice.byo.autoprovCreateSubtitle')}
                icon={<Ionicons name="sparkles-outline" size={29} color="#007AFF" />}
                loading={props.isAutoprovCreating}
                onPress={props.onAutoprovCreate}
            />
            <Item
                title={t('settingsVoice.byo.autoprovUpdate')}
                subtitle={t('settingsVoice.byo.autoprovUpdateSubtitle')}
                icon={<Ionicons name="refresh-outline" size={29} color="#34C759" />}
                loading={props.isAutoprovUpdating}
                onPress={props.onAutoprovUpdate}
            />
            <Item
                title={t('settingsVoice.byo.agentId')}
                subtitle={props.voiceByoElevenLabsAgentId ? t('settingsVoice.byo.agentIdSet') : t('settingsVoice.byo.agentIdNotSet')}
                icon={<Ionicons name="finger-print-outline" size={29} color="#AF52DE" />}
                onPress={props.onSetAgentId}
            />
            <Item
                title={t('settingsVoice.byo.apiKey')}
                subtitle={props.hasByoApiKey ? t('settingsVoice.byo.apiKeySet') : t('settingsVoice.byo.apiKeyNotSet')}
                icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                onPress={props.onSetApiKey}
            />
            <Item
                title={t('settingsVoice.byo.disconnect')}
                subtitle={t('settingsVoice.byo.disconnectSubtitle')}
                icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                onPress={props.onDisconnect}
            />
        </ItemGroup>
    );
}
