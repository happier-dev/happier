import * as React from 'react';
import { Platform } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t, type TranslationKeyNoParams } from '@/text';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/domains/state/storage';
import { normalizeComposerBannerCollapseRecord } from '@/components/sessions/composerBanners/composerBannerCollapse';
import type { BusySteerSendPolicy, MessageSendMode } from '@/sync/domains/session/control/submitMode';
import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import {
    SESSION_INACTIVE_RESUME_POLICY_VALUES,
    type SessionInactiveResumePolicy,
} from '@happier-dev/protocol';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { SESSION_COMPOSER_SETTINGS } from '@/components/settings/session/sessionComposerSettings';
import { ComposerActionBarPreview, ComposerChipDensityPreview } from '@/components/settings/session/SessionSettingPreviews';

type PendingQueueDrainMode = 'one_at_a_time' | 'drain_all';
type PendingQueueDeliveryTiming = 'after_foreground_ready' | 'after_runtime_idle';
type AgentInputHistoryScope = 'perSession' | 'global';
type ActionBarLayout = 'auto' | 'wrap' | 'scroll' | 'collapsed';
type ChipDensity = 'auto' | 'labels' | 'icons';

const ACTION_BAR_LAYOUTS = ['auto', 'wrap', 'scroll', 'collapsed'] as const satisfies readonly ActionBarLayout[];
const CHIP_DENSITIES = ['auto', 'labels', 'icons'] as const satisfies readonly ChipDensity[];
const ACTION_BAR_DESCRIPTION_KEYS: Record<ActionBarLayout, TranslationKeyNoParams> = {
    auto: 'settingsSessionPages.composer.actionBarAutoDescription',
    wrap: 'settingsSessionPages.composer.actionBarWrapDescription',
    scroll: 'settingsSessionPages.composer.actionBarScrollDescription',
    collapsed: 'settingsSessionPages.composer.actionBarCollapsedDescription',
};
const CHIP_DENSITY_DESCRIPTION_KEYS: Record<ChipDensity, TranslationKeyNoParams> = {
    auto: 'settingsSessionPages.composer.chipsAutoDescription',
    labels: 'settingsSessionPages.composer.chipsLabelsDescription',
    icons: 'settingsSessionPages.composer.chipsIconsDescription',
};

