import { Ionicons } from '@expo/vector-icons';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type VoicePrivacySectionProps = Readonly<{
    voiceShareSessionSummary: boolean;
    voiceShareRecentMessages: boolean;
    voiceRecentMessagesCount: number | null;
    voiceShareToolNames: boolean;
    voiceSharePermissionRequests: boolean;
    voiceShareFilePaths: boolean;
    onSetVoiceShareSessionSummary: (value: boolean) => void;
    onSetVoiceShareRecentMessages: (value: boolean) => void;
    onSetRecentMessagesCount: () => void;
    onSetVoiceShareToolNames: (value: boolean) => void;
    onSetVoiceSharePermissionRequests: (value: boolean) => void;
    onSetVoiceShareFilePaths: (value: boolean) => void;
}>;

export function VoicePrivacySection(props: VoicePrivacySectionProps) {
    return (
        <ItemGroup
            title={t('settingsVoice.privacy.title')}
            footer={t('settingsVoice.privacy.footer')}
        >
            <Item
                title={t('settingsVoice.privacy.shareSessionSummary')}
                subtitle={t('settingsVoice.privacy.shareSessionSummarySubtitle')}
                icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                rightElement={<Switch value={props.voiceShareSessionSummary} onValueChange={props.onSetVoiceShareSessionSummary} />}
                showChevron={false}
            />
            <Item
                title={t('settingsVoice.privacy.shareRecentMessages')}
                subtitle={t('settingsVoice.privacy.shareRecentMessagesSubtitle')}
                icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#34C759" />}
                rightElement={<Switch value={props.voiceShareRecentMessages} onValueChange={props.onSetVoiceShareRecentMessages} />}
                showChevron={false}
            />
            <Item
                title={t('settingsVoice.privacy.recentMessagesCount')}
                subtitle={t('settingsVoice.privacy.recentMessagesCountSubtitle')}
                icon={<Ionicons name="list-outline" size={29} color="#AF52DE" />}
                detail={String(props.voiceRecentMessagesCount ?? 10)}
                onPress={props.onSetRecentMessagesCount}
            />
            <Item
                title={t('settingsVoice.privacy.shareToolNames')}
                subtitle={t('settingsVoice.privacy.shareToolNamesSubtitle')}
                icon={<Ionicons name="construct-outline" size={29} color="#FF9500" />}
                rightElement={<Switch value={props.voiceShareToolNames} onValueChange={props.onSetVoiceShareToolNames} />}
                showChevron={false}
            />
            <Item
                title={t('settingsVoice.privacy.sharePermissionRequests')}
                subtitle={t('settingsVoice.privacy.sharePermissionRequestsSubtitle')}
                icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
                rightElement={<Switch value={props.voiceSharePermissionRequests} onValueChange={props.onSetVoiceSharePermissionRequests} />}
                showChevron={false}
            />
            <Item
                title={t('settingsVoice.privacy.shareFilePaths')}
                subtitle={t('settingsVoice.privacy.shareFilePathsSubtitle')}
                icon={<Ionicons name="folder-outline" size={29} color="#8E8E93" />}
                rightElement={<Switch value={props.voiceShareFilePaths} onValueChange={props.onSetVoiceShareFilePaths} />}
                showChevron={false}
            />
        </ItemGroup>
    );
}
