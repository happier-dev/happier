import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveAgentInputPanelLayoutStyle } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';

/**
 * Text-labelled authoring controls cannot declare a square the way
 * `IconButton` does, so under a finger they take the canonical platform target
 * as a real minimum height. `hitSlop` is not an option: react-native-web's
 * `Pressable` never reads it and the desktop app IS the web bundle, so a
 * slop-declared target there is a target that does not exist. Growth is on the
 * free vertical axis, so wrapping chip rows still meet at their gap rather than
 * overlapping. A precise pointer keeps the document's dense rhythm (the shared
 * touch-floor policy, `resolveTouchTargetFloorPx`), so headings, footers and
 * the between-block gap sit at the lab's spacing on desktop.
 */
const TOUCH_TARGET_FLOOR = resolveTouchTargetFloorPx(Platform.OS) ?? undefined;

/**
 * Whether the document is under a finger. There is no hover there, so the between-block inserter
 * shows while a block in its list is selected; under a precise pointer it shows on hover or focus only.
 */
export const WORKFLOW_EDITOR_TOUCH_POINTER = TOUCH_TARGET_FLOOR !== undefined;

/**
 * The document's ordinal column (lab `.uwe-ord`, 22 px): every heading starts with a ring this wide,
 * a container's lanes hang from a rail through its centre, and a nested list starts one column in.
 */
const ORDINAL_SIZE = ICON_SIZE.lg;

/** A lane caption's line: the caption's own type (`rowMeta`), which its tick and caret hang on. */
const LANE_LINE = Number(Typography.rowMeta().lineHeight);

/** A heading's first line: the touch floor under a finger, else the ordinal ring's own height. */
const HEADING_LINE = TOUCH_TARGET_FLOOR ?? ORDINAL_SIZE;

/**
 * Shared editor rhythm.
 *
 * The execution rail — one quiet leading hairline that connects ordered work and
 * folds into a group summary — is this feature's visual signature. Structure is
 * carried by whitespace, alignment and that rail rather than by nesting a card
 * inside a card. Colors, type and spacing use shared tokens; widths express the
 * document's label/value columns. This module owns no interaction or focus policy.
 */
