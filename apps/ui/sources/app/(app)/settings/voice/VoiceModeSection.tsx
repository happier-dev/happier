import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { VOICE_PROVIDER_IDS } from '@/voice/voiceProviders';

type VoiceModeSectionProps = Readonly<{
    voiceProviderId: string | null;
    happierVoiceSupported: boolean | null;
    onSelectVoiceProviderId: (providerId: string) => void;
}>;

export function VoiceModeSection(props: VoiceModeSectionProps) {
    return (
        <ItemGroup
            title={t('settingsVoice.modeTitle')}
            footer={t('settingsVoice.modeDescription')}
        >
            <Item
                title={t('settingsVoice.mode.off')}
                subtitle={t('settingsVoice.mode.offSubtitle')}
                icon={<Ionicons name="mic-off-outline" size={29} color="#FF3B30" />}
                rightElement={props.voiceProviderId === VOICE_PROVIDER_IDS.OFF ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
                onPress={() => props.onSelectVoiceProviderId(VOICE_PROVIDER_IDS.OFF)}
                showChevron={false}
            />
            {props.happierVoiceSupported !== false ? (
                <Item
                    title={t('settingsVoice.mode.happier')}
                    subtitle={t('settingsVoice.mode.happierSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#007AFF" />}
                    rightElement={props.voiceProviderId === VOICE_PROVIDER_IDS.HAPPIER_ELEVENLABS_AGENTS ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
                    onPress={() => props.onSelectVoiceProviderId(VOICE_PROVIDER_IDS.HAPPIER_ELEVENLABS_AGENTS)}
                    showChevron={false}
                />
            ) : null}
            <Item
                title={t('settingsVoice.mode.local')}
                subtitle={t('settingsVoice.mode.localSubtitle')}
                icon={<Ionicons name="laptop-outline" size={29} color="#5856D6" />}
                rightElement={props.voiceProviderId === VOICE_PROVIDER_IDS.LOCAL_OPENAI_STT_TTS ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
                onPress={() => props.onSelectVoiceProviderId(VOICE_PROVIDER_IDS.LOCAL_OPENAI_STT_TTS)}
                showChevron={false}
            />
            <Item
                title={t('settingsVoice.mode.byo')}
                subtitle={t('settingsVoice.mode.byoSubtitle')}
                icon={<Ionicons name="key-outline" size={29} color="#34C759" />}
                rightElement={props.voiceProviderId === VOICE_PROVIDER_IDS.BYO_ELEVENLABS_AGENTS ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
                onPress={() => props.onSelectVoiceProviderId(VOICE_PROVIDER_IDS.BYO_ELEVENLABS_AGENTS)}
                showChevron={false}
            />
        </ItemGroup>
    );
}
