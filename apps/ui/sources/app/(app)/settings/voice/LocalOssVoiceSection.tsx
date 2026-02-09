import { Ionicons } from '@expo/vector-icons';

import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { VOICE_PROVIDER_IDS } from '@/voice/voiceProviders';

export type VoiceSettingsOpenMenu = null | 'mediatorAgentId' | 'mediatorChatModelId' | 'mediatorCommitModelId';

type AgentPickerOption = Readonly<{
    agentId: string;
    titleKey: string;
    subtitleKey: string;
    iconName: string;
}>;

type ModelOption = Readonly<{
    value: string;
    label: string;
    description?: string;
}>;

type LocalOssVoiceSectionProps = Readonly<{
    voiceProviderId: string | null;
    themeTextSecondary: string;
    openMenu: VoiceSettingsOpenMenu;
    onOpenMenuChange: (menu: VoiceSettingsOpenMenu) => void;
    agentPickerOptions: readonly AgentPickerOption[];
    daemonMediatorModelOptions: readonly ModelOption[];
    daemonMediatorSupportsFreeform: boolean;
    voiceLocalConversationMode: string | null;
    voiceLocalMediatorBackend: string | null;
    voiceMediatorAgentSource: string | null;
    voiceMediatorAgentId: string | null;
    voiceMediatorPermissionPolicy: string | null;
    voiceMediatorVerbosity: string | null;
    voiceMediatorIdleTtlSeconds: number | null;
    voiceMediatorChatModelSource: string | null;
    voiceMediatorChatModelId: string | null;
    voiceMediatorCommitModelSource: string | null;
    voiceMediatorCommitModelId: string | null;
    voiceLocalChatBaseUrl: string | null;
    hasVoiceLocalChatApiKey: boolean;
    voiceLocalChatChatModel: string | null;
    voiceLocalChatCommitModel: string | null;
    voiceLocalChatTemperature: number | null;
    voiceLocalChatMaxTokens: number | null;
    voiceLocalSttBaseUrl: string | null;
    hasVoiceLocalSttApiKey: boolean;
    voiceLocalSttModel: string | null;
    voiceLocalTtsBaseUrl: string | null;
    hasVoiceLocalTtsApiKey: boolean;
    voiceLocalTtsModel: string | null;
    voiceLocalTtsVoice: string | null;
    voiceLocalTtsFormat: string | null;
    voiceLocalAutoSpeakReplies: boolean;
    onSetVoiceLocalConversationMode: (mode: 'mediator' | 'direct_session') => void;
    onToggleVoiceLocalMediatorBackend: () => void;
    onToggleVoiceMediatorAgentSource: () => void;
    onSetVoiceMediatorAgentId: (agentId: string) => void;
    onToggleVoiceMediatorPermissionPolicy: () => void;
    onToggleVoiceMediatorVerbosity: () => void;
    onSetMediatorIdleTtl: () => void;
    onToggleVoiceMediatorChatModelSource: () => void;
    onSetVoiceMediatorChatModelId: (modelId: string) => void;
    onSetDaemonMediatorModelText: (kind: 'chatModel' | 'commitModel') => void;
    onCycleVoiceMediatorCommitModelSource: () => void;
    onSetVoiceMediatorCommitModelId: (modelId: string) => void;
    onSetLocalChatUrl: () => void;
    onSetLocalChatApiKey: () => void;
    onSetLocalChatText: (kind: 'chatModel' | 'commitModel') => void;
    onSetChatTemperature: () => void;
    onSetChatMaxTokens: () => void;
    onSetLocalUrl: (kind: 'stt' | 'tts') => void;
    onSetLocalApiKey: (kind: 'stt' | 'tts') => void;
    onSetLocalText: (kind: 'sttModel' | 'ttsModel' | 'ttsVoice') => void;
    onToggleVoiceLocalTtsFormat: () => void;
    onSetVoiceLocalAutoSpeakReplies: (value: boolean) => void;
}>;

