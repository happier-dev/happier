import * as React from 'react';
import { HappierWorkRowShell, HappierWorkSummary, joinHappierFacts, useHappierPageSection, type HappierWorkRowShellProps, type HappierWorkSummaryProps } from '@happier-dev/plugin-ui/presentation';
import { WORK_HOST, useWorkTheme } from '@/components/work/map/WorkMapView';

/**
 * Inbox binds the Work anatomy; request classification and answer controls remain with their owners.
 *
 * Every Inbox row needs the person, so none draws the attention dot in its mark's corner: being in the
 * Inbox says it, and the strong title and the state word carry it (lab `inbox-I1`/`inbox-I2`). On the
 * Inbox page (a page sheet) the rows take the page density and its row hairlines; the rail popover
 * keeps the compact Work density. A wide row's date closes the row in its own column, so every date in
 * a sheet lines up whatever its row's state word and control are.
 */
export const InboxWorkRow = React.memo(function InboxWorkRow(props: Readonly<{
    testID: string; title: string; facts?: readonly React.ReactNode[]; mark?: React.ReactNode;
    /** Who it involves, under the facts. */
    byline?: HappierWorkSummaryProps['byline'];
    phase?: HappierWorkSummaryProps['phase']; status?: HappierWorkSummaryProps['trailingState']; time?: React.ReactNode;
    /**
     * A narrow row (a phone, the rail popover; labs `phone-P4`, `inbox-I2`) has no state column: the
     * line beneath the title says what it is and how long it has waited ("Workflow run · 8m"). Every
     * Inbox row needs the person, so the state word is left to the wide page's column and to the row's
     * accessible label; a failure is said by the row's mark.
     */
    narrow?: boolean;
    accessibilityLabel?: string; selected?: boolean; onPress: () => void; trailingAccessory?: React.ReactNode;
    /** Actions beneath the row's text, on its text column: a phone row's answer (lab coordination `P4-Ap`). */
    belowAccessory?: React.ReactNode;
    accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
    accessibilityActions?: HappierWorkRowShellProps['accessibilityActions'];
    onAccessibilityAction?: HappierWorkRowShellProps['onAccessibilityAction'];
    /** Passed by the page sheet: the hairline under every row but the last. */
    showDivider?: boolean;
}>) {
    const theme = useWorkTheme();
    const density = useHappierPageSection() ? 'page' : 'pane';
    const label = props.accessibilityLabel ?? joinHappierFacts(props.title, props.status?.word,
        ...(props.facts ?? []).filter((fact): fact is string => typeof fact === 'string'));
    const facts = props.narrow && props.time ? [...(props.facts ?? []), <React.Fragment key="age">{props.time}</React.Fragment>] : props.facts ?? [];
    return <HappierWorkRowShell testID={props.testID} accessibilityLabel={label} selected={props.selected}
        onPress={props.onPress} trailingAccessory={props.trailingAccessory} trailingMeta={density === 'page' && !props.narrow ? props.time : undefined}
        belowAccessory={props.belowAccessory} accessibilityActions={props.accessibilityActions}
        onAccessibilityAction={props.onAccessibilityAction} density={density} showDivider={props.showDivider} theme={theme} host={WORK_HOST}>
        <HappierWorkSummary testID={`${props.testID}.summary`} title={props.title} phase={props.phase ?? 'attention'}
            mark={props.mark} facts={facts} byline={props.byline} trailingState={props.narrow ? null : props.status} trailingTime={density === 'pane' && !props.narrow ? props.time : undefined}
            accessibilityLabel={label} accessibilityLiveRegion={props.accessibilityLiveRegion} density={density} attentionMark={false}
            titleLines={props.narrow && density === 'page' ? 2 : 1} theme={theme} host={WORK_HOST} />
    </HappierWorkRowShell>;
});
