import * as React from 'react';
import { Platform } from 'react-native';

import { normalizeDiffPresentationPreference, useDiffSplitFits } from '@/components/ui/code/diff/diffPresentationStyle';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ScmComparisonMoreMenu, type ScmComparisonMenuSection } from '@/components/sessions/files/comparison/ScmComparisonMoreMenu';
import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useEffectiveDiffWrapLines } from '@/components/ui/code/diff/diffPresentationStyle';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';

export type ChangedFilesReviewMoreMenuProps = Readonly<{
    diffArea: ScmDiffArea;
    availableDiffAreas: readonly ScmDiffArea[];
    diffAreaLabels: Readonly<Record<ScmDiffArea, string>>;
    onDiffArea: (area: ScmDiffArea) => void;
    /** The host's own rows (review comments), ahead of the display choices. */
    leadingSections?: readonly ScmComparisonMenuSection[];
    /** Rows after the display choices: the pane's lent rows when this is a header's own `⋯`. */
    trailingSections?: readonly ScmComparisonMenuSection[];
    testID?: string;
    /** The gap to the neighbouring bar action: their finger frames split it. */
    interactiveTargetGapPx?: number;
}>;

/**
 * The comparison bar's ⋯ (Walkthrough lab WT8): Review's display choices (which change area, wrapping,
 * unified or split) live here so the bar keeps only the scope and its actions. The same settings the
 * Review toolbar buttons write.
 */
/**
 * Review's display choices as menu rows, for whichever menu shows them: the wide bar's own `⋯`, or the
 * phone comparison menu's Display section.
 */
export function useChangedFilesReviewDisplayMenu(props: Omit<ChangedFilesReviewMoreMenuProps, 'testID' | 'leadingSections' | 'trailingSections' | 'interactiveTargetGapPx'>): Readonly<{
    items: DropdownMenuItem[];
    select: (id: string) => void;
}> {
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const [styleSetting, setStyleSetting] = useSettingMutable('filesDiffPresentationStyle');
    const splitFits = useDiffSplitFits();
    const phone = useSurfaceStateSize() === 'phone';
    const wrapLines = useEffectiveDiffWrapLines(wrapLinesSetting !== false) === true;
    const presentation = splitFits === false ? 'unified' : normalizeDiffPresentationPreference(styleSetting);

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
    return { items, select };
}

export const ChangedFilesReviewMoreMenu = React.memo(function ChangedFilesReviewMoreMenu(props: ChangedFilesReviewMoreMenuProps) {
    const { items, select } = useChangedFilesReviewDisplayMenu(props);
    const leading = props.leadingSections;
    const trailing = props.trailingSections;
    const sections = React.useMemo(() => [...(leading ?? []), { id: 'display', items, onSelect: select }, ...(trailing ?? [])],
        [items, leading, select, trailing]);
    return <ScmComparisonMoreMenu sections={sections} testID={props.testID} interactiveTargetGapPx={props.interactiveTargetGapPx} />;
});
