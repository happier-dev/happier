import { isHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveAgentInputPanelLayoutStyle } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import type { ThemeStyleScales } from '@/theme/themeStyleScales';

/**
 * The document draws at its lab rhythm under every pointer; text-labelled authoring controls are
 * `HappierPressable`s, whose hit area reaches the finger's target past the drawn box; the between-block
 * inserter is drawn as the document's gap and reached the same way. Only the reveal rule asks the
 * shared pointer owner.
 */

/**
 * Whether the document is under a finger. There is no hover there, so the between-block inserter
 * shows while a block in its list is selected; under a precise pointer it shows on hover or focus only.
 */
export const WORKFLOW_EDITOR_TOUCH_POINTER = isHappierTouchPrimaryPointer(Platform.OS);

/**
 * The document's ordinal column (lab `.uwe-ord`, 22 px): every heading starts with a ring this wide,
 * a container's lanes hang from a rail through its centre, and a nested list starts one column in.
 */
const ORDINAL_SIZE = ICON_SIZE.lg;

/** A lane caption's line: the caption's own type (`rowMeta`), which its tick and caret hang on. */
const LANE_LINE = Number(Typography.variant('meta').lineHeight);

/**
 * The document's grid (lab `editor-E1`, `editor-P1`): every block's ordinal (or a container's kind
 * mark) hangs in a gutter column, and its name, card, "Returns …" and "Only when …" lines share one
 * left edge, the column after it. A nested list starts on its parent's edge, so its ordinals hang
 * from that edge and its rail runs through the parent's mark.
 */
const ordinalColumn = (gap: number) => ORDINAL_SIZE + gap;

/**
 * The document's gutter: from a list's edge to its name column (the ordinal and the gap after it).
 * A page that lines its steps' names up under its title subtracts this from the title's edge.
 */