export function LocalOssVoiceSection(props: LocalOssVoiceSectionProps) {
    if (props.voiceProviderId !== VOICE_PROVIDER_IDS.LOCAL_OPENAI_STT_TTS) {
        return null;
    }

    const isMediatorMode = (props.voiceLocalConversationMode ?? 'direct_session') === 'mediator';
    const mediatorBackend = props.voiceLocalMediatorBackend ?? 'daemon';
    const mediatorAgentSource = props.voiceMediatorAgentSource ?? 'session';
    const mediatorPermissionPolicy = props.voiceMediatorPermissionPolicy ?? 'read_only';
    const mediatorVerbosity = props.voiceMediatorVerbosity ?? 'short';
    const mediatorChatModelSource = props.voiceMediatorChatModelSource ?? 'custom';
    const mediatorCommitModelSource = props.voiceMediatorCommitModelSource ?? 'chat';

    return (
        <ItemGroup
            title={t('settingsVoice.local.title')}
            footer={(() => {
                const parts: string[] = [t('settingsVoice.local.footer')];
                const hostish = `${props.voiceLocalSttBaseUrl ?? ''} ${props.voiceLocalTtsBaseUrl ?? ''}`.toLowerCase();
                if (hostish.includes('localhost') || hostish.includes('127.0.0.1')) {
                    parts.push(t('settingsVoice.local.localhostWarning'));
                }
                return parts.join('\n\n');
            })()}
        >
            <Item
                title={t('settingsVoice.local.conversationMode')}
                subtitle={t('settingsVoice.local.conversationModeSubtitle')}
                icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#34C759" />}
                rightElement={
                    <Switch
                        value={isMediatorMode}
                        onValueChange={(value) => props.onSetVoiceLocalConversationMode(value ? 'mediator' : 'direct_session')}
                    />
                }
                showChevron={false}
            />

            {isMediatorMode ? (
                <>
                    <Item
                        title={t('settingsVoice.local.mediatorBackend')}
                        subtitle={t('settingsVoice.local.mediatorBackendSubtitle')}
                        icon={<Ionicons name="swap-horizontal-outline" size={29} color="#007AFF" />}
                        detail={mediatorBackend === 'daemon' ? t('settingsVoice.local.mediatorBackendDaemon') : t('settingsVoice.local.mediatorBackendOpenAi')}
                        onPress={props.onToggleVoiceLocalMediatorBackend}
                    />

                    {mediatorBackend === 'daemon' ? (
                        <>
                            <Item
                                title={t('settingsVoice.local.mediatorAgentSource')}
                                subtitle={t('settingsVoice.local.mediatorAgentSourceSubtitle')}
                                icon={<Ionicons name="git-branch-outline" size={29} color="#007AFF" />}
                                detail={mediatorAgentSource === 'session'
                                    ? t('settingsVoice.local.mediatorAgentSourceSession')
                                    : t('settingsVoice.local.mediatorAgentSourceAgent')}
                                onPress={props.onToggleVoiceMediatorAgentSource}
                            />
                            {mediatorAgentSource === 'agent' ? (
                                <DropdownMenu
                                    open={props.openMenu === 'mediatorAgentId'}
                                    onOpenChange={(next) => props.onOpenMenuChange(next ? 'mediatorAgentId' : null)}
                                    variant="selectable"
                                    search={true}
                                    selectedId={String(props.voiceMediatorAgentId ?? 'claude')}
                                    showCategoryTitles={false}
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    rowKind="item"
                                    trigger={({ open, toggle }) => (
                                        <Item
                                            title={t('settingsVoice.local.mediatorAgentId')}
                                            subtitle={t('settingsVoice.local.mediatorAgentIdSubtitle')}
                                            icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                                            detail={String(props.voiceMediatorAgentId ?? 'claude')}
                                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={props.themeTextSecondary} />}
                                            onPress={toggle}
                                            showChevron={false}
                                        />
                                    )}
                                    items={props.agentPickerOptions.map((opt) => ({
                                        id: opt.agentId,
                                        title: t(opt.titleKey as never),
                                        subtitle: t(opt.subtitleKey as never),
                                        icon: (
                                            <Ionicons
                                                name={opt.iconName as never}
                                                size={24}
                                                color={props.themeTextSecondary}
                                            />
                                        ),
                                    }))}
                                    onSelect={(id) => {
                                        props.onSetVoiceMediatorAgentId(id);
                                        props.onOpenMenuChange(null);
                                    }}
                                />
                            ) : null}

                            <Item
                                title={t('settingsVoice.local.mediatorPermissionPolicy')}
                                subtitle={t('settingsVoice.local.mediatorPermissionPolicySubtitle')}
                                icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
                                detail={mediatorPermissionPolicy === 'read_only' ? t('settingsVoice.local.mediatorPermissionReadOnly') : t('settingsVoice.local.mediatorPermissionNoTools')}
                                onPress={props.onToggleVoiceMediatorPermissionPolicy}
                            />
                            <Item
                                title={t('settingsVoice.local.mediatorVerbosity')}
                                subtitle={t('settingsVoice.local.mediatorVerbositySubtitle')}
                                icon={<Ionicons name="text-outline" size={29} color="#8E8E93" />}
                                detail={mediatorVerbosity === 'short'
                                    ? t('settingsVoice.local.mediatorVerbosityShort')
                                    : t('settingsVoice.local.mediatorVerbosityBalanced')}
                                onPress={props.onToggleVoiceMediatorVerbosity}
                            />
                            <Item
                                title={t('settingsVoice.local.mediatorIdleTtl')}
                                subtitle={t('settingsVoice.local.mediatorIdleTtlSubtitle')}
                                icon={<Ionicons name="time-outline" size={29} color="#8E8E93" />}
                                detail={`${props.voiceMediatorIdleTtlSeconds ?? 300}s`}
                                onPress={props.onSetMediatorIdleTtl}
                            />

                            <Item
                                title={t('settingsVoice.local.mediatorChatModelSource')}
                                subtitle={t('settingsVoice.local.mediatorChatModelSourceSubtitle')}
                                icon={<Ionicons name="flash-outline" size={29} color="#AF52DE" />}
                                detail={mediatorChatModelSource === 'session'
                                    ? t('settingsVoice.local.mediatorChatModelSourceSession')
                                    : t('settingsVoice.local.mediatorChatModelSourceCustom')}
                                onPress={props.onToggleVoiceMediatorChatModelSource}
                            />
                            {mediatorChatModelSource === 'custom' ? (
                                <DropdownMenu
                                    open={props.openMenu === 'mediatorChatModelId'}
                                    onOpenChange={(next) => props.onOpenMenuChange(next ? 'mediatorChatModelId' : null)}
                                    variant="selectable"
                                    search={true}
                                    selectedId={String(props.voiceMediatorChatModelId ?? 'default')}
                                    showCategoryTitles={false}
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    rowKind="item"
                                    trigger={({ open, toggle }) => (
                                        <Item
                                            title={t('settingsVoice.local.chatModel')}
                                            subtitle={t('settingsVoice.local.chatModelSubtitle')}
                                            icon={<Ionicons name="flash-outline" size={29} color="#AF52DE" />}
                                            detail={String(props.voiceMediatorChatModelId ?? 'default')}
                                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={props.themeTextSecondary} />}
                                            onPress={toggle}
                                            showChevron={false}
                                        />
                                    )}
                                    items={[
                                        ...props.daemonMediatorModelOptions.map((opt) => ({
                                            id: String(opt.value),
                                            title: String(opt.label),
                                            subtitle: opt.description ? String(opt.description) : undefined,
                                            icon: <Ionicons name="flash-outline" size={22} color={props.themeTextSecondary} />,
                                        })),
                                        ...(props.daemonMediatorSupportsFreeform
                                            ? [
                                                {
                                                    id: '__custom__',
                                                    title: t('settingsVoice.local.modelCustomTitle'),
                                                    subtitle: t('settingsVoice.local.modelCustomSubtitle'),
                                                    icon: <Ionicons name="create-outline" size={22} color={props.themeTextSecondary} />,
                                                },
                                            ]
                                            : []),
                                    ]}
                                    onSelect={(id) => {
                                        props.onOpenMenuChange(null);
                                        if (id === '__custom__') {
                                            props.onSetDaemonMediatorModelText('chatModel');
                                            return;
                                        }
                                        props.onSetVoiceMediatorChatModelId(id);
                                    }}
                                />
                            ) : null}

                            <Item
                                title={t('settingsVoice.local.mediatorCommitModelSource')}
                                subtitle={t('settingsVoice.local.mediatorCommitModelSourceSubtitle')}
                                icon={<Ionicons name="checkmark-done-outline" size={29} color="#007AFF" />}
                                detail={(() => {
                                    if (mediatorCommitModelSource === 'session') return t('settingsVoice.local.mediatorCommitModelSourceSession');
                                    if (mediatorCommitModelSource === 'custom') return t('settingsVoice.local.mediatorCommitModelSourceCustom');
                                    return t('settingsVoice.local.mediatorCommitModelSourceChat');
                                })()}
                                onPress={props.onCycleVoiceMediatorCommitModelSource}
                            />
                            {mediatorCommitModelSource === 'custom' ? (
                                <DropdownMenu
                                    open={props.openMenu === 'mediatorCommitModelId'}
                                    onOpenChange={(next) => props.onOpenMenuChange(next ? 'mediatorCommitModelId' : null)}
                                    variant="selectable"
                                    search={true}
                                    selectedId={String(props.voiceMediatorCommitModelId ?? 'default')}
                                    showCategoryTitles={false}
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    rowKind="item"
                                    trigger={({ open, toggle }) => (
                                        <Item
                                            title={t('settingsVoice.local.commitModel')}
                                            subtitle={t('settingsVoice.local.commitModelSubtitle')}
                                            icon={<Ionicons name="checkmark-done-outline" size={29} color="#007AFF" />}
                                            detail={String(props.voiceMediatorCommitModelId ?? 'default')}
                                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={props.themeTextSecondary} />}
                                            onPress={toggle}
                                            showChevron={false}
                                        />
                                    )}
                                    items={[
                                        ...props.daemonMediatorModelOptions.map((opt) => ({
                                            id: String(opt.value),
                                            title: String(opt.label),
                                            subtitle: opt.description ? String(opt.description) : undefined,
                                            icon: <Ionicons name="checkmark-done-outline" size={22} color={props.themeTextSecondary} />,
                                        })),
                                        ...(props.daemonMediatorSupportsFreeform
                                            ? [
                                                {
                                                    id: '__custom__',
                                                    title: t('settingsVoice.local.modelCustomTitle'),
                                                    subtitle: t('settingsVoice.local.modelCustomSubtitle'),
                                                    icon: <Ionicons name="create-outline" size={22} color={props.themeTextSecondary} />,
                                                },
                                            ]
                                            : []),
                                    ]}
                                    onSelect={(id) => {
                                        props.onOpenMenuChange(null);
                                        if (id === '__custom__') {
                                            props.onSetDaemonMediatorModelText('commitModel');
                                            return;
                                        }
                                        props.onSetVoiceMediatorCommitModelId(id);
                                    }}
                                />
                            ) : null}
                        </>
                    ) : (
                        <>
                            <Item
                                title={t('settingsVoice.local.chatBaseUrl')}
                                subtitle={props.voiceLocalChatBaseUrl ? String(props.voiceLocalChatBaseUrl) : t('settingsVoice.local.notSet')}
                                icon={<Ionicons name="link-outline" size={29} color="#34C759" />}
                                onPress={props.onSetLocalChatUrl}
                            />
                            <Item
                                title={t('settingsVoice.local.chatApiKey')}
                                subtitle={props.hasVoiceLocalChatApiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
                                icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                                onPress={props.onSetLocalChatApiKey}
                            />
                            <Item
                                title={t('settingsVoice.local.chatModel')}
                                subtitle={t('settingsVoice.local.chatModelSubtitle')}
                                icon={<Ionicons name="flash-outline" size={29} color="#AF52DE" />}
                                detail={String(props.voiceLocalChatChatModel ?? 'default')}
                                onPress={() => props.onSetLocalChatText('chatModel')}
                            />
                            <Item
                                title={t('settingsVoice.local.commitModel')}
                                subtitle={t('settingsVoice.local.commitModelSubtitle')}
                                icon={<Ionicons name="checkmark-done-outline" size={29} color="#007AFF" />}
                                detail={String(props.voiceLocalChatCommitModel ?? 'default')}
                                onPress={() => props.onSetLocalChatText('commitModel')}
                            />
                            <Item
                                title={t('settingsVoice.local.chatTemperature')}
                                subtitle={t('settingsVoice.local.chatTemperatureSubtitle')}
                                icon={<Ionicons name="thermometer-outline" size={29} color="#FF3B30" />}
                                detail={String(props.voiceLocalChatTemperature ?? 0.4)}
                                onPress={props.onSetChatTemperature}
                            />
                            <Item
                                title={t('settingsVoice.local.chatMaxTokens')}
                                subtitle={t('settingsVoice.local.chatMaxTokensSubtitle')}
                                icon={<Ionicons name="stats-chart-outline" size={29} color="#8E8E93" />}
                                detail={props.voiceLocalChatMaxTokens == null ? t('settingsVoice.local.chatMaxTokensUnlimited') : String(props.voiceLocalChatMaxTokens)}
                                onPress={props.onSetChatMaxTokens}
                            />
                        </>
                    )}
                </>
            ) : null}

            <Item
                title={t('settingsVoice.local.sttBaseUrl')}
                subtitle={props.voiceLocalSttBaseUrl ? String(props.voiceLocalSttBaseUrl) : t('settingsVoice.local.notSet')}
                icon={<Ionicons name="cloud-upload-outline" size={29} color="#007AFF" />}
                onPress={() => props.onSetLocalUrl('stt')}
            />
            <Item
                title={t('settingsVoice.local.sttApiKey')}
                subtitle={props.hasVoiceLocalSttApiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
                icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                onPress={() => props.onSetLocalApiKey('stt')}
            />
            <Item
                title={t('settingsVoice.local.sttModel')}
                subtitle={t('settingsVoice.local.sttModelSubtitle')}
                icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                detail={String(props.voiceLocalSttModel ?? 'whisper-1')}
                onPress={() => props.onSetLocalText('sttModel')}
            />

            <Item
                title={t('settingsVoice.local.ttsBaseUrl')}
                subtitle={props.voiceLocalTtsBaseUrl ? String(props.voiceLocalTtsBaseUrl) : t('settingsVoice.local.notSet')}
                icon={<Ionicons name="cloud-download-outline" size={29} color="#007AFF" />}
                onPress={() => props.onSetLocalUrl('tts')}
            />
            <Item
                title={t('settingsVoice.local.ttsApiKey')}
                subtitle={props.hasVoiceLocalTtsApiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
                icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                onPress={() => props.onSetLocalApiKey('tts')}
            />
            <Item
                title={t('settingsVoice.local.ttsModel')}
                subtitle={t('settingsVoice.local.ttsModelSubtitle')}
                icon={<Ionicons name="volume-high-outline" size={29} color="#34C759" />}
                detail={String(props.voiceLocalTtsModel ?? 'tts-1')}
                onPress={() => props.onSetLocalText('ttsModel')}
            />
            <Item
                title={t('settingsVoice.local.ttsVoice')}
                subtitle={t('settingsVoice.local.ttsVoiceSubtitle')}
                icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                detail={String(props.voiceLocalTtsVoice ?? 'alloy')}
                onPress={() => props.onSetLocalText('ttsVoice')}
            />
            <Item
                title={t('settingsVoice.local.ttsFormat')}
                subtitle={t('settingsVoice.local.ttsFormatSubtitle')}
                icon={<Ionicons name="musical-notes-outline" size={29} color="#8E8E93" />}
                detail={String(props.voiceLocalTtsFormat ?? 'mp3')}
                onPress={props.onToggleVoiceLocalTtsFormat}
            />
            <Item
                title={t('settingsVoice.local.autoSpeak')}
                subtitle={t('settingsVoice.local.autoSpeakSubtitle')}
                icon={<Ionicons name="play-circle-outline" size={29} color="#007AFF" />}
                rightElement={<Switch value={props.voiceLocalAutoSpeakReplies} onValueChange={props.onSetVoiceLocalAutoSpeakReplies} />}
                showChevron={false}
            />
        </ItemGroup>
    );
}
