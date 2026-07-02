import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { BusySteerSendPolicy, MessageSendMode } from '@/sync/domains/session/control/submitMode';

type PendingQueueDrainMode = 'one_at_a_time' | 'drain_all';

export const SessionComposerSettingsView = React.memo(function SessionComposerSettingsView() {
    const { theme } = useUnistyles();
    const [messageSendMode, setMessageSendMode] = useSettingMutable('sessionMessageSendMode');
    const [busySteerSendPolicy, setBusySteerSendPolicy] = useSettingMutable('sessionBusySteerSendPolicy');
    const [nonSteerableSendPrompt, setNonSteerableSendPrompt] = useSettingMutable('sessionNonSteerableSendPrompt');
    const [pendingQueueDrainMode, setPendingQueueDrainMode] = useSettingMutable('sessionPendingQueueDrainMode');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [agentInputEnterToSendNative, setAgentInputEnterToSendNative] = useSettingMutable('agentInputEnterToSendNative');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const enterToSendEnabled = Platform.OS === 'web' ? agentInputEnterToSend : agentInputEnterToSendNative;
    const setEnterToSendEnabled = Platform.OS === 'web' ? setAgentInputEnterToSend : setAgentInputEnterToSendNative;
    const sendOptions: Array<{ key: MessageSendMode; title: string; subtitle: string }> = [
        {
            key: 'agent_queue',
            title: t('settingsSession.messageSending.queueInAgentTitle'),
            subtitle: t('settingsSession.messageSending.queueInAgentSubtitle'),
        },
        {
            key: 'interrupt',
            title: t('settingsSession.messageSending.interruptTitle'),
            subtitle: t('settingsSession.messageSending.interruptSubtitle'),
        },
        {
            key: 'server_pending',
            title: t('settingsSession.messageSending.pendingTitle'),
            subtitle: t('settingsSession.messageSending.pendingSubtitle'),
        },
    ];
    const busySteerOptions: Array<{ key: BusySteerSendPolicy; title: string; subtitle: string }> = [
        {
            key: 'steer_immediately',
            title: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelyTitle'),
            subtitle: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelySubtitle'),
        },
        {
            key: 'server_pending',
            title: t('settingsSession.messageSending.busySteerPolicy.queueForReviewTitle'),
            subtitle: t('settingsSession.messageSending.busySteerPolicy.queueForReviewSubtitle'),
        },
    ];
    const nonSteerablePromptOptions: Array<{ key: 'on' | 'off'; title: string; subtitle: string }> = [
        {
            key: 'on',
            title: t('settingsSession.messageSending.nonSteerablePrompt.onTitle'),
            subtitle: t('settingsSession.messageSending.nonSteerablePrompt.onSubtitle'),
        },
        {
            key: 'off',
            title: t('settingsSession.messageSending.nonSteerablePrompt.offTitle'),
            subtitle: t('settingsSession.messageSending.nonSteerablePrompt.offSubtitle'),
        },
    ];
    const pendingQueueDrainModeOptions: Array<{ key: PendingQueueDrainMode; title: string; subtitle: string }> = [
        {
            key: 'one_at_a_time',
            title: t('settingsSession.messageSending.pendingDrainMode.oneAtATimeTitle'),
            subtitle: t('settingsSession.messageSending.pendingDrainMode.oneAtATimeSubtitle'),
        },
        {
            key: 'drain_all',
            title: t('settingsSession.messageSending.pendingDrainMode.drainAllTitle'),
            subtitle: t('settingsSession.messageSending.pendingDrainMode.drainAllSubtitle'),
        },
    ];
    const pendingQueueMayBeUsed = messageSendMode === 'server_pending' || busySteerSendPolicy === 'server_pending';

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.inputBehavior.title')} footer={t('settingsSession.inputBehavior.footer')}>
                <Item
                    title={t('settingsFeatures.enterToSend')}
                    subtitle={enterToSendEnabled
                        ? Platform.OS === 'web'
                            ? t('settingsFeatures.enterToSendEnabled')
                            : t('settingsSession.inputBehavior.enterToSendEnabledNativeSubtitle')
                        : t('settingsFeatures.enterToSendDisabled')}
                    icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={enterToSendEnabled} onValueChange={setEnterToSendEnabled} />}
                    showChevron={false}
                    onPress={() => setEnterToSendEnabled(!enterToSendEnabled)}
                />
            </ItemGroup>
            <ItemGroup title={t('settingsSession.messageSending.title')} footer={t('settingsSession.messageSending.footer')}>
                {sendOptions.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="send-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={messageSendMode === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setMessageSendMode(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
            {messageSendMode === 'agent_queue' || messageSendMode === 'server_pending' ? (
                <ItemGroup title={t('settingsSession.messageSending.busySteerPolicyTitle')} footer={t('settingsSession.messageSending.busySteerPolicyFooter')}>
                    {busySteerOptions.map((option) => (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.subtitle}
                            icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.blue} />}
                            rightElement={busySteerSendPolicy === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => setBusySteerSendPolicy(option.key)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            <ItemGroup title={t('settingsSession.messageSending.nonSteerablePromptTitle')} footer={t('settingsSession.messageSending.nonSteerablePromptFooter')}>
                {nonSteerablePromptOptions.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={nonSteerableSendPrompt === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setNonSteerableSendPrompt(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
            {pendingQueueMayBeUsed ? (
                <ItemGroup title={t('settingsSession.messageSending.pendingDrainModeTitle')} footer={t('settingsSession.messageSending.pendingDrainModeFooter')}>
                    {pendingQueueDrainModeOptions.map((option) => (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.subtitle}
                            icon={<Ionicons name="layers-outline" size={29} color={theme.colors.accent.blue} />}
                            rightElement={pendingQueueDrainMode === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => setPendingQueueDrainMode(option.key)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            <ItemGroup title={t('settingsSession.input.title')} footer={t('settingsSession.input.footer')}>
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={alwaysShowContextSize} onValueChange={setAlwaysShowContextSize} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default SessionComposerSettingsView;