export const workflowEditorStyles = StyleSheet.create((theme) => ({
    /**
     * The real press frame for a text-labelled authoring control. Its border is
     * reserved (transparent) so the shared focus ring (`focusRingStyle`) can
     * paint it without moving layout.
     */
    actionTarget: {
        minHeight: TOUCH_TARGET_FLOOR,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'transparent',
    },
    /**
     * One ordered list at any depth. Its rhythm is the separator between blocks (the inserter when
     * editing, `blockGap` when reading), so a hidden inserter never stacks on top of a gap.
     */
    blockList: {
        minWidth: 0,
    },
    /** A reading document's note above its first block. */
    listNote: {
        marginBottom: theme.margins.lg,
    },
    /** The root's end row (Add · Start from an example), one gap below the last block. */
    listEnd: {
        paddingTop: theme.margins.xl,
    },
    /**
     * The one gap between two blocks (lab `editor-P1`, `editor-E1`): a fixed row holding the edge's
     * run-when caption and, editing, the inserter. Its height is the document's rhythm; touch targets
     * inside it overflow evenly into the neighbours' padding instead of growing it (DESIGN-7 M2).
     */
    blockGap: {
        flexDirection: 'row',
        alignItems: 'center',
        height: theme.margins.xl + theme.margins.sm,
    },
    /**
     * The caption's place on the name column. The run-when control carries its own trailing margin
     * (its standalone placement); cancelling it here centres the caption in the gap.
     */
    blockGapCaption: {
        marginBottom: -theme.margins.sm,
    },
    /** The inserter takes the rest of the gap's row, so its hairline runs from the caption's end. */
    blockGapInserter: {
        flex: 1,
        minWidth: 0,
    },
    /** A condition's nested arms. */
    nestedList: {
        gap: theme.margins.md,
    },
    /**
     * A container's body (lab `.uwe-cb`): its lists start one ordinal column in, beside a rail that
     * runs through the centre of the container's ordinal. The rail is the structure, not a card.
     */
    containerBody: {
        position: 'relative',
        paddingLeft: ORDINAL_SIZE + theme.margins.sm,
        minWidth: 0,
    },
    containerRail: {
        position: 'absolute',
        left: ORDINAL_SIZE / 2,
        top: 0,
        bottom: theme.margins.sm,
        borderLeftWidth: 1,
        borderColor: theme.colors.border.default,
    },
    /** An If's branches hang from a dashed rail (lab `.uwe-ctr.if`): they may not run. */
    containerRailConditional: {
        borderStyle: 'dashed',
    },
    /**
     * One lane's label on the tree line (lab `.uwe-ll`): a tick from the rail, then its name, then its
     * caret. The tick and caret hang on the name's first line, so a long name that wraps keeps them
     * level with its first words (DESIGN-7 M1 d).
     */
    laneLabelRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.margins.sm,
        paddingTop: theme.margins.sm,
    },
    laneTick: {
        position: 'absolute',
        top: theme.margins.sm + LANE_LINE / 2,
        left: -(ORDINAL_SIZE / 2 + theme.margins.sm),
        width: ORDINAL_SIZE / 2 + theme.margins.sm - theme.margins.xs,
        borderTopWidth: 1,
        borderColor: theme.colors.border.default,
    },
    laneTickConditional: {
        borderStyle: 'dashed',
    },
    /**
     * The lane's caret, centred on the name's first line and pulled in by the row gap, so its glyph
     * follows the words (its button's own inset is the space between them).
     */
    laneCaret: {
        height: LANE_LINE,
        justifyContent: 'center',
        marginLeft: -theme.margins.sm,
    },
    /** A heading's trailing consequence select: quiet words and a caret (lab `.uwe-cm`). */
    trailingControl: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        paddingHorizontal: theme.margins.sm,
        minWidth: TOUCH_TARGET_FLOOR,
        borderRadius: theme.borderRadius.md,
        flexShrink: 1,
    },
    /** A lane's editable name: the caption's own type, sized to its words. */
    laneLabelInput: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
        minWidth: 0,
        paddingVertical: 0,
    },
    laneLabel: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /** A list item's content beside its rail: the block, then its "Only when" line. */
    blockColumn: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: theme.margins.xs,
    },
    blockBody: {
        flex: 1,
        gap: theme.margins.sm,
    },
    /**
     * A block heading (lab `.uwe-sh`, `.uwe-ch`): ordinal, then the name line, then `⋯`, each on the
     * first line. The name line wraps its trailing consequence beneath it when the row is narrow
     * (07 "Phones recompose": only a short value sits right of a label), so the name is never squeezed.
     */
    heading: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.margins.sm,
    },
    /** The ordinal and `⋯` columns, centred on the heading's first line. */
    headingLine: {
        minHeight: HEADING_LINE,
        justifyContent: 'center',
    },
    /** The name with its meta, then the trailing consequence (wrapping beneath when the row is narrow). */
    headingMain: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: theme.margins.sm,
    },
    /** The invisible copy that sizes an editable name to its text, so its meta follows it (E1). */
    headingNameMeasure: {
        position: 'absolute',
        top: 0,
        left: 0,
        opacity: 0,
    },
    /** The circled ordinal (lab `.uwe-ord`); a stable width keeps renumbering from moving the prompt edge. */
    ordinal: {
        minWidth: ORDINAL_SIZE,
        height: ORDINAL_SIZE,
        borderRadius: ORDINAL_SIZE / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        paddingHorizontal: theme.margins.xs,
        alignItems: 'center',
        justifyContent: 'center',
    },
    /** A container's kind mark in the ordinal column, the ring's size so the column stays aligned. */
    ordinalMark: {
        width: ORDINAL_SIZE,
        height: ORDINAL_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    /** The selected block's ordinal fills with ink (lab `.uwe-sel .uwe-ord`). */
    ordinalSelected: {
        backgroundColor: theme.colors.text.primary,
        borderColor: theme.colors.text.primary,
    },
    ordinalText: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    ordinalTextSelected: {
        color: theme.colors.surface.base,
    },
    /** A heading's quiet facts beside its name (lab `.uwe-ch .tx`: "Side by side · 3 lanes"). */
    /** The meta yields first when the line is short: the name keeps its words (N1). */
    headingMeta: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        flexShrink: 3,
        minWidth: 0,
    },
    headingName: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** The block name as the control that selects the block. */
    headingButton: {
        flexDirection: 'row',
        // A narrow line puts the meta beneath the name before either truncates (DESIGN-6 N1 residual).
        flexWrap: 'wrap',
        justifyContent: 'flex-start',
        columnGap: theme.margins.sm,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        minHeight: HEADING_LINE,
        alignItems: 'center',
        // A wrapping row packs its lines at the top unless told otherwise; the name line centres on
        // the heading's first line so it reads level with the ordinal and `⋯` (DESIGN-7 N28).
        alignContent: 'center',
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.md,
    },
    /** A leaf's name (no meta, no consequence) takes the whole line, as a field does. */
    headingButtonFill: {
        flexGrow: 1,
    },
    /** The editable name's box is its text; its line (`headingButton`) carries the touch floor. */
    headingNameInput: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
        minWidth: 0,
        paddingVertical: theme.margins.xs,
    },
    headingActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        marginLeft: 'auto',
    },
    // The canonical composer owns the prompt field's own chrome and focus
    // treatment; this frame only positions it inside the step row.
    promptFrame: {
        position: 'relative',
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.margins.sm,
    },
    metaText: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    metaAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    issueText: {
        ...Typography.default('regular'),
        color: theme.colors.text.destructive,
    },
    /**
     * A step's issue lines: one group under its card, ending with the block's own breathing room. A
     * line of text has no edge, so without it the next edge's caption reads as touching the text
     * (DESIGN-9 N48); with it, the caption sits as clear of the text as of a card's border.
     */
    stepIssues: {
        gap: theme.margins.xs,
        paddingBottom: theme.margins.xs,
    },
    /** A compound condition's arms under its lead: one indented line each, on a hairline. */
    conditionArms: {
        gap: theme.margins.xs,
        paddingLeft: theme.margins.md,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
    },
    groupSummary: {
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    /** A quiet action on a block's footer line ("Add input", "Add named results"). */
    footAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    /** The quiet bordered "+ Add" control at the end of a block list (lab `S1`). */
    addTrigger: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.xs,
        borderRadius: theme.borderRadius.md,
        borderColor: theme.colors.border.strong,
    },
    /**
     * The between-block inserter: a hairline with a centred (+), revealed on hover, focus or
     * selection (04 §4.3). It IS the gap between two blocks, never an extra row inside one: a
     * precise pointer gets the reading document's `blockGap`, a finger the platform target, so a
     * hidden inserter adds no empty space on a phone (lab `editor-P1`).
     */
    inserter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        minHeight: TOUCH_TARGET_FLOOR ?? theme.margins.xl,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    /**
     * The inserter's place in the list: one `margins.xl` gap. Under a finger its 44–48 px target
     * overlaps half of the difference into each neighbour, so the visible rhythm matches the desktop
     * and lab P1 (DESIGN-6 M2) instead of stacking the target as empty space.
     */
    inserterSlot: {
        marginVertical: TOUCH_TARGET_FLOOR === undefined ? 0 : -(TOUCH_TARGET_FLOOR - theme.margins.xl) / 2,
        zIndex: 1,
    },
    inserterHidden: {
        opacity: 0,
    },
    inserterLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    addLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    /**
     * A typed step's card (lab `.uwe-kind`, `editor-S6`): an Action or a Run a workflow step in the
     * same frame as the document's composer card — its radius and hairline — with a header, its
     * label/value rows and its foot.
     */
    kindCard: {
        ...resolveAgentInputPanelLayoutStyle(theme, true),
        paddingTop: 0,
        paddingBottom: 0,
        paddingHorizontal: 0,
        backgroundColor: theme.colors.surface.base,
        minWidth: 0,
    },
    /** The card's header (lab `.uwe-khd`): mark, name, provenance, then its one action. */
    kindCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        minHeight: TOUCH_TARGET_FLOOR ?? theme.margins.xxl + theme.margins.lg,
        paddingHorizontal: theme.margins.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    kindCardSource: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /** Its label/value rows (lab `.uwe-kb`). */
    kindCardBody: {
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.xs,
        // Pairs breathe apart while a label and its value stay together (DESIGN-6 N5).
        gap: theme.margins.sm,
        minWidth: 0,
    },
    kindCardFoot: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.margins.sm,
        justifyContent: 'space-between',
        paddingLeft: theme.margins.md,
        paddingRight: theme.margins.sm,
        // The foot's words sit as far from the bottom border as from the side (lab S6, DESIGN-7 N30).
        paddingBottom: theme.margins.md,
    },
    kindCardNote: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /** A label column beside its binding; the binding moves beneath the label when the card is narrow. */
    /**
     * One label/value row (lab `.uwe-kr`: a label track, then the value, about 28 px a row). A narrow
     * card moves the value beneath its label with no gap inside the pair; rows keep their own gap
     * (`kindCardBody`), so a phone reads pairs, not an alternating list (DESIGN-5 N5).
     */
    actionFieldRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        // A label reads level with its value, not above or below it (lab S6).
        alignItems: 'center',
        columnGap: theme.margins.md,
        rowGap: 0,
        paddingVertical: theme.margins.xs,
        minWidth: 0,
        // Reserved so a pair that is a press target paints the shared focus ring without moving.
        borderWidth: 1,
        borderColor: 'transparent',
        borderRadius: theme.borderRadius.md,
    },
    /** A switch row in a card (Notify me's "Only if the agent reported something"): words, then the switch. */
    kindCardToggleRow: {
        flexWrap: 'nowrap',
    },
    kindCardToggleText: {
        flex: 1,
        minWidth: 0,
        gap: theme.margins.xs,
    },
    /** A pair that is one press target ("+ Set", a default, a value to edit) keeps the touch floor. */
    actionFieldRowTarget: {
        minHeight: TOUCH_TARGET_FLOOR,
    },
    /** The label track: the lab's 120 px column, growing to the label's words before it wraps. */
    actionFieldLabelColumn: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: theme.margins.xs,
        minWidth: 120,
        maxWidth: '45%',
        flexShrink: 0,
    },
    actionFieldValue: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    actionFieldLabel: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    /** "Required" on an unset field: a quiet marker on the label's line, not a second label. */
    actionFieldMarker: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
    /** A bound literal as the document reads it. */
    actionFieldText: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
    },
    /**
     * One binding's controls. They wrap at the pane edge rather than running past it
     * (the width contract, 07 §3): the source select, then its value.
     */
    inlineControl: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.margins.sm,
        paddingVertical: theme.margins.xs,
        minWidth: 0,
        maxWidth: '100%',
    },
    /** A consumer-drawn literal field on a binding's line: it takes the line's free width. */
    inlineLiteral: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 160,
        minWidth: 0,
        maxWidth: '100%',
    },
    /** A result's optional field path: the token's "· field" part, sized to it rather than a row-wide box. */
    pathValue: {
        flexGrow: 0,
        flexBasis: 'auto',
    },
    referenceSelect: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    inlineValue: {
        ...Typography.default('regular'),
        ...Typography.tabular(),
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.surface,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: theme.margins.xs,
        minWidth: 72,
        flexGrow: 1,
        flexBasis: 160,
        maxWidth: '100%',
    },
}));
