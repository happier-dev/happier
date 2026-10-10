import {
    HappierWorkFlatSheet,
    HappierWorkSection,
    HappierWorkSectionEmptyLine,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * One section of the Work pane (and of the in-session agent roster it hosts): Happier core's binding
 * of the shared Work section (`HappierWorkSection` in `@happier-dev/plugin-ui/presentation`, the same
 * owner a plugin's Work-style surface draws with). The two anatomies — `list` for a group of the live
 * work list, `page` for a configuration section laid flat on the pane (lab `convo-W8/W9`) — and the
 * loading skeleton live there; this file supplies core's theme, text owner, count wording and the ⓘ
 * control that explains a configuration section.
 */

export type WorkSectionProps = Readonly<{
    testID: string;
    title: string;
    /**
     * Beside the title, quiet. A number is the rows' count (omitted at 0); a string is the section's
     * own summary ("5 on", "2 changed · 2 added").
     */
    count: number | string;
    countMode?: 'quiet' | 'attention' | 'none';
    /** `list` (default): a group of the live work list. `page`: a configuration section of the pane. */
    anatomy?: 'list' | 'page';
    /** `page` only: what the section is and what it applies to, behind ⓘ. */
    info?: string;
    loading?: boolean;
    /** Anchor for a route that scrolls to this section. */
    nativeID?: string;
    /** One quiet operation on the whole section ("+", ✎, "Use defaults"), at the header's trailing edge. */
    action?: React.ReactNode;
    children?: React.ReactNode;
}>;

export const WorkSection = React.memo((props: WorkSectionProps) => {
    const theme = useWorkTheme();
    const reducedMotion = useReducedMotionPreference();
    const { title, info } = props;
    const showInfo = React.useCallback(() => {
        if (info) Modal.alert(title, info);
    }, [info, title]);
    const anatomy = props.anatomy ?? 'list';

    const section = (
        <HappierWorkSection
            testID={props.testID}
            title={title}
            count={readCountText(props)}
            countTone={props.countMode === 'attention' ? 'attention' : 'quiet'}
            countTestID={`session-agents-section-count:${props.testID}`}
            anatomy={anatomy}
            info={anatomy === 'page' && info ? (
                <IconButton
                    testID={`${props.testID}-info`}
                    iconName="info"
                    variant="plain"
                    accessibilityLabel={info}
                    tooltip={info}
                    onPress={showInfo}
                />
            ) : undefined}
            loading={props.loading}
            nativeID={props.nativeID}
            action={props.action}
            reducedMotion={reducedMotion}
            theme={theme}
            host={WORK_HOST}
        >
            {props.children}
        </HappierWorkSection>
    );
    // A configuration section's rows are configuration-page rows (core `Item` reads the page anatomy from
    // the list presentation). The scope opens outside the section's sheet, which supplies the inset.
    return anatomy === 'page' ? <ListPresentationProvider value="page">{section}</ListPresentationProvider> : section;
});

/**
 * The Work pane's flat sheet: rows laid on the pane (no sheet, edge or radius), on the Work list's own
 * inset and with no hairlines between them (lab `convo-W8/W9`). A page section's body, and the top
 * value rows (Role, Goal) that open the tab. Its rows are configuration-page rows, like a page
 * section's.
 */
export function WorkFlatSheet(props: Readonly<{ testID?: string; children?: React.ReactNode }>) {
    const theme = useWorkTheme();
    return (
        <ListPresentationProvider value="page">
            <HappierWorkFlatSheet testID={props.testID} theme={theme}>{props.children}</HappierWorkFlatSheet>
        </ListPresentationProvider>
    );
}

/**
 * A Work section with nothing in it yet says so in one quiet line (DESIGN.md "Emptiness is designed";
 * lab `convo-ST`, the empty Notes row): the section description's text, on the rows' text edge, never
 * a full-height row set in the row title's type. With `onPress` the line is the section's way to start
 * ("Add notes for how this session should orchestrate"); without it, it only states what belongs here.
 * Every Work section draws its empty state through this one line.
 */
export function WorkSectionEmptyLine(props: Readonly<{
    testID: string;
    text: string;
    onPress?: () => void;
}>) {
    const theme = useWorkTheme();
    return <HappierWorkSectionEmptyLine {...props} theme={theme} host={WORK_HOST} />;
}

function readCountText(props: WorkSectionProps): string | null {
    if (props.countMode === 'none') return null;
    if (typeof props.count === 'string') return props.count;
    return props.count === 0 ? null : t('session.subagents.panel.sectionCount', { count: props.count });
}