export const resolveWorkflowDocumentGutterPx = (theme: Pick<ThemeStyleScales, 'space'>): number => ordinalColumn(theme.space.s12);

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
    /** A reading document's note above its first block, on the name column its blocks' words share. */
    listNote: {
        marginBottom: theme.space.s16,
        paddingLeft: ordinalColumn(theme.space.s12),
    },
    /** The root's end row (Add · Start from an example), one gap below the last block. */
    listEnd: {
        paddingTop: theme.space.s20,
    },
    /**
     * The one gap between two blocks (lab `editor-P1`, `editor-E1`): a fixed row on the name column
     * holding, editing, the inserter, and the edge's run-when caption when it is not the default.
     * Its height is the document's rhythm; touch targets inside it overflow evenly into the
     * neighbours' padding instead of growing it (DESIGN-7 M2).
     */
    blockGap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        height: theme.space.s20 + theme.space.s8,
        paddingLeft: ordinalColumn(theme.space.s12),
    },
    /** A non-default run-when ("If it fails", "Either way"): a quiet word on the name column, as the lab's lane captions read. */
    blockGapCaption: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.tertiary,
    },
    /** The inserter takes the rest of the gap's row, so its hairline runs from the caption's end. */
    blockGapInserter: {
        flex: 1,
        minWidth: 0,
    },
    /** A condition's nested arms. */
    nestedList: {
        gap: theme.space.s12,
    },
    /**
     * A container's body (lab `.uwe-cb`): its lists start one ordinal column in, beside a rail that
     * runs through the centre of the container's ordinal. The rail is the structure, not a card.
     */
    containerBody: {
        position: 'relative',
        minWidth: 0,
    },
    containerRail: {
        position: 'absolute',
        left: -(ordinalColumn(theme.space.s12) - ORDINAL_SIZE / 2),
        top: 0,
        bottom: theme.space.s8,
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
        gap: theme.space.s8,
        paddingTop: theme.space.s8,
    },
    laneTick: {
        position: 'absolute',
        top: theme.space.s8 + LANE_LINE / 2,
        left: -(ordinalColumn(theme.space.s12) - ORDINAL_SIZE / 2),
        width: ordinalColumn(theme.space.s12) - ORDINAL_SIZE / 2 - theme.space.s4,
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
        marginLeft: -theme.space.s8,
    },
    /**
     * A heading's trailing consequence select: quiet words and a caret (lab `.uwe-cm`). Its press frame
     * reaches into the gap before it, so when a narrow line wraps it beneath the name its words start
     * on the name column rather than a padding's width inside it.
     */
    trailingControl: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
        marginLeft: -theme.space.s8,
        borderRadius: theme.borderRadius.md,
        flexShrink: 1,
    },
    /** A lane's editable name: the caption's own type, sized to its words. */
    laneLabelInput: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
        minWidth: 0,
        paddingVertical: 0,
    },
    laneLabel: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /**
     * The selected step's plate (lab `editor-L1`, `.uwe-sel`): a quiet ink tint behind its number, card
     * and lines, so the step Step options is editing reads as one object beside the popover. It is
     * absolutely placed, so selecting moves nothing (DESIGN-7 N27), and concentric with the card.
     */
    selectedPlate: {
        position: 'absolute',
        top: -theme.space.s8,
        bottom: -theme.space.s8,
        left: -theme.space.s8,
        right: -theme.space.s8,
        borderRadius: theme.parts.composer.radius + theme.space.s8,
        backgroundColor: theme.colors.surface.selected,
    },
    /** A list item's content on the name column (its ordinal hangs in the gutter): the block, then its "Only when" line. */
    blockColumn: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
        paddingLeft: ordinalColumn(theme.space.s12),
    },
    blockBody: {
        flex: 1,
        gap: theme.space.s8,
    },
    /**
     * A block heading (lab `.uwe-sh`, `.uwe-ch`): ordinal, then the name line, then `⋯`, each on the
     * first line. The name line wraps its trailing consequence beneath it when the row is narrow
     * (07 "Phones recompose": only a short value sits right of a label), so the name is never squeezed.
     */
    heading: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        // The ordinal hangs in the gutter, so the name starts on the column the card and its lines share.
        marginLeft: -ordinalColumn(theme.space.s12),
    },
    /** The ordinal and `⋯` columns, centred on the heading's first line. */
    headingLine: {
        minHeight: ORDINAL_SIZE,
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
        columnGap: theme.space.s8,
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
        paddingHorizontal: theme.space.s4,
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
        ...Typography.variant('meta'),
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
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 3,
        minWidth: 0,
    },
    headingName: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** The block name as the control that selects the block. */
    headingButton: {
        // Its meta measures its own wrap against this box (react-native-web reports a child's layout
        // from its offset parent), so the separator drops only when the meta is really beneath.
        position: 'relative',
        flexDirection: 'row',
        // A narrow line puts the meta beneath the name before either truncates (DESIGN-6 N1 residual).
        flexWrap: 'wrap',
        justifyContent: 'flex-start',
        columnGap: theme.space.s8,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        minHeight: ORDINAL_SIZE,
        alignItems: 'center',
        // A wrapping row packs its lines at the top unless told otherwise; the name line centres on
        // the heading's first line so it reads level with the ordinal and `⋯` (DESIGN-7 N28).
        alignContent: 'center',
        paddingHorizontal: theme.space.s4,
        // The press frame keeps its inset; the words start on the name column.
        marginLeft: -theme.space.s4,
        borderRadius: theme.borderRadius.md,
    },
    /** A leaf's name (no meta, no consequence) takes the whole line, as a field does. */
    headingButtonFill: {
        flexGrow: 1,
    },
    /** The editable name's box is its text; its line is `headingButton`. */
    headingNameInput: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        flexShrink: 1,
        minWidth: 0,
        paddingVertical: theme.space.s4,
    },
    headingActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
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
        gap: theme.space.s8,
    },
    metaText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    metaAction: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    issueText: {
        ...Typography.variant('body'),
        color: theme.colors.text.destructive,
    },
    /**
     * A step's issue lines: one group under its card, ending with the block's own breathing room. A
     * line of text has no edge, so without it the next edge's caption reads as touching the text
     * (DESIGN-9 N48); with it, the caption sits as clear of the text as of a card's border.
     */
    stepIssues: {
        gap: theme.space.s4,
        paddingBottom: theme.space.s4,
    },
    groupSummary: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
    /**
     * An editable step's inputs at rest (its tokens on the footer line): one press target that
     * selects the step, with a reserved border for the ring.
     */
    inputTokensTarget: {
        // A row item of the footer line that still wraps its own tokens at the line's width (phone).
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        borderWidth: 1,
        borderColor: 'transparent',
        borderRadius: theme.borderRadius.sm,
    },
    /** A quiet action on a block's footer line ("Add input", "Add named results"). */
    footAction: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    /** The quiet bordered "+ Add" control at the end of a block list (lab `S1`). */
    addTrigger: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s4,
        borderRadius: theme.borderRadius.md,
        borderColor: theme.colors.border.strong,
    },
    /**
     * The between-block inserter: a hairline with a centred (+), revealed on hover, focus or
     * selection (04 §4.3). It IS the gap between two blocks, never an extra row inside one, drawn
     * at the same gap under every pointer; a finger reaches it by hit area (lab `editor-P1`).
     */
    inserter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minHeight: theme.space.s20,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    /**
     * The inserter's place in the list: one `margins.xl` gap. A finger's hit area reaches past it into
     * its neighbours, so it sits above them.
     */
    inserterSlot: {
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
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    /**
     * A typed step's card (lab `.uwe-kind`, `editor-S6`): an Action or a Run a workflow step in the
     * same frame as the document's composer card — its radius and hairline — with a header, its
     * label/value rows and its foot.
     */
    kindCard: {
        ...resolveAgentInputPanelLayoutStyle(theme),
        paddingTop: 0,
        paddingBottom: 0,
        paddingHorizontal: 0,
        minWidth: 0,
    },
    /** The card's header (lab `.uwe-khd`): mark, name, provenance, then its one action. */
    kindCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: theme.space.s24 + theme.space.s16,
        paddingHorizontal: theme.space.s12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    kindCardSource: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /** Its label/value rows (lab `.uwe-kb`). */
    kindCardBody: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s4,
        // Pairs breathe apart while a label and its value stay together (DESIGN-6 N5).
        gap: theme.space.s8,
        minWidth: 0,
    },
    kindCardFoot: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        justifyContent: 'space-between',
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s8,
        // The foot's words sit as far from the bottom border as from the side (lab S6, DESIGN-7 N30).
        paddingBottom: theme.space.s12,
    },
    kindCardNote: {
        ...Typography.variant('meta'),
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
        columnGap: theme.space.s12,
        rowGap: 0,
        paddingVertical: theme.space.s4,
        minWidth: 0,
        // Reserved so a pair that is a press target paints the shared focus ring without moving.
        borderWidth: 1,
        borderColor: 'transparent',
        borderRadius: theme.borderRadius.md,
    },
    /** The label track: the lab's 120 px column, growing to the label's words before it wraps. */
    actionFieldLabelColumn: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: theme.space.s4,
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
    /** The label reads at the value's size, quiet (lab S6 `.uwe-kr`), so a card keeps the prompt cards' rhythm. */
    actionFieldLabel: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.secondary,
    },
    /** "Required" on an unset field: a quiet marker on the label's line, not a second label. */
    actionFieldMarker: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    /** A bound literal as the document reads it. */
    actionFieldText: {
        ...Typography.variant('body'),
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
        gap: theme.space.s8,
        paddingVertical: theme.space.s4,
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
        ...Typography.variant('label', 'regular'),
        ...Typography.tabular(),
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.surface,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        minWidth: 72,
        flexGrow: 1,
        flexBasis: 160,
        maxWidth: '100%',
    },
    /** A count is a few digits: the field sizes to them instead of stretching across the row. */
    numberValue: {
        flexGrow: 0,
        flexBasis: 'auto',
    },
}));
