import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/domains/state/storage';
import { normalizeComposerBannerCollapseRecord } from '@/components/sessions/composerBanners/composerBannerCollapse';
import type { BusySteerSendPolicy, MessageSendMode, NonSteerableSendPromptSetting } from '@/sync/domains/session/control/submitMode';
import {
    SESSION_INACTIVE_RESUME_POLICY_VALUES,
    type SessionInactiveResumePolicy,
} from '@/sync/domains/session/control/inactiveResumePolicy';
import { Icon } from '@/components/ui/icons/Icon';

type PendingQueueDrainMode = 'one_at_a_time' | 'drain_all';
type PendingQueueDeliveryTiming = 'after_foreground_ready' | 'after_runtime_idle';

export const SessionComposerSettingsView = React.memo(function SessionComposerSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);
    const [messageSendMode, setMessageSendMode] = useSettingMutable('sessionMessageSendMode');
    const [busySteerSendPolicy, setBusySteerSendPolicy] = useSettingMutable('sessionBusySteerSendPolicy');
    const [nonSteerableSendPrompt, setNonSteerableSendPrompt] = useSettingMutable('sessionNonSteerableSendPrompt');
    const [pendingQueueDrainMode, setPendingQueueDrainMode] = useSettingMutable('sessionPendingQueueDrainMode');
    const [pendingQueueDeliveryTiming, setPendingQueueDeliveryTiming] = useSettingMutable('sessionPendingQueueDeliveryTiming');
    const [sessionInactiveResumePolicy, setSessionInactiveResumePolicy] = useSettingMutable('sessionInactiveResumePolicy');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [agentInputEnterToSendNative, setAgentInputEnterToSendNative] = useSettingMutable('agentInputEnterToSendNative');
    const [agentInputHistoryScope, setAgentInputHistoryScope] = useSettingMutable('agentInputHistoryScope');
    const [agentInputActionBarLayout, setAgentInputActionBarLayout] = useSettingMutable('agentInputActionBarLayout');
    const [agentInputChipDensity, setAgentInputChipDensity] = useSettingMutable('agentInputChipDensity');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [composerSurfaceStyle, setComposerSurfaceStyle] = useSettingMutable('composerSurfaceStyle');
    const [rememberBannerVisibility, setRememberBannerVisibility] = useSettingMutable('sessionComposerRememberBannerVisibility');
    const [newSessionDraftEntryMode, setNewSessionDraftEntryMode] = useSettingMutable('newSessionDraftEntryMode');
    const [collapsedBannerKinds, setCollapsedBannerKinds] = useLocalSettingMutable('sessionComposerCollapsedBannerKinds');
    const [openHistoryScopeMenu, setOpenHistoryScopeMenu] = React.useState(false);
    const [openInactiveResumePolicyMenu, setOpenInactiveResumePolicyMenu] = React.useState(false);

    const hiddenBannerCount = Object.keys(normalizeComposerBannerCollapseRecord(collapsedBannerKinds)).length;

    const enterToSendEnabled = Platform.OS === 'web' ? agentInputEnterToSend : agentInputEnterToSendNative;
    const setEnterToSendEnabled = Platform.OS === 'web' ? setAgentInputEnterToSend : setAgentInputEnterToSendNative;
    const enterToSendSubtitle = enterToSendEnabled
        ? Platform.OS === 'web'
            ? t('settingsFeatures.enterToSendEnabled')
            : t('settingsSession.inputBehavior.enterToSendEnabledNativeSubtitle')
        : t('settingsFeatures.enterToSendDisabled');
    const normalizedHistoryScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const historyScopeOptions = [
        {
            id: 'perSession',
            title: t('settingsFeatures.historyScopePerSessionOption'),
            subtitle: t('settingsFeatures.historyScopePerSession'),
            iconName: 'repeat',
        },
        {
            id: 'global',
            title: t('settingsFeatures.historyScopeGlobalOption'),
            subtitle: t('settingsFeatures.historyScopeGlobal'),
            iconName: 'globe',
        },
    ] as const;
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
    const inactiveResumePolicyOptions = SESSION_INACTIVE_RESUME_POLICY_VALUES.map((policy) => {
        switch (policy) {
            case 'when_available':
                return {
                    id: policy,
                    title: t('settingsSession.messageSending.inactiveResumePolicy.whenAvailableTitle'),
                    subtitle: t('settingsSession.messageSending.inactiveResumePolicy.whenAvailableSubtitle'),
                };
            case 'online_only':
                return {
                    id: policy,
                    title: t('settingsSession.messageSending.inactiveResumePolicy.onlineOnlyTitle'),
                    subtitle: t('settingsSession.messageSending.inactiveResumePolicy.onlineOnlySubtitle'),
                };
            case 'manual':
                return {
                    id: policy,
                    title: t('settingsSession.messageSending.inactiveResumePolicy.manualTitle'),
                    subtitle: t('settingsSession.messageSending.inactiveResumePolicy.manualSubtitle'),
                };
        }
    });
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
    const nonSteerablePromptOptions: Array<{ key: NonSteerableSendPromptSetting; title: string; subtitle: string }> = [
        {
            key: 'ask',
            title: t('settingsSession.messageSending.nonSteerablePrompt.askTitle'),
            subtitle: t('settingsSession.messageSending.nonSteerablePrompt.askSubtitle'),
        },
        {
            key: 'queue_silently',
            title: t('settingsSession.messageSending.nonSteerablePrompt.queueSilentlyTitle'),
            subtitle: t('settingsSession.messageSending.nonSteerablePrompt.queueSilentlySubtitle'),
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
    const pendingQueueDeliveryTimingOptions: Array<{ key: PendingQueueDeliveryTiming; title: string; subtitle: string }> = [
        {
            key: 'after_foreground_ready',
            title: t('settingsSession.messageSending.pendingDeliveryTiming.afterForegroundReadyTitle'),
            subtitle: t('settingsSession.messageSending.pendingDeliveryTiming.afterForegroundReadySubtitle'),
        },
        {
            key: 'after_runtime_idle',
            title: t('settingsSession.messageSending.pendingDeliveryTiming.afterRuntimeIdleTitle'),
            subtitle: t('settingsSession.messageSending.pendingDeliveryTiming.afterRuntimeIdleSubtitle'),
        },
    ];
    const pendingQueueMayBeUsed = messageSendMode === 'server_pending' || busySteerSendPolicy === 'server_pending';

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.newSessionDraftEntry.title')}
                footer={t('settingsSession.newSessionDraftEntry.footer')}
            >
                <Item
                    testID="settings-new-session-draft-entry-resume"
                    title={t('settingsSession.newSessionDraftEntry.resumeTitle')}
                    subtitle={t('settingsSession.newSessionDraftEntry.resumeSubtitle')}
                    icon={<Icon name="clock-counter-clockwise" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={newSessionDraftEntryMode === 'resumePrevious'
                        ? <Icon name="check" size={20} color={theme.colors.accent.blue} />
                        : null}
                    onPress={() => setNewSessionDraftEntryMode('resumePrevious')}
                    showChevron={false}
                />
                <Item
                    testID="settings-new-session-draft-entry-fresh"
                    title={t('settingsSession.newSessionDraftEntry.freshTitle')}
                    subtitle={t('settingsSession.newSessionDraftEntry.freshSubtitle')}
                    icon={<Icon name="plus" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={newSessionDraftEntryMode === 'alwaysFresh'
                        ? <Icon name="check" size={20} color={theme.colors.accent.blue} />
                        : null}
                    onPress={() => setNewSessionDraftEntryMode('alwaysFresh')}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.inputBehavior.title')} footer={t('settingsSession.inputBehavior.footer')}>
                <Item
                    title={t('settingsFeatures.enterToSend')}
                    subtitle={enterToSendSubtitle}
                    icon={<Icon name="arrow-elbow-down-right" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={enterToSendEnabled} onValueChange={setEnterToSendEnabled} />}
                    showChevron={false}
                    onPress={() => setEnterToSendEnabled(!enterToSendEnabled)}
                />
                {Platform.OS === 'web' ? (
                    <DropdownMenu
                        open={openHistoryScopeMenu}
                        onOpenChange={setOpenHistoryScopeMenu}
                        variant="selectable"
                        search={false}
                        selectedId={normalizedHistoryScope as any}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsFeatures.historyScope'),
                            icon: <Icon name="clock" size={29} color={theme.colors.accent.blue} />,
                        }}
                        items={historyScopeOptions.map((opt) => ({
                            id: opt.id,
                            title: opt.title,
                            subtitle: opt.subtitle,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Icon name={opt.iconName as any} size={20} color={theme.colors.text.secondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            setAgentInputHistoryScope(id as any);
                            setOpenHistoryScopeMenu(false);
                        }}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.messageSending.title')} footer={t('settingsSession.messageSending.footer')}>
                {sendOptions.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Icon name="paper-plane-tilt" size={29} color={theme.colors.accent.blue} />}
                        rightElement={messageSendMode === option.key ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setMessageSendMode(option.key)}
                        showChevron={false}
                    />
                ))}
                <DropdownMenu
                    open={openInactiveResumePolicyMenu}
                    onOpenChange={setOpenInactiveResumePolicyMenu}
                    variant="selectable"
                    search={false}
                    selectedId={sessionInactiveResumePolicy}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.messageSending.inactiveResumePolicyTitle'),
                        subtitle: t('settingsSession.messageSending.inactiveResumePolicySubtitle'),
                        icon: <Icon name="arrow-clockwise" size={29} color={theme.colors.accent.blue} />,
                    }}
                    items={inactiveResumePolicyOptions.map((option) => ({
                        ...option,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Icon name="arrow-clockwise" size={20} color={theme.colors.text.secondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setSessionInactiveResumePolicy(id as SessionInactiveResumePolicy);
                        setOpenInactiveResumePolicyMenu(false);
                    }}
                />
            </ItemGroup>

            {messageSendMode === 'agent_queue' || messageSendMode === 'server_pending' ? (
                <ItemGroup title={t('settingsSession.messageSending.busySteerPolicyTitle')} footer={t('settingsSession.messageSending.busySteerPolicyFooter')}>
                    {busySteerOptions.map((option) => (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.subtitle}
                            icon={<Icon name="git-branch" size={29} color={theme.colors.accent.blue} />}
                            rightElement={busySteerSendPolicy === option.key ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
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
                        icon={<Icon name="hand" size={29} color={theme.colors.accent.blue} />}
                        rightElement={nonSteerableSendPrompt === option.key ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setNonSteerableSendPrompt(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {pendingQueueMayBeUsed ? (
                <>
                    <ItemGroup title={t('settingsSession.messageSending.pendingDrainModeTitle')} footer={t('settingsSession.messageSending.pendingDrainModeFooter')}>
                        {pendingQueueDrainModeOptions.map((option) => (
                            <Item
                                key={option.key}
                                title={option.title}
                                subtitle={option.subtitle}
                                icon={<Icon name="stack-simple" size={29} color={theme.colors.accent.blue} />}
                                rightElement={pendingQueueDrainMode === option.key ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                                onPress={() => setPendingQueueDrainMode(option.key)}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                    <ItemGroup title={t('settingsSession.messageSending.pendingDeliveryTimingTitle')} footer={t('settingsSession.messageSending.pendingDeliveryTimingFooter')}>
                        {pendingQueueDeliveryTimingOptions.map((option) => (
                            <Item
                                key={option.key}
                                title={option.title}
                                subtitle={option.subtitle}
                                icon={<Icon name="timer" size={29} color={theme.colors.accent.blue} />}
                                rightElement={pendingQueueDeliveryTiming === option.key ? <Icon name="check" size={20} color={theme.colors.accent.blue} /> : null}
                                onPress={() => setPendingQueueDeliveryTiming(option.key)}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                </>
            ) : null}

            <ItemGroup title={t('settingsSession.input.title')} footer={t('settingsSession.input.footer')}>
                <Item
                    title={t('settingsAppearance.agentInputActionBarLayout')}
                    subtitle={t('settingsAppearance.agentInputActionBarLayoutDescription')}
                    icon={<Icon name="list" size={29} color={theme.colors.accent.indigo} />}
                    detail={agentInputActionBarLayout === 'auto'
                        ? t('settingsAppearance.agentInputActionBarLayoutOptions.auto')
                        : agentInputActionBarLayout === 'wrap'
                            ? t('settingsAppearance.agentInputActionBarLayoutOptions.wrap')
                            : agentInputActionBarLayout === 'scroll'
                                ? t('settingsAppearance.agentInputActionBarLayoutOptions.scroll')
                                : t('settingsAppearance.agentInputActionBarLayoutOptions.collapsed')}
                    onPress={() => {
                        const order: Array<typeof agentInputActionBarLayout> = ['auto', 'wrap', 'scroll', 'collapsed'];
                        const idx = Math.max(0, order.indexOf(agentInputActionBarLayout));
                        setAgentInputActionBarLayout(order[(idx + 1) % order.length]!);
                    }}
                />
                <Item
                    title={t('settingsAppearance.agentInputChipDensity')}
                    subtitle={t('settingsAppearance.agentInputChipDensityDescription')}
                    icon={<Icon name="text-aa" size={29} color={theme.colors.accent.indigo} />}
                    detail={agentInputChipDensity === 'auto'
                        ? t('settingsAppearance.agentInputChipDensityOptions.auto')
                        : agentInputChipDensity === 'labels'
                            ? t('settingsAppearance.agentInputChipDensityOptions.labels')
                            : t('settingsAppearance.agentInputChipDensityOptions.icons')}
                    onPress={() => {
                        const order: Array<typeof agentInputChipDensity> = ['auto', 'labels', 'icons'];
                        const idx = Math.max(0, order.indexOf(agentInputChipDensity));
                        setAgentInputChipDensity(order[(idx + 1) % order.length]!);
                    }}
                />
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Icon name="chart-line" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={alwaysShowContextSize} onValueChange={setAlwaysShowContextSize} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsAppearance.glass.composer')}
                    subtitle={t('settingsAppearance.glass.composerHint')}
                    icon={<Icon name="chat" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-composer-glassSurface-switch"
                            value={composerSurfaceStyle === 'glass'}
                            onValueChange={(next) => setComposerSurfaceStyle(next ? 'glass' : 'standard')}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.banners.title')} footer={t('settingsSession.banners.footer')}>
                <Item
                    title={t('settingsSession.banners.rememberVisibilityTitle')}
                    subtitle={t('settingsSession.banners.rememberVisibilitySubtitle')}
                    icon={<Icon name="eye-slash" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-composer-rememberBannerVisibility-switch"
                            value={rememberBannerVisibility}
                            onValueChange={setRememberBannerVisibility}
                        />
                    }
                    showChevron={false}
                />
                {hiddenBannerCount > 0 ? (
                    <Item
                        testID="settings-composer-resetHiddenBanners"
                        title={t('settingsSession.banners.resetHiddenTitle')}
                        subtitle={t('settingsSession.banners.resetHiddenSubtitle')}
                        icon={<Icon name="eye" size={29} color={theme.colors.accent.indigo} />}
                        detail={String(hiddenBannerCount)}
                        onPress={() => setCollapsedBannerKinds({})}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
        </ItemList>
    );
});

export default SessionComposerSettingsView;
