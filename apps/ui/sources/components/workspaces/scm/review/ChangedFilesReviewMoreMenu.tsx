import * as React from 'react';
import { Platform, View } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { normalizeDiffPresentationPreference, useDiffSplitFits } from '@/components/ui/code/diff/diffPresentationStyle';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useEffectiveDiffWrapLines } from '@/components/ui/code/diff/diffPresentationStyle';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';

export type ChangedFilesReviewMoreMenuProps = Readonly<{
    diffArea: ScmDiffArea;
    availableDiffAreas: readonly ScmDiffArea[];
    diffAreaLabels: Readonly<Record<ScmDiffArea, string>>;
    onDiffArea: (area: ScmDiffArea) => void;
    testID?: string;
}>;

/**
 * The comparison bar's ⋯ (Walkthrough lab WT8): Review's display choices (which change area, wrapping,
 * unified or split) live here so the bar keeps only the scope and its actions. The same settings the
 * Review toolbar buttons write.
 */
export const ChangedFilesReviewMoreMenu = React.memo(function ChangedFilesReviewMoreMenu(props: ChangedFilesReviewMoreMenuProps) {
    const [open, setOpen] = React.useState(false);
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const [styleSetting, setStyleSetting] = useSettingMutable('filesDiffPresentationStyle');
    const splitFits = useDiffSplitFits();
    const phone = useSurfaceStateSize() === 'phone';
    const wrapLines = useEffectiveDiffWrapLines(wrapLinesSetting !== false) === true;
    const presentation = splitFits === false ? 'unified' : normalizeDiffPresentationPreference(styleSetting);
    const testID = props.testID ?? 'scm-comparison-more';

    const items = React.useMemo<DropdownMenuItem[]>(() => {
        const out: DropdownMenuItem[] = [];
        if (props.availableDiffAreas.length > 1) {
            for (const area of props.availableDiffAreas) {
                out.push({ id: `area:${area}`, title: props.diffAreaLabels[area], checked: area === props.diffArea });
            }
        }
        out.push({ id: 'wrap', title: t('settingsAppearance.wrapLinesInDiffs'), checked: wrapLines, disabled: phone });
        if (Platform.OS === 'web') {
            out.push({ id: 'style:unified', title: t('settingsSourceControl.filesDisplay.diffPresentation.options.unified.title'), checked: presentation === 'unified' });
            out.push({
                id: 'style:split',
                title: t('settingsSourceControl.filesDisplay.diffPresentation.options.split.title'),
                checked: presentation === 'split',
                disabled: splitFits === false,
                ...(splitFits === false ? { subtitle: t('detailsSurface.chrome.splitNeedsWiderPane') } : {}),
            });
        }
        return out;
    }, [phone, presentation, props.availableDiffAreas, props.diffArea, props.diffAreaLabels, splitFits, wrapLines]);

    const onDiffArea = props.onDiffArea;
    const select = React.useCallback((id: string) => {
        if (id.startsWith('area:')) {
            onDiffArea(id.slice('area:'.length) as ScmDiffArea);
            return;
        }
        if (id === 'wrap') {
            if (phone) return;
            setWrapLines(!wrapLines);
            return;
        }
        if (id === 'style:unified' || id === 'style:split') setStyleSetting(id === 'style:split' ? 'split' : 'unified');
    }, [onDiffArea, phone, setStyleSetting, setWrapLines, wrapLines]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={null}
            onSelect={select}
            search={false}
            matchTriggerWidth={false}
            maxWidthCap={280}
            placement="bottom"
            popoverAnchorAlign="end"
            trigger={({ toggle, open: triggerOpen }) => (
                <View>
                    <IconButton
                        testID={testID}
                        variant="plain"
                        size={28}
                        iconName="dots-three"
                        iconSize={18}
                        selected={triggerOpen}
                        expanded={triggerOpen}
                        hasPopup="menu"
                        accessibilityLabel={t('common.more')}
                        tooltip={t('common.more')}
                        onPress={toggle}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    />
                </View>
            )}
        />
    );
});
