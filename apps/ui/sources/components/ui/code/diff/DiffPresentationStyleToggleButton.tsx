import * as React from 'react';
import { Platform } from 'react-native';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { normalizeDiffPresentationPreference, useDiffSplitFits } from './diffPresentationStyle';
import { t } from '@/text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';

export type DiffPresentationStyleToggleButtonProps = Readonly<{
    disabled?: boolean;
    size?: number;
    presentation?: 'icon' | 'segmented';
}>;

export const DiffPresentationStyleToggleButton = React.memo<DiffPresentationStyleToggleButtonProps>((props) => {
    const [styleSetting, setStyleSetting] = useSettingMutable('filesDiffPresentationStyle');

    // The container's split rule (`DIFF_SPLIT_MIN_WIDTH_PX`): where split cannot be drawn the diff is
    // unified, so the toggle shows unified and says why instead of offering a choice that does nothing.
    const splitFits = useDiffSplitFits();
    const splitTooNarrow = splitFits === false;
    const effectiveStyle = splitTooNarrow ? 'unified' : normalizeDiffPresentationPreference(styleSetting);
    const disabled = props.disabled === true || splitTooNarrow;
    const iconSize = typeof props.size === 'number' ? props.size : 18;

    const accessibilityLabel = t(
        effectiveStyle === 'unified'
            ? 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title'
            : 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title',
    );

    const toggle = React.useCallback(() => {
        if (disabled) return;
        setStyleSetting(effectiveStyle === 'unified' ? 'split' : 'unified');
    }, [disabled, effectiveStyle, setStyleSetting]);

    if (props.presentation === 'segmented') {
        return (
            <SegmentedTabBar
                testIDPrefix="diff-presentation"
                accessibilityLabel={accessibilityLabel}
                tabs={(['unified', 'split'] as const).map((id) => ({
                    id,
                    label: t(`settingsSourceControl.filesDisplay.diffPresentation.options.${id}.title`),
                    disabled: props.disabled === true || (id === 'split' && splitTooNarrow),
                    unavailableReason: id === 'split' && splitTooNarrow ? t('detailsSurface.chrome.splitNeedsWiderPane') : undefined,
                }))}
                activeTabId={effectiveStyle}
                onSelectTab={setStyleSetting}
                segmentSizing="content"
                compact
            />
        );
    }

    return (
        <IconButton
            onPress={toggle}
            disabled={disabled}
            disabledReason={splitTooNarrow ? t('detailsSurface.chrome.splitNeedsWiderPane') : undefined}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            tooltip={accessibilityLabel}
            iconName="square-split-horizontal"
            iconSize={iconSize}
            size={28}
            variant="plain"
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            interactiveTargetGapPx={8}
        />
    );
});
