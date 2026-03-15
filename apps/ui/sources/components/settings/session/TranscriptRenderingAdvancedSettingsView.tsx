import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';

type TranscriptMotionPreset = 'off' | 'subtle' | 'full';

function clampInt(value: number, bounds: Readonly<{ min: number; max: number }>): number {
    if (!Number.isFinite(value)) return bounds.min;
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

export const TranscriptRenderingAdvancedSettingsView = React.memo(function TranscriptRenderingAdvancedSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const [transcriptStreamingCoalesceEnabled, setTranscriptStreamingCoalesceEnabled] = useSettingMutable('transcriptStreamingCoalesceEnabled');
    const [transcriptStreamingCoalesceWindowMs, setTranscriptStreamingCoalesceWindowMs] = useSettingMutable('transcriptStreamingCoalesceWindowMs');
    const [transcriptStreamingCoalesceMaxBatchSize, setTranscriptStreamingCoalesceMaxBatchSize] = useSettingMutable('transcriptStreamingCoalesceMaxBatchSize');
    const [transcriptThinkingPulseStaleMs, setTranscriptThinkingPulseStaleMs] = useSettingMutable('transcriptThinkingPulseStaleMs');
    const [transcriptListImplementation, setTranscriptListImplementation] = useSettingMutable('transcriptListImplementation');

    const [transcriptMotionPreset] = useSettingMutable('transcriptMotionPreset');
    const normalizedMotionPreset: TranscriptMotionPreset =
        transcriptMotionPreset === 'off' || transcriptMotionPreset === 'full' ? transcriptMotionPreset : 'subtle';

    const [transcriptMotionFreshnessMs, setTranscriptMotionFreshnessMs] = useSettingMutable('transcriptMotionFreshnessMs');
    const [transcriptAnimateNewItemsEnabled, setTranscriptAnimateNewItemsEnabled] = useSettingMutable('transcriptAnimateNewItemsEnabled');
    const [transcriptAnimateToolExpandCollapseEnabled, setTranscriptAnimateToolExpandCollapseEnabled] = useSettingMutable('transcriptAnimateToolExpandCollapseEnabled');
    const [transcriptAnimateToolExpandCollapseFreshOnly, setTranscriptAnimateToolExpandCollapseFreshOnly] = useSettingMutable('transcriptAnimateToolExpandCollapseFreshOnly');
    const [transcriptAnimateThinkingEnabled, setTranscriptAnimateThinkingEnabled] = useSettingMutable('transcriptAnimateThinkingEnabled');

    const [transcriptScrollPinOffsetThresholdPx, setTranscriptScrollPinOffsetThresholdPx] = useSettingMutable('transcriptScrollPinOffsetThresholdPx');
    const [transcriptScrollAutoFollowWhenPinned, setTranscriptScrollAutoFollowWhenPinned] = useSettingMutable('transcriptScrollAutoFollowWhenPinned');
    const [transcriptScrollJumpToBottomMinNewCount, setTranscriptScrollJumpToBottomMinNewCount] = useSettingMutable('transcriptScrollJumpToBottomMinNewCount');
    const [transcriptScrollJumpToBottomAnimateScroll, setTranscriptScrollJumpToBottomAnimateScroll] = useSettingMutable('transcriptScrollJumpToBottomAnimateScroll');

    const [openListImplementationMenu, setOpenListImplementationMenu] = React.useState(false);

    const normalizedTranscriptListImplementation: 'flash_v2' | 'flatlist_legacy' =
        transcriptListImplementation === 'flatlist_legacy' ? 'flatlist_legacy' : 'flash_v2';

    const listImplementationOptions: Array<{ key: 'flash_v2' | 'flatlist_legacy'; title: string; subtitle: string }> = [
        {
            key: 'flash_v2',
            title: t('settingsSession.transcript.advanced.listImplementation.flashTitle'),
            subtitle: t('settingsSession.transcript.advanced.listImplementation.flashSubtitle'),
        },
        {
            key: 'flatlist_legacy',
            title: t('settingsSession.transcript.advanced.listImplementation.legacyTitle'),
            subtitle: t('settingsSession.transcript.advanced.listImplementation.legacySubtitle'),
        },
    ];

    const canAdjustMotion = normalizedMotionPreset !== 'off';

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.transcript.advanced.performanceTitle')}
                footer={t('settingsSession.transcript.advanced.performanceFooter')}
            >
                <Item
                    title={t('settingsSession.transcript.advanced.coalesceEnabledTitle')}
                    subtitle={t('settingsSession.transcript.advanced.coalesceEnabledSubtitle')}
                    icon={<Ionicons name="layers-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            value={transcriptStreamingCoalesceEnabled === true}
                            onValueChange={(v) => setTranscriptStreamingCoalesceEnabled(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptStreamingCoalesceEnabled((transcriptStreamingCoalesceEnabled !== true) as any)}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.coalesceWindowTitle')}
                    subtitle={t('settingsSession.transcript.advanced.coalesceWindowSubtitle', { value: String(transcriptStreamingCoalesceWindowMs ?? 0) })}
                    icon={<Ionicons name="timer-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.coalesceWindowPromptTitle'),
                            t('settingsSession.transcript.advanced.coalesceWindowPromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptStreamingCoalesceWindowMs(clampInt(parsed, { min: 0, max: 200 }) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.coalesceMaxBatchTitle')}
                    subtitle={t('settingsSession.transcript.advanced.coalesceMaxBatchSubtitle', { value: String(transcriptStreamingCoalesceMaxBatchSize ?? 0) })}
                    icon={<Ionicons name="funnel-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.coalesceMaxBatchPromptTitle'),
                            t('settingsSession.transcript.advanced.coalesceMaxBatchPromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptStreamingCoalesceMaxBatchSize(clampInt(parsed, { min: 1, max: 2000 }) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.thinkingPulseStaleTitle')}
                    subtitle={t('settingsSession.transcript.advanced.thinkingPulseStaleSubtitle', { value: String(transcriptThinkingPulseStaleMs ?? 0) })}
                    icon={<Ionicons name="hourglass-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.thinkingPulseStalePromptTitle'),
                            t('settingsSession.transcript.advanced.thinkingPulseStalePromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptThinkingPulseStaleMs(clampInt(parsed, { min: 5000, max: 600_000 }) as any);
                    }}
                />

                <DropdownMenu
                    open={openListImplementationMenu}
                    onOpenChange={setOpenListImplementationMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedTranscriptListImplementation as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.transcript.advanced.listImplementationTitle'),
                        icon: <Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />,
                        subtitle: t('settingsSession.transcript.advanced.listImplementationSubtitle'),
                    }}
                    items={listImplementationOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setTranscriptListImplementation(String(id) as any);
                        setOpenListImplementationMenu(false);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.transcript.advanced.motionTitle')}
                footer={t('settingsSession.transcript.advanced.motionFooter')}
            >
                <Item
                    title={t('settingsSession.transcript.advanced.freshnessTitle')}
                    subtitle={t('settingsSession.transcript.advanced.freshnessSubtitle', { value: String(transcriptMotionFreshnessMs ?? 0) })}
                    icon={<Ionicons name="timer-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        if (!canAdjustMotion) return;
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.freshnessPromptTitle'),
                            t('settingsSession.transcript.advanced.freshnessPromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptMotionFreshnessMs(clampInt(parsed, { min: 0, max: 600_000 }) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.animateNewItemsTitle')}
                    subtitle={t('settingsSession.transcript.advanced.animateNewItemsSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
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

                <Item
                    title={t('settingsSession.transcript.advanced.animateToolExpandCollapseTitle')}
                    subtitle={t('settingsSession.transcript.advanced.animateToolExpandCollapseSubtitle')}
                    icon={<Ionicons name="chevron-expand-outline" size={29} color={theme.colors.textSecondary} />}
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

                <Item
                    title={t('settingsSession.transcript.advanced.animateToolExpandCollapseFreshOnlyTitle')}
                    subtitle={t('settingsSession.transcript.advanced.animateToolExpandCollapseFreshOnlySubtitle')}
                    icon={<Ionicons name="leaf-outline" size={29} color={theme.colors.textSecondary} />}
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

                <Item
                    title={t('settingsSession.transcript.advanced.animateThinkingTitle')}
                    subtitle={t('settingsSession.transcript.advanced.animateThinkingSubtitle')}
                    icon={<Ionicons name="bulb-outline" size={29} color={theme.colors.textSecondary} />}
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
                title={t('settingsSession.transcript.advanced.scrollTitle')}
                footer={t('settingsSession.transcript.advanced.scrollFooter')}
            >
                <Item
                    title={t('settingsSession.transcript.advanced.pinOffsetTitle')}
                    subtitle={t('settingsSession.transcript.advanced.pinOffsetSubtitle', { value: String(transcriptScrollPinOffsetThresholdPx ?? 0) })}
                    icon={<Ionicons name="navigate-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.pinOffsetPromptTitle'),
                            t('settingsSession.transcript.advanced.pinOffsetPromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptScrollPinOffsetThresholdPx(clampInt(parsed, { min: 0, max: 400 }) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.autoFollowTitle')}
                    subtitle={t('settingsSession.transcript.advanced.autoFollowSubtitle')}
                    icon={<Ionicons name="arrow-down-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={transcriptScrollAutoFollowWhenPinned === true}
                            onValueChange={(v) => setTranscriptScrollAutoFollowWhenPinned(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptScrollAutoFollowWhenPinned((transcriptScrollAutoFollowWhenPinned !== true) as any)}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.jumpMinNewCountTitle')}
                    subtitle={t('settingsSession.transcript.advanced.jumpMinNewCountSubtitle', { value: String(transcriptScrollJumpToBottomMinNewCount ?? 0) })}
                    icon={<Ionicons name="chevron-down-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('settingsSession.transcript.advanced.jumpMinNewCountPromptTitle'),
                            t('settingsSession.transcript.advanced.jumpMinNewCountPromptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setTranscriptScrollJumpToBottomMinNewCount(clampInt(parsed, { min: 1, max: 999 }) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advanced.jumpAnimateScrollTitle')}
                    subtitle={t('settingsSession.transcript.advanced.jumpAnimateScrollSubtitle')}
                    icon={<Ionicons name="swap-vertical-outline" size={29} color={theme.colors.textSecondary} />}
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
