import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

import { WorkflowKindCardLabelTrack } from './WorkflowStepDataEditor';
import { useWorkflowDocumentGridStyles, WorkflowDocumentGridContext, workflowEditorStyles } from './workflowEditorStyles';

/** A stacked header's first line (mark, title and sentence, actions); other cards keep their single row. */
function HeaderLine(props: Readonly<{ stacked: boolean; children: React.ReactNode }>): React.ReactElement {
    return props.stacked ? <View style={workflowEditorStyles.kindCardHeaderLine}>{props.children}</View> : <>{props.children}</>;
}

/**
 * The editor's one card (lab `.uwe-kind`, `editor-S6`, round 1115 r16): every step — an Agent step,
 * an Action, a Run a workflow step — and the page's first cards ("When it runs", "How and where it
 * runs") share it. Its header names what it is — mark, name, provenance or a one-line summary — with
 * its actions at the end; its body is the step's prompt or label/value rows (`WorkflowBindingRow`);
 * its foot says what kind of step this is and holds Step options. Owner 2026-11-15: one anatomy, no
 * grey fill — the card is the page's paper inside a hairline edge.
 */
export function WorkflowKindCard(props: Readonly<{
    mark?: React.ReactNode;
    title: string;
    /**
     * The header's identity as a control rather than words: an Agent step's engine chip (round 1116b,
     * quiet while inherited, bordered once the step sets it). `title` stays its accessible name.
     */
    titleControl?: React.ReactNode;
    /** Where it comes from ("Built-in", "Happier", "Discord plugin"). */
    source?: string;
    /** One line under the title saying what the card holds now (a first card's sentence). */
    summary?: React.ReactNode;
    /** The header's actions ("Open ›", "Workflow settings"). */
    headerAction?: React.ReactNode;
    /** What kind of step this is ("Action", "Agent step"); absent with no foot accessory, the card has no foot. */
    note?: string;
    /** The foot's control (Step options). */
    footAccessory?: React.ReactNode;
    /**
     * `false` while the block's heading carries this card's identity (an unnamed block,
     * `resolveWorkflowUnnamedHeading` → `card`): the card is its rows and foot, so the title is said once.
     */
    header?: boolean;
    /** A card that opens and closes on its header (the page's first cards): closed, it is its header alone. */
    disclosure?: Readonly<{ expanded: boolean; onExpandedChange: (expanded: boolean) => void }>;
    children?: React.ReactNode;
    testID: string;
}>): React.ReactElement {
    // One label track for every row of this card: the widest label's natural width (bounded by the
    // row's own min/max), so values start on one column (lab S6).
    const { theme } = useUnistyles();
    const grid = useWorkflowDocumentGridStyles();
    const [trackWidth, setTrackWidth] = React.useState<number | null>(null);
    const reported = React.useRef(new Map<string, number>());
    const track = React.useMemo(() => ({
        width: trackWidth,
        report: (rowKey: string, width: number) => {
            reported.current.set(rowKey, width);
            const widest = Math.ceil(Math.max(...reported.current.values()));
            setTrackWidth((current) => (current === null || widest > current ? widest : current));
        },
    }), [trackWidth]);
    const disclosure = props.disclosure;
    const expanded = disclosure === undefined || disclosure.expanded;
    const hasBody = expanded && props.children !== undefined && props.children !== null;
    const hasFoot = expanded && (props.note !== undefined || props.footAccessory !== undefined);
    // Phones recompose (DESIGN.md): beside a first card's title and sentence only the disclosure caret
    // stays; its wider action ("Workflow settings") moves beneath rather than squeezing the title to an
    // ellipsis (MOBILE-FIX H6). A step card's short "Open ›" keeps its place.
    const compactGrid = React.useContext(WorkflowDocumentGridContext) === 'compact';
    // A card whose wide action can move beneath keeps one stacked header at every width, so crossing the
    // breakpoint only moves the action. The stack is a column, never a wrapped row: iOS measured the
    // wrapped multi-line sentence short and clipped the action under the card edge (QA-WAVE-1115).
    const stacksAction = props.headerAction !== undefined && props.summary !== undefined;
    const actionBelow = stacksAction && compactGrid;
    const caret = disclosure === undefined ? null : (
        <HappierPressable
            testID={`${props.testID}-caret`}
            accessibilityRole="button"
            accessibilityLabel={props.title}
            expanded={expanded}
            onPress={() => disclosure.onExpandedChange(!expanded)}
            style={(state) => [workflowEditorStyles.kindCardCaret,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <DisclosureCaret expanded={expanded} size={14} />
        </HappierPressable>
    );
    // A card that only names what runs it (a resting step) is one line of text: no wrappers to lay out
    // per row in a long workflow (PERF-WF3B).
    const title = <Text testID={`${props.testID}-title`} numberOfLines={1} style={workflowEditorStyles.headingName}>{props.title}</Text>;
    const titleBlock = props.titleControl !== undefined
        ? <View style={workflowEditorStyles.kindCardTitleControl}>{props.titleControl}</View>
        : props.source === undefined && props.summary === undefined ? title : (
        <View style={workflowEditorStyles.kindCardTitleBlock}>
            <View style={workflowEditorStyles.kindCardTitleLine}>
                {title}
                {props.source === undefined ? null
                    : <Text numberOfLines={1} style={workflowEditorStyles.kindCardSource}>{'· '}{props.source}</Text>}
            </View>
            {props.summary === undefined ? null : (
                <Text testID={`${props.testID}-summary`} style={workflowEditorStyles.kindCardSummary}>{props.summary}</Text>
            )}
        </View>
    );
    return (
        <WorkflowKindCardLabelTrack.Provider value={track}>
        {/* In flow on the page's paper: a flat card (DESIGN.md Materials), no glass material. */}
        <View testID={props.testID} style={[workflowEditorStyles.kindCard, workflowEditorStyles.kindCardPaper, grid.blockCard]}>
            {props.header === false ? null : (
                <View style={[workflowEditorStyles.kindCardHeader, props.summary === undefined ? null : workflowEditorStyles.kindCardHeaderTall,
                    stacksAction ? workflowEditorStyles.kindCardHeaderStacked : null,
                    hasBody || hasFoot ? null : workflowEditorStyles.kindCardHeaderAlone]}>
                    <HeaderLine stacked={stacksAction}>
                    {props.mark === undefined ? null
                        : <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.mark}</View>}
                    {disclosure === undefined ? titleBlock : (
                        <HappierPressable
                            testID={`${props.testID}-toggle`}
                            accessibilityRole="button"
                            accessibilityLabel={props.title}
                            expanded={expanded}
                            onPress={() => disclosure.onExpandedChange(!expanded)}
                            style={(state) => [workflowEditorStyles.kindCardToggle,
                                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        >
                            {titleBlock}
                        </HappierPressable>
                    )}
                    {props.headerAction === undefined && disclosure === undefined ? null : (
                        <View style={workflowEditorStyles.headingActions}>
                            {actionBelow ? null : props.headerAction ?? null}
                            {caret}
                        </View>
                    )}
                    </HeaderLine>
                    {actionBelow ? <View style={workflowEditorStyles.kindCardHeaderActionBelow}>{props.headerAction}</View> : null}
                </View>
            )}
            {hasBody ? <View testID={`${props.testID}-body`} style={workflowEditorStyles.kindCardBody}>{props.children}</View> : null}
            {hasFoot ? (
                <View style={workflowEditorStyles.kindCardFoot}>
                    {props.note === undefined ? null : <Text style={workflowEditorStyles.kindCardNote}>{props.note}</Text>}
                    {props.footAccessory ?? null}
                </View>
            ) : null}
        </View>
        </WorkflowKindCardLabelTrack.Provider>
    );
}

/**
 * A page card on the document's grid (the first cards): its mark hangs in the ordinal gutter as a
 * container's does, so the cards and the steps under them share one spine column and one text edge.
 */
export function WorkflowCardGutterRow(props: Readonly<{
    /** The card's mark in the document's number column; `null`: a host with no column draws the card alone. */
    icon: IconName | null;
    children: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const grid = useWorkflowDocumentGridStyles();
    if (props.icon === null) return <View testID={props.testID} style={grid.cardAlone}>{props.children}</View>;
    return (
        <View testID={props.testID} style={grid.blockColumn}>
            <View style={[grid.heading, workflowEditorStyles.cardGutterRow]}>
                <View style={[workflowEditorStyles.ordinalColumn, workflowEditorStyles.cardGutterMark]}
                    accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <View style={workflowEditorStyles.ordinalMark}>
                        <Icon name={props.icon} size={ICON_SIZE.xxs} color={theme.colors.text.secondary} />
                    </View>
                </View>
                <View style={workflowEditorStyles.cardGutterBody}>{props.children}</View>
            </View>
        </View>
    );
}
