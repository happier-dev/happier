import { Ionicons } from '@expo/vector-icons';
import { Linking, Platform } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
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

    const canAutoprovCreate = props.hasByoApiKey && !props.isAutoprovCreating && !props.isAutoprovUpdating;
    const canAutoprovUpdate = Boolean(props.voiceByoElevenLabsAgentId) && props.hasByoApiKey && !props.isAutoprovCreating && !props.isAutoprovUpdating;

    const openElevenLabsSignup = async () => {
        const url = 'https://elevenlabs.io/sign-up';
        try {
            if (Platform.OS === 'web') {
                window.open(url, '_blank', 'noopener,noreferrer');
            } else {
                await Linking.openURL(url);
            }
        } catch {
            // Swallow - best-effort external link.
        }
    };

    const openElevenLabsApiKeys = async () => {
        const url = 'https://elevenlabs.io/app/settings/api-keys';
        try {
            if (Platform.OS === 'web') {
                window.open(url, '_blank', 'noopener,noreferrer');
            } else {
                await Linking.openURL(url);
            }
        } catch {
            // Swallow - best-effort external link.
        }
    };

    return (
        <ItemGroup
            title={t('settingsVoice.byo.title')}
            footer={props.byoConfigured ? t('settingsVoice.byo.configured') : t('settingsVoice.byo.notConfigured')}
        >
            <Item
                title={t('settingsVoice.byo.createAccount')}
                subtitle={t('settingsVoice.byo.createAccountSubtitle')}
                icon={<Ionicons name="person-add-outline" size={29} color="#007AFF" />}
                onPress={() => {
                    void openElevenLabsSignup();
                }}
            />
            <Item
                title={t('settingsVoice.byo.openApiKeys')}
                subtitle={t('settingsVoice.byo.openApiKeysSubtitle')}
                icon={<Ionicons name="open-outline" size={29} color="#007AFF" />}
                onPress={() => {
                    void openElevenLabsApiKeys();
                }}
            />
            <Item
                title={t('settingsVoice.byo.apiKeyHelp')}
                subtitle={t('settingsVoice.byo.apiKeyHelpSubtitle')}
                icon={<Ionicons name="help-circle-outline" size={29} color="#007AFF" />}
                onPress={() => {
                    Modal.alert(
                        t('settingsVoice.byo.apiKeyHelpDialogTitle'),
                        t('settingsVoice.byo.apiKeyHelpDialogBody')
                    );
                }}
            />
            <Item
                title={t('settingsVoice.byo.apiKey')}
                subtitle={props.hasByoApiKey ? t('settingsVoice.byo.apiKeySet') : t('settingsVoice.byo.apiKeyNotSet')}
                icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                onPress={props.onSetApiKey}
            />
            <Item
                title={t('settingsVoice.byo.autoprovCreate')}
                subtitle={t('settingsVoice.byo.autoprovCreateSubtitle')}
                icon={<Ionicons name="sparkles-outline" size={29} color="#007AFF" />}
                disabled={!canAutoprovCreate}
                loading={props.isAutoprovCreating}
                onPress={props.onAutoprovCreate}
            />
            <Item
                title={t('settingsVoice.byo.agentId')}
                subtitle={props.voiceByoElevenLabsAgentId ? t('settingsVoice.byo.agentIdSet') : t('settingsVoice.byo.agentIdNotSet')}
                icon={<Ionicons name="finger-print-outline" size={29} color="#AF52DE" />}
                onPress={props.onSetAgentId}
            />
            <Item
                title={t('settingsVoice.byo.autoprovUpdate')}
                subtitle={t('settingsVoice.byo.autoprovUpdateSubtitle')}
                icon={<Ionicons name="refresh-outline" size={29} color="#34C759" />}
                disabled={!canAutoprovUpdate}
                loading={props.isAutoprovUpdating}
                onPress={props.onAutoprovUpdate}
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
