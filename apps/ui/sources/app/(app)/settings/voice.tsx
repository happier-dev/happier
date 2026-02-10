import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentPickerOptions } from '@/agents/catalog/agentPickerOptions';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { Modal } from '@/modal';
import { createHappierElevenLabsAgent, updateHappierElevenLabsAgent } from '@/realtime/elevenlabs/autoprovision';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { normalizeSecretPromptInput } from '@/utils/secrets/normalizeSecretInput';
import { VOICE_PROVIDER_IDS } from '@/voice/voiceProviders';
import { fetchOpenAiCompatSpeechAudio } from '@/voice/local/fetchOpenAiCompatSpeechAudio';
import { playAudioBytes } from '@/voice/local/playAudioBytes';

import { ByoElevenLabsSection } from './voice/ByoElevenLabsSection';
import { LocalOssVoiceSection, type VoiceSettingsOpenMenu } from './voice/LocalOssVoiceSection';
import { useModelPreflight } from './voice/useModelPreflight';
import { VoiceModeSection } from './voice/VoiceModeSection';
import { VoicePrivacySection } from './voice/VoicePrivacySection';

export default function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceProviderId, setVoiceProviderId] = useSettingMutable('voiceProviderId');
    const [voiceByoElevenLabsAgentId, setVoiceByoElevenLabsAgentId] = useSettingMutable('voiceByoElevenLabsAgentId');
    const [voiceByoElevenLabsApiKey, setVoiceByoElevenLabsApiKey] = useSettingMutable('voiceByoElevenLabsApiKey');
    const [voiceShareSessionSummary, setVoiceShareSessionSummary] = useSettingMutable('voiceShareSessionSummary');
    const [voiceShareRecentMessages, setVoiceShareRecentMessages] = useSettingMutable('voiceShareRecentMessages');
    const [voiceRecentMessagesCount, setVoiceRecentMessagesCount] = useSettingMutable('voiceRecentMessagesCount');
    const [voiceShareToolNames, setVoiceShareToolNames] = useSettingMutable('voiceShareToolNames');
    const [voiceSharePermissionRequests, setVoiceSharePermissionRequests] = useSettingMutable('voiceSharePermissionRequests');
    const [voiceShareFilePaths, setVoiceShareFilePaths] = useSettingMutable('voiceShareFilePaths');
    const [voiceLocalSttBaseUrl, setVoiceLocalSttBaseUrl] = useSettingMutable('voiceLocalSttBaseUrl');
    const [voiceLocalSttApiKey, setVoiceLocalSttApiKey] = useSettingMutable('voiceLocalSttApiKey');
    const [voiceLocalSttModel, setVoiceLocalSttModel] = useSettingMutable('voiceLocalSttModel');
    const [voiceLocalTtsBaseUrl, setVoiceLocalTtsBaseUrl] = useSettingMutable('voiceLocalTtsBaseUrl');
    const [voiceLocalTtsApiKey, setVoiceLocalTtsApiKey] = useSettingMutable('voiceLocalTtsApiKey');
    const [voiceLocalTtsModel, setVoiceLocalTtsModel] = useSettingMutable('voiceLocalTtsModel');
    const [voiceLocalTtsVoice, setVoiceLocalTtsVoice] = useSettingMutable('voiceLocalTtsVoice');
    const [voiceLocalTtsFormat, setVoiceLocalTtsFormat] = useSettingMutable('voiceLocalTtsFormat');
    const [voiceLocalAutoSpeakReplies, setVoiceLocalAutoSpeakReplies] = useSettingMutable('voiceLocalAutoSpeakReplies');
    const [voiceLocalConversationMode, setVoiceLocalConversationMode] = useSettingMutable('voiceLocalConversationMode');
    const [voiceLocalMediatorBackend, setVoiceLocalMediatorBackend] = useSettingMutable('voiceLocalMediatorBackend');
    const [voiceMediatorAgentSource, setVoiceMediatorAgentSource] = useSettingMutable('voiceMediatorAgentSource');
    const [voiceMediatorAgentId, setVoiceMediatorAgentId] = useSettingMutable('voiceMediatorAgentId');
    const [voiceMediatorPermissionPolicy, setVoiceMediatorPermissionPolicy] = useSettingMutable('voiceMediatorPermissionPolicy');
    const [voiceMediatorIdleTtlSeconds, setVoiceMediatorIdleTtlSeconds] = useSettingMutable('voiceMediatorIdleTtlSeconds');
    const [voiceLocalChatBaseUrl, setVoiceLocalChatBaseUrl] = useSettingMutable('voiceLocalChatBaseUrl');
    const [voiceLocalChatApiKey, setVoiceLocalChatApiKey] = useSettingMutable('voiceLocalChatApiKey');
    const [voiceLocalChatChatModel, setVoiceLocalChatChatModel] = useSettingMutable('voiceLocalChatChatModel');
    const [voiceLocalChatCommitModel, setVoiceLocalChatCommitModel] = useSettingMutable('voiceLocalChatCommitModel');
    const [voiceLocalChatTemperature, setVoiceLocalChatTemperature] = useSettingMutable('voiceLocalChatTemperature');
    const [voiceLocalChatMaxTokens, setVoiceLocalChatMaxTokens] = useSettingMutable('voiceLocalChatMaxTokens');
    const [voiceMediatorChatModelSource, setVoiceMediatorChatModelSource] = useSettingMutable('voiceMediatorChatModelSource');
    const [voiceMediatorChatModelId, setVoiceMediatorChatModelId] = useSettingMutable('voiceMediatorChatModelId');
    const [voiceMediatorCommitModelSource, setVoiceMediatorCommitModelSource] = useSettingMutable('voiceMediatorCommitModelSource');
    const [voiceMediatorCommitModelId, setVoiceMediatorCommitModelId] = useSettingMutable('voiceMediatorCommitModelId');
    const [voiceMediatorVerbosity, setVoiceMediatorVerbosity] = useSettingMutable('voiceMediatorVerbosity');
    const [recentMachinePaths] = useSettingMutable('recentMachinePaths');

    const happierVoiceSupported = useHappierVoiceSupport();
    const enabledAgentIds = useEnabledAgentIds();
    const agentPickerOptions = React.useMemo(() => getAgentPickerOptions(enabledAgentIds), [enabledAgentIds]);

    const [openMenu, setOpenMenu] = React.useState<VoiceSettingsOpenMenu>(null);

    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];
    const mediatorAgentSource = voiceMediatorAgentSource === 'agent' ? 'agent' : 'session';

    const hasByoApiKey = Boolean(voiceByoElevenLabsApiKey);
    const hasVoiceLocalChatApiKey = Boolean(voiceLocalChatApiKey);
    const hasVoiceLocalSttApiKey = Boolean(voiceLocalSttApiKey);
    const hasVoiceLocalTtsApiKey = Boolean(voiceLocalTtsApiKey);
    const byoConfigured = Boolean(voiceByoElevenLabsAgentId) && hasByoApiKey;

    const [isAutoprovCreating, setIsAutoprovCreating] = React.useState(false);
    const [isAutoprovUpdating, setIsAutoprovUpdating] = React.useState(false);
    const [isTestingLocalTts, setIsTestingLocalTts] = React.useState(false);

    const { daemonMediatorModelOptions, daemonMediatorSupportsFreeform } = useModelPreflight({
        source: mediatorAgentSource,
        agentId: voiceMediatorAgentId ?? null,
        recentMachinePaths,
    });

    React.useEffect(() => {
        if (happierVoiceSupported === false && voiceProviderId === VOICE_PROVIDER_IDS.HAPPIER_ELEVENLABS_AGENTS) {
            setVoiceProviderId(VOICE_PROVIDER_IDS.OFF);
        }
    }, [happierVoiceSupported, setVoiceProviderId, voiceProviderId]);

    const setByoApiKey = async () => {
        const valueRaw = await Modal.prompt(
            t('settingsVoice.byo.apiKeyTitle'),
            t('settingsVoice.byo.apiKeyDescription'),
            { inputType: 'secure-text', placeholder: t('settingsVoice.byo.apiKeyPlaceholder') },
        );
        if (valueRaw === null) return;
        const value = normalizeSecretPromptInput(valueRaw);
        if (!value) return;
        const enc = sync.encryptSecretValue(value);
        if (!enc) {
            Modal.alert(t('common.error'), t('settingsVoice.byo.apiKeySaveFailed'));
            return;
        }
        setVoiceByoElevenLabsApiKey(enc as any);
    };

    const setByoAgentId = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.byo.agentIdTitle'),
            t('settingsVoice.byo.agentIdDescription'),
            { placeholder: t('settingsVoice.byo.agentIdPlaceholder') },
        );
        if (!value) return;
        setVoiceByoElevenLabsAgentId(value.trim() || null);
    };

    const disconnectByo = async () => {
        const ok = await Modal.confirm(
            t('settingsVoice.byo.disconnectTitle'),
            t('settingsVoice.byo.disconnectDescription'),
            { destructive: true, confirmText: t('settingsVoice.byo.disconnectConfirm') },
        );
        if (!ok) return;
        setVoiceByoElevenLabsAgentId(null);
        setVoiceByoElevenLabsApiKey(null as any);
        setVoiceProviderId(VOICE_PROVIDER_IDS.OFF);
    };

    const setLocalUrl = async (kind: 'stt' | 'tts') => {
        const current = kind === 'stt' ? (voiceLocalSttBaseUrl ?? '') : (voiceLocalTtsBaseUrl ?? '');
        const value = await Modal.prompt(
            kind === 'stt' ? t('settingsVoice.local.sttBaseUrlTitle') : t('settingsVoice.local.ttsBaseUrlTitle'),
            kind === 'stt' ? t('settingsVoice.local.sttBaseUrlDescription') : t('settingsVoice.local.ttsBaseUrlDescription'),
            { placeholder: t('settingsVoice.local.baseUrlPlaceholder'), defaultValue: current },
        );
        if (value === null) return;
        const normalized = value.trim() || null;
        if (kind === 'stt') setVoiceLocalSttBaseUrl(normalized);
        else setVoiceLocalTtsBaseUrl(normalized);
    };

    const setLocalApiKey = async (kind: 'stt' | 'tts') => {
        const valueRaw = await Modal.prompt(
            kind === 'stt' ? t('settingsVoice.local.sttApiKeyTitle') : t('settingsVoice.local.ttsApiKeyTitle'),
            kind === 'stt' ? t('settingsVoice.local.sttApiKeyDescription') : t('settingsVoice.local.ttsApiKeyDescription'),
            { inputType: 'secure-text', placeholder: t('settingsVoice.local.apiKeyPlaceholder') },
        );
        if (valueRaw === null) return;
        const value = normalizeSecretPromptInput(valueRaw);
        if (!value) {
            if (kind === 'stt') setVoiceLocalSttApiKey(null as any);
            else setVoiceLocalTtsApiKey(null as any);
            return;
        }
        const enc = sync.encryptSecretValue(value);
        if (!enc) {
            Modal.alert(t('common.error'), t('settingsVoice.local.apiKeySaveFailed'));
            return;
        }
        if (kind === 'stt') setVoiceLocalSttApiKey(enc as any);
        else setVoiceLocalTtsApiKey(enc as any);
    };

    const setLocalText = async (kind: 'sttModel' | 'ttsModel' | 'ttsVoice') => {
        const current =
            kind === 'sttModel' ? (voiceLocalSttModel ?? '') :
                kind === 'ttsModel' ? (voiceLocalTtsModel ?? '') :
                    (voiceLocalTtsVoice ?? '');
        const title =
            kind === 'sttModel' ? t('settingsVoice.local.sttModelTitle') :
                kind === 'ttsModel' ? t('settingsVoice.local.ttsModelTitle') :
                    t('settingsVoice.local.ttsVoiceTitle');
        const desc =
            kind === 'sttModel' ? t('settingsVoice.local.sttModelDescription') :
                kind === 'ttsModel' ? t('settingsVoice.local.ttsModelDescription') :
                    t('settingsVoice.local.ttsVoiceDescription');
        const value = await Modal.prompt(title, desc, { placeholder: current, defaultValue: current });
        if (value === null) return;
        const normalized = value.trim();
        if (kind === 'sttModel') setVoiceLocalSttModel(normalized || 'whisper-1');
        if (kind === 'ttsModel') setVoiceLocalTtsModel(normalized || 'tts-1');
        if (kind === 'ttsVoice') setVoiceLocalTtsVoice(normalized || 'alloy');
    };

    const setLocalChatUrl = async () => {
        const current = voiceLocalChatBaseUrl ?? '';
        const value = await Modal.prompt(
            t('settingsVoice.local.chatBaseUrlTitle'),
            t('settingsVoice.local.chatBaseUrlDescription'),
            { placeholder: t('settingsVoice.local.baseUrlPlaceholder'), defaultValue: current },
        );
        if (value === null) return;
        const normalized = value.trim() || null;
        setVoiceLocalChatBaseUrl(normalized as any);
    };

    const setLocalChatApiKey = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.local.chatApiKeyTitle'),
            t('settingsVoice.local.chatApiKeyDescription'),
            { inputType: 'secure-text', placeholder: t('settingsVoice.local.apiKeyPlaceholder') },
        );
        if (value === null) return;
        const trimmed = value.trim();
        if (!trimmed) {
            setVoiceLocalChatApiKey(null as any);
            return;
        }
        const enc = sync.encryptSecretValue(trimmed);
        if (!enc) {
            Modal.alert(t('common.error'), t('settingsVoice.local.apiKeySaveFailed'));
            return;
        }
        setVoiceLocalChatApiKey(enc as any);
    };

    const setLocalChatText = async (kind: 'chatModel' | 'commitModel') => {
        const current = kind === 'chatModel' ? (voiceLocalChatChatModel ?? 'default') : (voiceLocalChatCommitModel ?? 'default');
        const value = await Modal.prompt(
            kind === 'chatModel' ? t('settingsVoice.local.chatModelTitle') : t('settingsVoice.local.commitModelTitle'),
            kind === 'chatModel' ? t('settingsVoice.local.chatModelDescription') : t('settingsVoice.local.commitModelDescription'),
            { placeholder: 'default', defaultValue: String(current) },
        );
        if (value === null) return;
        const trimmed = value.trim() || 'default';
        if (kind === 'chatModel') setVoiceLocalChatChatModel(trimmed as any);
        else setVoiceLocalChatCommitModel(trimmed as any);
    };

    const setDaemonMediatorModelText = async (kind: 'chatModel' | 'commitModel') => {
        const current = kind === 'chatModel' ? (voiceMediatorChatModelId ?? 'default') : (voiceMediatorCommitModelId ?? 'default');
        const value = await Modal.prompt(
            kind === 'chatModel' ? t('settingsVoice.local.chatModelTitle') : t('settingsVoice.local.commitModelTitle'),
            kind === 'chatModel' ? t('settingsVoice.local.chatModelDescription') : t('settingsVoice.local.commitModelDescription'),
            { placeholder: 'default', defaultValue: String(current) },
        );
        if (value === null) return;
        const trimmed = value.trim() || 'default';
        if (kind === 'chatModel') setVoiceMediatorChatModelId(trimmed as any);
        else setVoiceMediatorCommitModelId(trimmed as any);
    };

    const setChatTemperature = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.local.chatTemperatureTitle'),
            t('settingsVoice.local.chatTemperatureDescription'),
            { inputType: 'numeric', placeholder: '0.4', defaultValue: String(voiceLocalChatTemperature ?? 0.4) },
        );
        if (value === null) return;
        const n = Number(String(value).trim());
        if (!Number.isFinite(n) || n < 0 || n > 2) {
            Modal.alert(t('common.error'), t('settingsVoice.local.chatTemperatureInvalid'));
            return;
        }
        setVoiceLocalChatTemperature(n as any);
    };

    const setChatMaxTokens = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.local.chatMaxTokensTitle'),
            t('settingsVoice.local.chatMaxTokensDescription'),
            {
                inputType: 'numeric',
                placeholder: t('settingsVoice.local.chatMaxTokensPlaceholder'),
                defaultValue: voiceLocalChatMaxTokens == null ? '' : String(voiceLocalChatMaxTokens),
            },
        );
        if (value === null) return;
        const trimmed = String(value).trim();
        if (!trimmed) {
            setVoiceLocalChatMaxTokens(null as any);
            return;
        }
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n <= 0) {
            Modal.alert(t('common.error'), t('settingsVoice.local.chatMaxTokensInvalid'));
            return;
        }
        setVoiceLocalChatMaxTokens(Math.floor(n) as any);
    };

    const setMediatorIdleTtl = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.local.mediatorIdleTtlTitle'),
            t('settingsVoice.local.mediatorIdleTtlDescription'),
            { inputType: 'numeric', placeholder: '300', defaultValue: String(voiceMediatorIdleTtlSeconds ?? 300) },
        );
        if (value === null) return;
        const n = Number(String(value).trim());
        if (!Number.isFinite(n) || n < 60 || n > 3600) {
            Modal.alert(t('common.error'), t('settingsVoice.local.mediatorIdleTtlInvalid'));
            return;
        }
        setVoiceMediatorIdleTtlSeconds(Math.floor(n) as any);
    };

    const createByoAgent = async () => {
        const apiKey = sync.decryptSecretValue(voiceByoElevenLabsApiKey) ?? '';
        if (!apiKey) {
            Modal.alert(t('common.error'), t('settingsVoice.byo.apiKeyNotSet'));
            return;
        }
        setIsAutoprovCreating(true);
        try {
            const created = await createHappierElevenLabsAgent({ apiKey });
            setVoiceByoElevenLabsAgentId(created.agentId);
            Modal.alert(t('common.success'), t('settingsVoice.byo.autoprovCreated', { agentId: created.agentId }));
        } catch {
            Modal.alert(t('common.error'), t('settingsVoice.byo.autoprovFailed'));
        } finally {
            setIsAutoprovCreating(false);
        }
    };

    const updateByoAgent = async () => {
        const apiKey = sync.decryptSecretValue(voiceByoElevenLabsApiKey) ?? '';
        const agentId = voiceByoElevenLabsAgentId?.trim() ?? '';
        if (!apiKey || !agentId) {
            Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
            return;
        }
        setIsAutoprovUpdating(true);
        try {
            await updateHappierElevenLabsAgent({ apiKey, agentId });
            Modal.alert(t('common.success'), t('settingsVoice.byo.autoprovUpdated'));
        } catch {
            Modal.alert(t('common.error'), t('settingsVoice.byo.autoprovFailed'));
        } finally {
            setIsAutoprovUpdating(false);
        }
    };

    const setRecentMessagesCount = async () => {
        const value = await Modal.prompt(
            t('settingsVoice.privacy.recentMessagesCountTitle'),
            t('settingsVoice.privacy.recentMessagesCountDescription'),
            { inputType: 'numeric', placeholder: String(voiceRecentMessagesCount ?? 10) },
        );
        if (!value) return;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
            Modal.alert(t('common.error'), t('settingsVoice.privacy.recentMessagesCountInvalid'));
            return;
        }
        setVoiceRecentMessagesCount(Math.floor(parsed));
    };

    const testLocalTts = async () => {
        if (isTestingLocalTts) return;

        const baseUrl = (voiceLocalTtsBaseUrl ?? '').trim();
        if (!baseUrl) {
            Modal.alert(t('common.error'), t('settingsVoice.local.testTtsMissingBaseUrl'));
            return;
        }

        const apiKey = (sync.decryptSecretValue(voiceLocalTtsApiKey) ?? '').trim();
        const model = String(voiceLocalTtsModel ?? 'tts-1');
        const voice = String(voiceLocalTtsVoice ?? 'alloy');
        const format = (voiceLocalTtsFormat ?? 'mp3') === 'wav' ? 'wav' : 'mp3';

        setIsTestingLocalTts(true);
        try {
            const bytes = await fetchOpenAiCompatSpeechAudio({
                baseUrl,
                apiKey: apiKey ? apiKey : null,
                model,
                voice,
                format,
                input: t('settingsVoice.local.testTtsSample'),
            });

            // Web-only for now (native playback support can be added once we choose a single audio runtime).
            await playAudioBytes({ bytes, format });
        } catch {
            Modal.alert(t('common.error'), t('settingsVoice.local.testTtsFailed'));
        } finally {
            setIsTestingLocalTts(false);
        }
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <VoiceModeSection
                voiceProviderId={voiceProviderId}
                happierVoiceSupported={happierVoiceSupported}
                onSelectVoiceProviderId={(providerId) => setVoiceProviderId(providerId as any)}
            />

            <ByoElevenLabsSection
                voiceProviderId={voiceProviderId}
                byoConfigured={byoConfigured}
                isAutoprovCreating={isAutoprovCreating}
                isAutoprovUpdating={isAutoprovUpdating}
                voiceByoElevenLabsAgentId={voiceByoElevenLabsAgentId}
                hasByoApiKey={hasByoApiKey}
                onAutoprovCreate={() => {
                    void createByoAgent();
                }}
                onAutoprovUpdate={() => {
                    void updateByoAgent();
                }}
                onSetAgentId={() => {
                    void setByoAgentId();
                }}
                onSetApiKey={() => {
                    void setByoApiKey();
                }}
                onDisconnect={() => {
                    void disconnectByo();
                }}
            />

            <LocalOssVoiceSection
                voiceProviderId={voiceProviderId}
                themeTextSecondary={theme.colors.textSecondary}
                openMenu={openMenu}
                onOpenMenuChange={setOpenMenu}
                agentPickerOptions={agentPickerOptions}
                daemonMediatorModelOptions={daemonMediatorModelOptions}
                daemonMediatorSupportsFreeform={daemonMediatorSupportsFreeform}
                voiceLocalConversationMode={voiceLocalConversationMode}
                voiceLocalMediatorBackend={voiceLocalMediatorBackend}
                voiceMediatorAgentSource={voiceMediatorAgentSource}
                voiceMediatorAgentId={voiceMediatorAgentId}
                voiceMediatorPermissionPolicy={voiceMediatorPermissionPolicy}
                voiceMediatorVerbosity={voiceMediatorVerbosity}
                voiceMediatorIdleTtlSeconds={voiceMediatorIdleTtlSeconds}
                voiceMediatorChatModelSource={voiceMediatorChatModelSource}
                voiceMediatorChatModelId={voiceMediatorChatModelId}
                voiceMediatorCommitModelSource={voiceMediatorCommitModelSource}
                voiceMediatorCommitModelId={voiceMediatorCommitModelId}
                voiceLocalChatBaseUrl={voiceLocalChatBaseUrl}
                hasVoiceLocalChatApiKey={hasVoiceLocalChatApiKey}
                voiceLocalChatChatModel={voiceLocalChatChatModel}
                voiceLocalChatCommitModel={voiceLocalChatCommitModel}
                voiceLocalChatTemperature={voiceLocalChatTemperature}
                voiceLocalChatMaxTokens={voiceLocalChatMaxTokens}
                voiceLocalSttBaseUrl={voiceLocalSttBaseUrl}
                hasVoiceLocalSttApiKey={hasVoiceLocalSttApiKey}
                voiceLocalSttModel={voiceLocalSttModel}
                voiceLocalTtsBaseUrl={voiceLocalTtsBaseUrl}
                hasVoiceLocalTtsApiKey={hasVoiceLocalTtsApiKey}
                voiceLocalTtsModel={voiceLocalTtsModel}
                voiceLocalTtsVoice={voiceLocalTtsVoice}
                voiceLocalTtsFormat={voiceLocalTtsFormat}
                voiceLocalAutoSpeakReplies={!!voiceLocalAutoSpeakReplies}
                isTestingLocalTts={isTestingLocalTts}
                onSetVoiceLocalConversationMode={(mode) => setVoiceLocalConversationMode(mode as any)}
                onToggleVoiceLocalMediatorBackend={() => {
                    setVoiceLocalMediatorBackend((voiceLocalMediatorBackend ?? 'daemon') === 'daemon' ? ('openai_compat' as any) : ('daemon' as any));
                }}
                onToggleVoiceMediatorAgentSource={() => {
                    const next = mediatorAgentSource === 'session' ? 'agent' : 'session';
                    setVoiceMediatorAgentSource(next as any);
                    if (next === 'agent' && !voiceMediatorAgentId) {
                        setVoiceMediatorAgentId('claude' as any);
                    }
                }}
                onSetVoiceMediatorAgentId={(agentId) => setVoiceMediatorAgentId(agentId as any)}
                onToggleVoiceMediatorPermissionPolicy={() => {
                    setVoiceMediatorPermissionPolicy((voiceMediatorPermissionPolicy ?? 'read_only') === 'read_only' ? ('no_tools' as any) : ('read_only' as any));
                }}
                onToggleVoiceMediatorVerbosity={() => {
                    setVoiceMediatorVerbosity((voiceMediatorVerbosity ?? 'short') === 'short' ? ('balanced' as any) : ('short' as any));
                }}
                onSetMediatorIdleTtl={() => {
                    void setMediatorIdleTtl();
                }}
                onToggleVoiceMediatorChatModelSource={() => {
                    setVoiceMediatorChatModelSource(
                        (voiceMediatorChatModelSource ?? 'custom') === 'session'
                            ? ('custom' as any)
                            : ('session' as any),
                    );
                }}
                onSetVoiceMediatorChatModelId={(modelId) => setVoiceMediatorChatModelId(modelId as any)}
                onSetDaemonMediatorModelText={(kind) => {
                    void setDaemonMediatorModelText(kind);
                }}
                onCycleVoiceMediatorCommitModelSource={() => {
                    const current = voiceMediatorCommitModelSource ?? 'chat';
                    const next = current === 'chat' ? 'session' : current === 'session' ? 'custom' : 'chat';
                    setVoiceMediatorCommitModelSource(next as any);
                }}
                onSetVoiceMediatorCommitModelId={(modelId) => setVoiceMediatorCommitModelId(modelId as any)}
                onSetLocalChatUrl={() => {
                    void setLocalChatUrl();
                }}
                onSetLocalChatApiKey={() => {
                    void setLocalChatApiKey();
                }}
                onSetLocalChatText={(kind) => {
                    void setLocalChatText(kind);
                }}
                onSetChatTemperature={() => {
                    void setChatTemperature();
                }}
                onSetChatMaxTokens={() => {
                    void setChatMaxTokens();
                }}
                onSetLocalUrl={(kind) => {
                    void setLocalUrl(kind);
                }}
                onSetLocalApiKey={(kind) => {
                    void setLocalApiKey(kind);
                }}
                onSetLocalText={(kind) => {
                    void setLocalText(kind);
                }}
                onToggleVoiceLocalTtsFormat={() => {
                    setVoiceLocalTtsFormat((voiceLocalTtsFormat ?? 'mp3') === 'mp3' ? 'wav' : 'mp3');
                }}
                onSetVoiceLocalAutoSpeakReplies={(value) => setVoiceLocalAutoSpeakReplies(value as any)}
                onTestLocalTts={() => {
                    void testLocalTts();
                }}
            />

            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            <VoicePrivacySection
                voiceShareSessionSummary={!!voiceShareSessionSummary}
                voiceShareRecentMessages={!!voiceShareRecentMessages}
                voiceRecentMessagesCount={voiceRecentMessagesCount}
                voiceShareToolNames={!!voiceShareToolNames}
                voiceSharePermissionRequests={!!voiceSharePermissionRequests}
                voiceShareFilePaths={!!voiceShareFilePaths}
                onSetVoiceShareSessionSummary={(value) => setVoiceShareSessionSummary(value as any)}
                onSetVoiceShareRecentMessages={(value) => setVoiceShareRecentMessages(value as any)}
                onSetRecentMessagesCount={() => {
                    void setRecentMessagesCount();
                }}
                onSetVoiceShareToolNames={(value) => setVoiceShareToolNames(value as any)}
                onSetVoiceSharePermissionRequests={(value) => setVoiceSharePermissionRequests(value as any)}
                onSetVoiceShareFilePaths={(value) => setVoiceShareFilePaths(value as any)}
            />
        </ItemList>
    );
}
