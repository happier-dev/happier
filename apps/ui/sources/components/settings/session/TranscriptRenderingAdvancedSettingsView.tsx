import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { normalizeTranscriptMotionPreset } from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { TRANSCRIPT_ADVANCED_SETTINGS } from '@/components/settings/session/transcriptAdvancedSettings';

function formatInteger(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '';
}

/**
 * A declared whole-number setting on this page: the shared inline field (`FieldValueItem`), with the
 * nonnegative whole-number preference saved without a separate page-local ceiling.
 */
function IntegerSettingRow(props: Readonly<{
    setting: SettingRef;
    value: unknown;
    onCommit: (next: number) => void;
    disabled?: boolean;
    testID?: string;
    showDivider?: boolean;
}>) {
    const saved = formatInteger(props.value);
    const { onCommit } = props;
    const commit = React.useCallback((draft: string) => {
        const value = Number(draft);
        if (!Number.isFinite(value)) return saved;
        const next = Math.max(0, Math.trunc(value));
        if (String(next) !== saved) onCommit(next);
        return String(next);
    }, [onCommit, saved]);
    return (
        <SettingAnchor setting={props.setting} showDivider={props.showDivider}>
            <FieldValueItem
                title={t(props.setting.titleKey)}
                subtitle={props.setting.descriptionKey ? t(props.setting.descriptionKey) : undefined}
                kind="integer"
                disabled={props.disabled}
                fieldTestID={props.testID}
                value={saved}
                onCommit={commit}
            />
        </SettingAnchor>
    );
}