export const SessionComposerSettingsView = React.memo(function SessionComposerSettingsView() {
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
    const [newSessionPresentationMode, setNewSessionPresentationMode] = useSettingMutable('newSessionPresentationModeV1');
    const [newSessionDraftEntryMode, setNewSessionDraftEntryMode] = useSettingMutable('newSessionDraftEntryMode');
    const [composerSurfaceStyle, setComposerSurfaceStyle] = useSettingMutable('composerSurfaceStyle');
    const [composerPromptLibraryButtonEnabled, setComposerPromptLibraryButtonEnabled] = useSettingMutable('composerPromptLibraryButtonEnabled');
    const [rememberBannerVisibility, setRememberBannerVisibility] = useSettingMutable('sessionComposerRememberBannerVisibility');
    const [collapsedBannerKinds, setCollapsedBannerKinds] = useLocalSettingMutable('sessionComposerCollapsedBannerKinds');
    const hiddenBannerCount = Object.keys(normalizeComposerBannerCollapseRecord(collapsedBannerKinds)).length;
    const enterToSendEnabled = Platform.OS === 'web' ? agentInputEnterToSend : agentInputEnterToSendNative;
    const setEnterToSendEnabled = Platform.OS === 'web' ? setAgentInputEnterToSend : setAgentInputEnterToSendNative;
    const enterToSendSubtitle = enterToSendEnabled
        ? Platform.OS === 'web'
            ? t('settingsFeatures.enterToSendEnabled')
            : t('settingsSession.inputBehavior.enterToSendEnabledNativeSubtitle')
        : t('settingsFeatures.enterToSendDisabled');

    const normalizedHistoryScope: AgentInputHistoryScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const normalizedNewSessionPresentationMode: NewSessionPresentationModeV1 =
        newSessionPresentationMode === 'screen' || newSessionPresentationMode === 'modal'
            ? newSessionPresentationMode
            : 'auto';
    const normalizedSendMode: MessageSendMode =
        messageSendMode === 'interrupt' || messageSendMode === 'server_pending' ? messageSendMode : 'agent_queue';
    const inactiveResumePolicyOptions = SESSION_INACTIVE_RESUME_POLICY_VALUES.map((policy) => {
        switch (policy) {
            case 'when_available':
                return {
                    id: policy,
                    label: t('settingsSessionPages.composer.resumeWhenPossible'),
                    description: t('settingsSession.messageSending.inactiveResumePolicy.whenAvailableSubtitle'),
                };
            case 'online_only':
                return {
                    id: policy,
                    label: t('settingsSessionPages.composer.resumeIfOnline'),
                    description: t('settingsSession.messageSending.inactiveResumePolicy.onlineOnlySubtitle'),
                };
            case 'manual':
                return {
                    id: policy,
                    label: t('settingsSessionPages.composer.resumeNever'),
                    description: t('settingsSession.messageSending.inactiveResumePolicy.manualSubtitle'),
                };
        }
    });
    // Steering choices only apply while a send waits for the agent; the pending queue only when something goes to Pending.
    const busySteerApplies = normalizedSendMode === 'agent_queue' || normalizedSendMode === 'server_pending';
    const pendingQueueMayBeUsed = normalizedSendMode === 'server_pending' || busySteerSendPolicy === 'server_pending';
    const settings = SESSION_COMPOSER_SETTINGS.settings;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.composer.pageDescription')} />
            <ItemGroup
                title={t('settingsSessionPages.composer.newSessionsSection')}
                description={t('settingsSessionPages.composer.newSessionsDescription')}
            >
                <SettingAnchor setting={settings.draftEntry}>
                    <SegmentedChoiceItem<'resumePrevious' | 'alwaysFresh'>
                        subtitleLines={0}
                        testID="settings-new-session-draft-entry"
                        testIDPrefix="settings-new-session-draft-entry"
                        title={t(settings.draftEntry.titleKey)}
                        options={[
                            { id: 'resumePrevious', label: t('settingsSessionPages.composer.draftResume'), description: t('settingsSession.newSessionDraftEntry.resumeSubtitle') },
                            { id: 'alwaysFresh', label: t('settingsSessionPages.composer.draftFresh'), description: t('settingsSession.newSessionDraftEntry.freshSubtitle') },
                        ]}
                        value={newSessionDraftEntryMode === 'alwaysFresh' ? 'alwaysFresh' : 'resumePrevious'}
                        onChange={setNewSessionDraftEntryMode}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.presentation}>
                    <SegmentedChoiceItem<NewSessionPresentationModeV1>
                        subtitleLines={0}
                        testID="settings-new-session-presentation"
                        testIDPrefix="settings-new-session-presentation"
                        title={t(settings.presentation.titleKey)}
                        options={[
                            { id: 'auto', label: t('settingsSession.sessionCreation.presentationAutoTitle'), description: t('settingsSession.sessionCreation.presentationAutoSubtitle') },
                            { id: 'screen', label: t('settingsSession.sessionCreation.presentationScreenTitle'), description: t('settingsSession.sessionCreation.presentationScreenSubtitle') },
                            { id: 'modal', label: t('settingsSession.sessionCreation.presentationModalTitle'), description: t('settingsSession.sessionCreation.presentationModalSubtitle') },
                        ]}
                        value={normalizedNewSessionPresentationMode}
                        onChange={setNewSessionPresentationMode}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSessionPages.composer.typingSection')}
                description={t('settingsSessionPages.composer.typingDescription')}
            >
                <SettingRow
                    setting={settings.enterToSend}
                    testID="settings-composer-enter-to-send"
                    subtitle={enterToSendSubtitle}
                    rightElement={<Switch value={enterToSendEnabled} onValueChange={setEnterToSendEnabled} />}
                    showChevron={false}
                    onPress={() => setEnterToSendEnabled(!enterToSendEnabled)}
                />
                {settingRendersOnHost(settings.historyScope) ? (
                    <SettingAnchor setting={settings.historyScope}>
                        <SegmentedChoiceItem<AgentInputHistoryScope>
                            subtitleLines={0}
                            testID="settings-composer-history-scope"
                            testIDPrefix="settings-composer-history-scope"
                            title={t(settings.historyScope.titleKey)}
                            options={[
                                { id: 'perSession', label: t('settingsFeatures.historyScopePerSessionOption'), description: t('settingsFeatures.historyScopePerSession') },
                                { id: 'global', label: t('settingsFeatures.historyScopeGlobalOption'), description: t('settingsFeatures.historyScopeGlobal') },
                            ]}
                            value={normalizedHistoryScope}
                            onChange={setAgentInputHistoryScope}
                        />
                    </SettingAnchor>
                ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.messageSending.title')} description={t('settingsSession.messageSending.footer')}>
                <SettingAnchor setting={settings.sendMode}>
                    <SegmentedChoiceItem<MessageSendMode>
                        subtitleLines={0}
                        testID="settings-composer-send-mode"
                        testIDPrefix="settings-composer-send-mode"
                        title={t(settings.sendMode.titleKey)}
                        options={[
                            { id: 'agent_queue', label: t('settingsSessionPages.composer.sendQueue'), description: t('settingsSession.messageSending.queueInAgentSubtitle') },
                            { id: 'interrupt', label: t('settingsSessionPages.composer.sendInterrupt'), description: t('settingsSession.messageSending.interruptSubtitle') },
                            { id: 'server_pending', label: t('settingsSessionPages.composer.sendPending'), description: t('settingsSession.messageSending.pendingSubtitle') },
                        ]}
                        value={normalizedSendMode}
                        onChange={setMessageSendMode}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.busySteer}>
                    <SegmentedChoiceItem<BusySteerSendPolicy>
                        subtitleLines={0}
                        testID="settings-composer-busy-steer"
                        testIDPrefix="settings-composer-busy-steer"
                        title={t(settings.busySteer.titleKey)}
                        subtitle={busySteerApplies ? undefined : t('settingsSessionPages.composer.busySteerInactive')}
                        disabled={!busySteerApplies}
                        options={[
                            {
                                id: 'steer_immediately',
                                label: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelyTitle'),
                                ...(busySteerApplies ? { description: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelySubtitle') } : {}),
                            },
                            {
                                id: 'server_pending',
                                label: t('settingsSession.messageSending.busySteerPolicy.queueForReviewTitle'),
                                ...(busySteerApplies ? { description: t('settingsSession.messageSending.busySteerPolicy.queueForReviewSubtitle') } : {}),
                            },
                        ]}
                        value={busySteerSendPolicy === 'server_pending' ? 'server_pending' : 'steer_immediately'}
                        onChange={setBusySteerSendPolicy}
                    />
                </SettingAnchor>
                <SettingRow
                    setting={settings.nonSteerablePrompt}
                    testID="settings-composer-non-steerable-prompt"
                    subtitle={nonSteerableSendPrompt === 'off'
                        ? t('settingsSession.messageSending.nonSteerablePrompt.offSubtitle')
                        : t('settingsSession.messageSending.nonSteerablePrompt.onSubtitle')}
                    subtitleLines={0}
                    rightElement={(
                        <Switch
                            value={nonSteerableSendPrompt !== 'off'}
                            onValueChange={(next) => setNonSteerableSendPrompt(next ? 'on' : 'off')}
                        />
                    )}
                    showChevron={false}
                    onPress={() => setNonSteerableSendPrompt(nonSteerableSendPrompt === 'off' ? 'on' : 'off')}
                />
                <SettingAnchor setting={settings.inactiveResume}>
                    <SegmentedChoiceItem<SessionInactiveResumePolicy>
                        subtitleLines={0}
                        testID="settings-composer-inactive-resume"
                        testIDPrefix="settings-composer-inactive-resume"
                        title={t(settings.inactiveResume.titleKey)}
                        options={inactiveResumePolicyOptions}
                        value={sessionInactiveResumePolicy}
                        onChange={setSessionInactiveResumePolicy}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSessionPages.composer.pendingSection')}
                description={pendingQueueMayBeUsed
                    ? t('settingsSessionPages.composer.pendingDescription')
                    : t('settingsSessionPages.composer.pendingInactive')}
            >
                <SettingAnchor setting={settings.pendingDrain}>
                    <SegmentedChoiceItem<PendingQueueDrainMode>
                        subtitleLines={0}
                        testID="settings-composer-pending-drain"
                        testIDPrefix="settings-composer-pending-drain"
                        title={t(settings.pendingDrain.titleKey)}
                        disabled={!pendingQueueMayBeUsed}
                        options={[
                            { id: 'one_at_a_time', label: t('settingsSessionPages.composer.drainOne'), description: t('settingsSession.messageSending.pendingDrainMode.oneAtATimeSubtitle') },
                            { id: 'drain_all', label: t('settingsSessionPages.composer.drainAll'), description: t('settingsSession.messageSending.pendingDrainMode.drainAllSubtitle') },
                        ]}
                        value={pendingQueueDrainMode === 'drain_all' ? 'drain_all' : 'one_at_a_time'}
                        onChange={setPendingQueueDrainMode}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.pendingTiming}>
                    <SegmentedChoiceItem<PendingQueueDeliveryTiming>
                        subtitleLines={0}
                        testID="settings-composer-pending-timing"
                        testIDPrefix="settings-composer-pending-timing"
                        title={t(settings.pendingTiming.titleKey)}
                        disabled={!pendingQueueMayBeUsed}
                        options={[
                            { id: 'after_foreground_ready', label: t('settingsSessionPages.composer.timingAfterReply'), description: t('settingsSession.messageSending.pendingDeliveryTiming.afterForegroundReadySubtitle') },
                            { id: 'after_runtime_idle', label: t('settingsSessionPages.composer.timingWhenIdle'), description: t('settingsSession.messageSending.pendingDeliveryTiming.afterRuntimeIdleSubtitle') },
                        ]}
                        value={pendingQueueDeliveryTiming === 'after_runtime_idle' ? 'after_runtime_idle' : 'after_foreground_ready'}
                        onChange={setPendingQueueDeliveryTiming}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSessionPages.composer.layoutSection')}
                description={t('settingsSession.input.footer')}
            >
                <SettingRow setting={settings.promptLibraryButton} testID="settings-composer-prompt-library-button"
                    rightElement={<Switch value={composerPromptLibraryButtonEnabled !== false} onValueChange={setComposerPromptLibraryButtonEnabled} />}
                    showChevron={false} onPress={() => setComposerPromptLibraryButtonEnabled(composerPromptLibraryButtonEnabled === false)} />
                <SettingAnchor setting={settings.actionBar}>
                    <Item
                        testID="settings-composer-action-bar"
                        title={t(settings.actionBar.titleKey)}
                        subtitle={t(ACTION_BAR_DESCRIPTION_KEYS[agentInputActionBarLayout] ?? ACTION_BAR_DESCRIPTION_KEYS.auto)}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <SelectionTiles<ActionBarLayout>
                                variant="visual"
                                accessibilityLabel={t(settings.actionBar.titleKey)}
                                testIdPrefix="settings-composer-action-bar"
                                value={agentInputActionBarLayout}
                                onChange={(next) => { if (next) setAgentInputActionBarLayout(next); }}
                                options={ACTION_BAR_LAYOUTS.map((layout) => ({
                                    id: layout,
                                    title: t(`settingsAppearance.agentInputActionBarLayoutOptions.${layout}`),
                                    preview: <ComposerActionBarPreview layout={layout} />,
                                }))}
                            />
                        )}
                    />
                </SettingAnchor>
                <SettingAnchor setting={settings.chipDensity}>
                    <Item
                        testID="settings-composer-chip-density"
                        title={t(settings.chipDensity.titleKey)}
                        subtitle={t(CHIP_DENSITY_DESCRIPTION_KEYS[agentInputChipDensity] ?? CHIP_DENSITY_DESCRIPTION_KEYS.auto)}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <SelectionTiles<ChipDensity>
                                variant="visual"
                                accessibilityLabel={t(settings.chipDensity.titleKey)}
                                testIdPrefix="settings-composer-chip-density"
                                value={agentInputChipDensity}
                                onChange={(next) => { if (next) setAgentInputChipDensity(next); }}
                                options={CHIP_DENSITIES.map((density) => ({
                                    id: density,
                                    title: t(`settingsAppearance.agentInputChipDensityOptions.${density}`),
                                    preview: <ComposerChipDensityPreview density={density} />,
                                }))}
                            />
                        )}
                    />
                </SettingAnchor>
                <SettingRow
                    setting={settings.glass}
                    rightElement={
                        <Switch
                            testID="settings-composer-glassSurface-switch"
                            value={composerSurfaceStyle === 'glass'}
                            onValueChange={(next) => setComposerSurfaceStyle(next ? 'glass' : 'standard')}
                        />
                    }
                    showChevron={false}
                    onPress={() => setComposerSurfaceStyle(composerSurfaceStyle === 'glass' ? 'standard' : 'glass')}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.banners.title')} description={t('settingsSession.banners.footer')}>
                <SettingRow
                    setting={settings.rememberBanners}
                    rightElement={
                        <Switch
                            testID="settings-composer-rememberBannerVisibility-switch"
                            value={rememberBannerVisibility}
                            onValueChange={setRememberBannerVisibility}
                        />
                    }
                    showChevron={false}
                    onPress={() => setRememberBannerVisibility(!rememberBannerVisibility)}
                />
                {hiddenBannerCount > 0 ? (
                    <Item
                        testID="settings-composer-resetHiddenBanners"
                        title={t('settingsSession.banners.resetHiddenTitle')}
                        subtitle={t('settingsSession.banners.resetHiddenSubtitle')}
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