export const TranscriptRenderingAdvancedSettingsView = React.memo(function TranscriptRenderingAdvancedSettingsView() {
    const settings = TRANSCRIPT_ADVANCED_SETTINGS.settings;

    const [transcriptStreamingCoalesceEnabled, setTranscriptStreamingCoalesceEnabled] = useSettingMutable('transcriptStreamingCoalesceEnabled');
    const [transcriptStreamingCoalesceWindowMs, setTranscriptStreamingCoalesceWindowMs] = useSettingMutable('transcriptStreamingCoalesceWindowMs');
    const [transcriptStreamingCoalesceMaxBatchSize, setTranscriptStreamingCoalesceMaxBatchSize] = useSettingMutable('transcriptStreamingCoalesceMaxBatchSize');
    const [transcriptStreamingPartialOutputEnabled, setTranscriptStreamingPartialOutputEnabled] = useSettingMutable('transcriptStreamingPartialOutputEnabled');
    const [transcriptThinkingPulseStaleMs, setTranscriptThinkingPulseStaleMs] = useSettingMutable('transcriptThinkingPulseStaleMs');

    const [transcriptMotionPreset] = useSettingMutable('transcriptMotionPreset');
    const normalizedMotionPreset = normalizeTranscriptMotionPreset(transcriptMotionPreset);

    const [transcriptMotionFreshnessMs, setTranscriptMotionFreshnessMs] = useSettingMutable('transcriptMotionFreshnessMs');
    const [transcriptAnimateNewItemsEnabled, setTranscriptAnimateNewItemsEnabled] = useSettingMutable('transcriptAnimateNewItemsEnabled');
    const [transcriptAnimateToolExpandCollapseEnabled, setTranscriptAnimateToolExpandCollapseEnabled] = useSettingMutable('transcriptAnimateToolExpandCollapseEnabled');
    const [transcriptAnimateToolExpandCollapseFreshOnly, setTranscriptAnimateToolExpandCollapseFreshOnly] = useSettingMutable('transcriptAnimateToolExpandCollapseFreshOnly');
    const [transcriptAnimateThinkingEnabled, setTranscriptAnimateThinkingEnabled] = useSettingMutable('transcriptAnimateThinkingEnabled');

    const [transcriptScrollPinOffsetThresholdPx, setTranscriptScrollPinOffsetThresholdPx] = useSettingMutable('transcriptScrollPinOffsetThresholdPx');
    const [transcriptScrollAutoFollowWhenPinned, setTranscriptScrollAutoFollowWhenPinned] = useSettingMutable('transcriptScrollAutoFollowWhenPinned');
    const [transcriptScrollJumpToBottomMinNewCount, setTranscriptScrollJumpToBottomMinNewCount] = useSettingMutable('transcriptScrollJumpToBottomMinNewCount');
    const [transcriptScrollJumpToBottomAnimateScroll, setTranscriptScrollJumpToBottomAnimateScroll] = useSettingMutable('transcriptScrollJumpToBottomAnimateScroll');

    // Motion timing only matters while transcript animations are on.
    const canAdjustMotion = normalizedMotionPreset !== 'off';

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.transcript.advancedPageDescription')} />
            <ItemGroup
                title={t('settingsSession.transcript.advanced.performanceTitle')}
                description={t('settingsSession.transcript.advanced.performanceFooter')}
            >
                <SettingRow
                    setting={settings.coalesceEnabled}
                    rightElement={
                        <Switch
                            value={transcriptStreamingCoalesceEnabled === true}
                            onValueChange={(v) => setTranscriptStreamingCoalesceEnabled(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptStreamingCoalesceEnabled((transcriptStreamingCoalesceEnabled !== true) as any)}
                />
                <IntegerSettingRow
                    setting={settings.coalesceWindow}
                    testID="settings-transcript-advanced-coalesce-window"
                    value={transcriptStreamingCoalesceWindowMs}
                    onCommit={(next) => setTranscriptStreamingCoalesceWindowMs(next as any)}
                />
                <IntegerSettingRow
                    setting={settings.coalesceMaxBatch}
                    testID="settings-transcript-advanced-coalesce-max-batch"
                    value={transcriptStreamingCoalesceMaxBatchSize}
                    onCommit={(next) => setTranscriptStreamingCoalesceMaxBatchSize(next as any)}
                />
                <SettingRow
                    setting={settings.streamingPartialOutput}
                    rightElement={
                        <Switch
                            value={transcriptStreamingPartialOutputEnabled !== false}
                            onValueChange={(v) => setTranscriptStreamingPartialOutputEnabled(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptStreamingPartialOutputEnabled((transcriptStreamingPartialOutputEnabled === false) as any)}
                />
                <IntegerSettingRow
                    setting={settings.thinkingPulseStale}
                    testID="settings-transcript-advanced-thinking-stale"
                    value={transcriptThinkingPulseStaleMs}
                    onCommit={(next) => setTranscriptThinkingPulseStaleMs(next as any)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.transcript.motionTitle')}
                description={canAdjustMotion
                    ? t('settingsSession.transcript.advanced.motionFooter')
                    : t('settingsSessionPages.transcript.advancedMotionOff')}
            >
                <IntegerSettingRow
                    setting={settings.freshness}
                    testID="settings-transcript-advanced-freshness"
                    value={transcriptMotionFreshnessMs}
                    disabled={!canAdjustMotion}
                    onCommit={(next) => setTranscriptMotionFreshnessMs(next as any)}
                />
                <SettingRow
                    setting={settings.animateNewItems}
                    disabled={!canAdjustMotion}
                    rightElement={
                        <Switch
                            value={transcriptAnimateNewItemsEnabled === true}
                            onValueChange={(v) => setTranscriptAnimateNewItemsEnabled(Boolean(v) as any)}
                            disabled={!canAdjustMotion}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (!canAdjustMotion) return;
                        setTranscriptAnimateNewItemsEnabled((transcriptAnimateNewItemsEnabled !== true) as any);
                    }}
                />
                <SettingRow
                    setting={settings.animateToolExpandCollapse}
                    disabled={!canAdjustMotion}
                    rightElement={
                        <Switch
                            value={transcriptAnimateToolExpandCollapseEnabled === true}
                            onValueChange={(v) => setTranscriptAnimateToolExpandCollapseEnabled(Boolean(v) as any)}
                            disabled={!canAdjustMotion}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (!canAdjustMotion) return;
                        setTranscriptAnimateToolExpandCollapseEnabled((transcriptAnimateToolExpandCollapseEnabled !== true) as any);
                    }}
                />
                <SettingRow
                    setting={settings.animateToolExpandCollapseFreshOnly}
                    disabled={!canAdjustMotion || transcriptAnimateToolExpandCollapseEnabled !== true}
                    rightElement={
                        <Switch
                            value={transcriptAnimateToolExpandCollapseFreshOnly === true}
                            onValueChange={(v) => setTranscriptAnimateToolExpandCollapseFreshOnly(Boolean(v) as any)}
                            disabled={!canAdjustMotion || transcriptAnimateToolExpandCollapseEnabled !== true}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (!canAdjustMotion) return;
                        if (transcriptAnimateToolExpandCollapseEnabled !== true) return;
                        setTranscriptAnimateToolExpandCollapseFreshOnly((transcriptAnimateToolExpandCollapseFreshOnly !== true) as any);
                    }}
                />
                <SettingRow
                    setting={settings.animateThinking}
                    disabled={!canAdjustMotion}
                    rightElement={
                        <Switch
                            value={transcriptAnimateThinkingEnabled === true}
                            onValueChange={(v) => setTranscriptAnimateThinkingEnabled(Boolean(v) as any)}
                            disabled={!canAdjustMotion}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (!canAdjustMotion) return;
                        setTranscriptAnimateThinkingEnabled((transcriptAnimateThinkingEnabled !== true) as any);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.transcript.scrollTitle')}
                description={t('settingsSession.transcript.advanced.scrollFooter')}
            >
                <IntegerSettingRow
                    setting={settings.pinOffset}
                    testID="settings-transcript-advanced-pin-offset"
                    value={transcriptScrollPinOffsetThresholdPx}
                    onCommit={(next) => setTranscriptScrollPinOffsetThresholdPx(next as any)}
                />
                <SettingRow
                    setting={settings.autoFollow}
                    rightElement={
                        <Switch
                            value={transcriptScrollAutoFollowWhenPinned === true}
                            onValueChange={(v) => setTranscriptScrollAutoFollowWhenPinned(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptScrollAutoFollowWhenPinned((transcriptScrollAutoFollowWhenPinned !== true) as any)}
                />
                <IntegerSettingRow
                    setting={settings.jumpMinNewCount}
                    testID="settings-transcript-advanced-jump-min-count"
                    value={transcriptScrollJumpToBottomMinNewCount}
                    onCommit={(next) => setTranscriptScrollJumpToBottomMinNewCount(next as any)}
                />
                <SettingRow
                    setting={settings.jumpAnimateScroll}
                    rightElement={
                        <Switch
                            value={transcriptScrollJumpToBottomAnimateScroll === true}
                            onValueChange={(v) => setTranscriptScrollJumpToBottomAnimateScroll(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptScrollJumpToBottomAnimateScroll((transcriptScrollJumpToBottomAnimateScroll !== true) as any)}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default TranscriptRenderingAdvancedSettingsView;
