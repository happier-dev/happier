import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { resolveAgentInputPanelLayoutStyle } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE, MULTI_TEXT_INPUT_BASE_LINE_HEIGHT } from '@/components/ui/forms/multiTextInputTypography';
import { HAPPIER_FILTER_CHIP_METRICS, HAPPIER_PAGE_METRICS, HAPPIER_SEGMENTED_METRICS } from '@happier-dev/plugin-ui/presentation';

/**
 * The document draws at its lab rhythm under every pointer; text-labelled authoring controls are
 * `HappierPressable`s, whose hit area reaches the finger's target past the drawn box; the between-block
 * inserter is drawn as the document's gap and reached the same way. Only the reveal rule asks the
 * shared pointer owner.
 */

/**
 * The document's ordinal column (lab `.uwe-ord`, 22 px): every heading starts with a ring this wide,
 * a container's lanes hang from a rail through its centre, and a nested list starts one column in.
 */
const ORDINAL_SIZE = ICON_SIZE.lg;

/** A lane caption's line: the caption's own type (`rowMeta`), which its fork and caret hang on. */
const LANE_LINE = Number(Typography.variant('meta').lineHeight);

/**
 * A chip's content inset (the filter chip's padding plus its 1 px border). A card's chip rows hang their chips out by
 * it, so a chip's words start on the card's text edge as the prompt's do (lab round 1116b bstep-v-A).
 */
const CHIP_CONTENT_INSET = HAPPIER_FILTER_CHIP_METRICS.paddingHorizontalPx + 1;
/** The spine's stroke: a hairline-weight line that still reads at a glance. */
const SPINE_WIDTH = 1;

/** The radius of the spine's bends where a lane forks off and joins back (lab round 1106 F1). */
const LANE_BEND = 8;

/**
 * The document's grid (lab `editor-E1`, `editor-P1`): every block's ordinal (or a container's kind
 * mark) hangs in a gutter column, and its name, card, "Returns …" and "Only when …" lines share one
 * left edge, the column after it. A nested list starts on its parent's edge, so its ordinals hang
 * from that edge and its rail runs through the parent's mark.
 */
/** A Workflow page's title edge from its column: the text inset, the header's mark and the gap after it. */
export const WORKFLOW_PAGE_TITLE_EDGE_PX = HAPPIER_PAGE_METRICS.pageTextInsetPx
    + HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx + HAPPIER_PAGE_METRICS.pageHeaderMarkGapPx;

/**
 * Ordinal → name. Derived so that with names on the title's edge, an ordinal is centred under the
 * header's mark: one axis for the page's marks and one edge for its words (lab round 1105 P1).
 */
export const WORKFLOW_ORDINAL_GAP_PX = HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx / 2
    + HAPPIER_PAGE_METRICS.pageHeaderMarkGapPx - ORDINAL_SIZE / 2;

/**
 * The mark edge (owner 2026-11-06): where the header's mark, the step marks and the page's controls
 * (selectors, view tabs) start, so the header and the steps share one left edge; words keep the title edge.
 */
export const WORKFLOW_PAGE_MARK_EDGE_PX = HAPPIER_PAGE_METRICS.pageTextInsetPx
    + HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx / 2 - ORDINAL_SIZE / 2;

/**
 * The editor's view tabs (lab rounds 1116b and 1116c): the first tab's glyph on the title's edge, its plain press
 * frame hanging into the gutter as a chip's does, so the title, the tabs and the cards read down one edge.
 */
export const WORKFLOW_PAGE_TABS_EDGE_PX = WORKFLOW_PAGE_TITLE_EDGE_PX - HAPPIER_SEGMENTED_METRICS.plain.paddingHorizontalPx;

/** The document's gutter: from a list's edge to its name column (the ordinal and the gap after it). */
export const WORKFLOW_DOCUMENT_GUTTER_PX = ORDINAL_SIZE + WORKFLOW_ORDINAL_GAP_PX;

/** Where a list hangs so its names land on the title's edge and its ordinals under the mark. */
export const WORKFLOW_DOCUMENT_INSET_PX = WORKFLOW_PAGE_TITLE_EDGE_PX - WORKFLOW_DOCUMENT_GUTTER_PX;

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
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
    },
    /** The root's end row (Add · Start from an example), one gap below the last block, on the name column. */
    listEnd: {
        paddingTop: theme.space.s20,
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
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
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
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
    /** A container's body (lab `.uwe-cb`): its lanes, one ordinal column in. */
    containerBody: {
        position: 'relative',
        minWidth: 0,
    },
    /**
     * The spine (lab round 1106 F1): one line through the ordinal column joining a block's mark to the
     * next block's, at every depth, so the steps read as one flow rather than separate islands. It runs
     * from under this block's mark through the gap below it and stops at the next mark's edge, so no
     * mark needs a fill to hide it (the page may be glass).
     */
    spineSegment: {
        position: 'absolute',
        left: ORDINAL_SIZE / 2 - SPINE_WIDTH / 2,
        top: ORDINAL_SIZE,
        borderLeftWidth: SPINE_WIDTH,
        borderColor: theme.colors.border.strong,
    },
    /** To the next block's mark: through the one gap between them (`blockGap`). */
    spineToNext: {
        bottom: -(theme.space.s20 + theme.space.s8),
    },
    /** A lane's last block, or a list's last container: to the block's own end. */
    spineToEnd: {
        bottom: 0,
    },
    /** Through a whole row on the spine's way (the root's end row, on the way to the Result). */
    spineAcross: {
        top: 0,
        bottom: 0,
    },
    /** A lane's last block while editing: past the lane's end inserter, to where the lane joins back. */
    spineToEndPastInserter: {
        bottom: -theme.space.s20,
    },
    /**
     * On a phone a block's card runs under its number (`blockCard`), so its spine leaves from the
     * block's end rather than from under the mark: it links the block to the next mark through the gap.
     */
    spineFromBlockEnd: {
        top: '100%',
    },
    /**
     * One lane's label (lab `.uwe-ll`, round 1106 F1): on the lane's name column, with the lane
     * forking off its container's spine beside it. The caret hangs on the name's first line, so a long
     * name that wraps keeps it level with its first words (DESIGN-7 M1 d).
     */
    laneLabelRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        paddingTop: theme.space.s8,
        // The lane's first block may be selected: its plate reaches one s8 above the block, and the
        // name stays clear of it rather than sitting on its edge.
        paddingBottom: theme.space.s8,
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
    },
    /**
     * The fork: from the container's spine, bending into the lane's line at the label's first line.
     * With `laneLead` it is one S-bend from the container's mark column to the lane's.
     */
    laneFork: {
        position: 'absolute',
        top: theme.space.s8 + LANE_LINE / 2 - LANE_BEND,
        left: -(WORKFLOW_DOCUMENT_GUTTER_PX - ORDINAL_SIZE / 2) - SPINE_WIDTH / 2,
        width: WORKFLOW_DOCUMENT_GUTTER_PX - LANE_BEND,
        height: LANE_BEND + SPINE_WIDTH,
        borderLeftWidth: SPINE_WIDTH,
        borderBottomWidth: SPINE_WIDTH,
        borderBottomLeftRadius: LANE_BEND,
        // The bends are quieter than the spine, so the flow reads first and nesting does not shout (owner 2026-11-06).
        borderColor: theme.colors.border.subtle,
    },
    /** The lane's line from the fork down to its first block's mark. */
    laneLead: {
        position: 'absolute',
        top: theme.space.s8 + LANE_LINE / 2,
        left: ORDINAL_SIZE / 2 - LANE_BEND - SPINE_WIDTH / 2,
        width: LANE_BEND + SPINE_WIDTH,
        bottom: 0,
        borderTopWidth: SPINE_WIDTH,
        borderRightWidth: SPINE_WIDTH,
        borderTopRightRadius: LANE_BEND,
        // The bends are quieter than the spine, so the flow reads first and nesting does not shout (owner 2026-11-06).
        borderColor: theme.colors.border.subtle,
    },
    /** Where a lane joins back: its line bends from its mark column into the container's spine. */
    /** A loop's "goes round again" line, at the end of its lane (lab round 1106 F1 `.f1-turn`): words on the blocks' edge, its mark in their ordinal column. */
    laneTurn: {
        paddingTop: theme.space.s12,
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
    },
    laneTurnMark: {
        position: 'absolute',
        top: theme.space.s12,
        left: 0,
        width: ORDINAL_SIZE,
        alignItems: 'center',
    },
    laneJoin: {
        height: theme.space.s12,
    },
    laneJoinBend: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: -(WORKFLOW_DOCUMENT_GUTTER_PX - ORDINAL_SIZE / 2) - SPINE_WIDTH / 2,
        width: WORKFLOW_DOCUMENT_GUTTER_PX + SPINE_WIDTH,
        borderRightWidth: SPINE_WIDTH,
        borderBottomWidth: SPINE_WIDTH,
        borderBottomRightRadius: LANE_BEND,
        // The bends are quieter than the spine, so the flow reads first and nesting does not shout (owner 2026-11-06).
        borderColor: theme.colors.border.subtle,
    },
    /** A lane's label that opens what it states (an If's condition): its words, with a press frame. */
    laneLabelButton: {
        flexShrink: 1,
        minWidth: 0,
        paddingHorizontal: theme.space.s4,
        marginLeft: -theme.space.s4,
        borderRadius: theme.borderRadius.md,
    },
    /** A lane's end inserter, on the name column like every gap's, so it never crosses the lane's line. */
    laneEndInserter: {
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
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
    /** A list item's content on the name column (its ordinal hangs in the gutter): the block, then its "Only when" line. */
    blockColumn: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
        paddingLeft: WORKFLOW_DOCUMENT_GUTTER_PX,
    },
    blockBody: {
        flex: 1,
        gap: theme.space.s8,
    },
    /**
     * A block's heading and the card under it, while it is edited: the same gap as its summary row at rest
     * (`summaryBody`), so opening a step does not move its card (WF-ACCEPT-1119B fix 8).
     */
    blockHead: {
        gap: theme.space.s2,
    },
    /** A block's card (an Agent step's composer, a typed step's card): on the name column on the wide grid. */
    blockCard: {
        minWidth: 0,
    },
    /** A card drawn with no number column (`WorkflowCardGutterRow` without a mark): on its host's edge. */
    cardAlone: {
        minWidth: 0,
    },
    /**
     * A block heading (lab `.uwe-sh`, `.uwe-ch`): ordinal, then the name line, then `⋯`, each on the
     * first line. The name line wraps its trailing consequence beneath it when the row is narrow
     * (07 "Phones recompose": only a short value sits right of a label), so the name is never squeezed.
     */
    heading: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: WORKFLOW_ORDINAL_GAP_PX,
        // The ordinal hangs in the gutter, so the name starts on the column the card and its lines share.
        marginLeft: -WORKFLOW_DOCUMENT_GUTTER_PX,
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
    /**
     * The ordinal column keeps the ring's width; a wider number ("10", "250") grows its ring into the
     * gutter, so the name never moves off the column the block's prompt and lines share.
     */
    ordinalColumn: {
        width: ORDINAL_SIZE,
        alignItems: 'flex-end',
    },
    /**
     * A container's kind mark in the ordinal column: the same ring as a step's number (lab round 1106
     * F1), so every block on the spine is one kind of node.
     */
    ordinalMark: {
        width: ORDINAL_SIZE,
        height: ORDINAL_SIZE,
        borderRadius: ORDINAL_SIZE / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
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
    /** An unnamed leaf's kind label when it can't be edited: quiet, not a disabled-looking placeholder. */
    headingNamePlaceholder: {
        color: theme.colors.text.secondary,
    },
    /** An unnamed block's name field while a sentence is its title: reachable from the keyboard, taking no room. */
    headingNameCollapsed: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
    },
    /** A summarised prompt block (lab S1): its heading with the prompt line close beneath it. */
    summaryBody: {
        flex: 1,
        gap: theme.space.s2,
    },
    /** The summary's lines under its heading, one target that opens the block. */
    summaryPress: {
        gap: theme.space.s2,
    },
    /** A summarised prompt block's first prompt line (lab S1), on the name column. */
    /** A prompt at rest reads in the composer's own type, so opening it to edit changes nothing (WF-ACCEPT-1118 item 7). */
    summaryPrompt: {
        ...Typography.variant('reading'),
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
        lineHeight: MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
        color: theme.colors.text.primary,
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
        // The name's line box is the ordinal's, so the number centres on the name (owner 25: it sat high).
        paddingVertical: Math.max(0, (ORDINAL_SIZE - Number(Typography.variant('heading').lineHeight)) / 2),
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
        flexShrink: 1,
    },
    // A quiet foot row ("18 more settings ▾") gives way to a narrow card: its words wrap instead of running past the edge.
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 1,
        minWidth: 0,
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
        // In flow on the page's paper: the flat ink edge (DESIGN.md Materials), never the composer's
        // glass rim, which reads near-white on a light page now the card has no grey fill.
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
        paddingTop: 0,
        paddingBottom: 0,
        paddingHorizontal: 0,
        minWidth: 0,
    },
    kindCardPaper: {
        backgroundColor: theme.colors.surface.base,
    },
    /** The card's header (lab `.uwe-khd`): mark, name, provenance, then its one action. */
    kindCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: theme.space.s24 + theme.space.s16,
        // The card inset is the text edge (round 1116 alignment system): a sheet row's inset.
        paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    /** A page card beside its gutter mark (`WorkflowCardGutterRow`): the card takes the name column's width. */
    cardGutterRow: {
        alignItems: 'flex-start',
        position: 'relative',
    },
    /**
     * A first card's part of the spine (lab round 1116b): from under its mark, across the 16 px between the page's
     * rows, to the next mark: the next card's sits 12 px into its row, a step's at its row's top.
     */
    cardSpine: {
        position: 'absolute',
        left: ORDINAL_SIZE / 2 - SPINE_WIDTH / 2,
        top: theme.space.s12 + ORDINAL_SIZE,
        borderLeftWidth: SPINE_WIDTH,
        borderColor: theme.colors.border.strong,
    },
    cardSpineToCard: {
        bottom: -(theme.space.s16 + theme.space.s12),
    },
    cardSpineToSteps: {
        bottom: -theme.space.s16,
    },
    /** The mark sits level with the card's title line. */
    cardGutterMark: {
        paddingTop: theme.space.s12,
    },
    cardGutterBody: {
        flex: 1,
        minWidth: 0,
    },
    /** A first card's header carries its sentence under the title (lab r16 "When it runs"). */
    kindCardHeaderTall: {
        alignItems: 'flex-start',
        paddingVertical: theme.space.s12,
    },
    /** A header whose wider action can move beneath: a column of its first line and, on phones, that action. */
    kindCardHeaderStacked: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: theme.space.s4,
    },
    /** The stacked header's first line: the same row a single-line header is. */
    kindCardHeaderLine: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    /** The header action on its own line, starting on the title's edge. */
    kindCardHeaderActionBelow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    /** Closed, the card is its header alone: no rule under it. */
    kindCardHeaderAlone: {
        borderBottomWidth: 0,
    },
    kindCardTitleBlock: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    kindCardTitleLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    kindCardSummary: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    kindCardToggle: {
        flex: 1,
        minWidth: 0,
        borderRadius: theme.borderRadius.sm,
    },
    kindCardCaret: {
        padding: theme.space.s4,
        borderRadius: theme.borderRadius.sm,
    },
    kindCardSource: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    /** A header whose identity is a control (an Agent step's engine chip): it takes the line, the actions follow. */
    kindCardTitleControl: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: -CHIP_CONTENT_INSET,
    },
    /** An Agent step's foot (round 1116b, step options A): its changed chips, then "…" at the trailing edge. */
    stepOptionChips: {
        flex: 1,
        flexDirection: 'row',
        // When the chips wrap, "…" stays on their first line.
        alignItems: 'flex-start',
        gap: theme.space.s8,
        minWidth: 0,
        marginLeft: -CHIP_CONTENT_INSET,
    },
    stepOptionChipList: {
        flex: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
    },
    /** The Session chips' own wrapping row, held to its line so a phone wraps them instead of clipping (WF-ACCEPT-1118 item 4). */
    stepSessionChipGroup: {
        maxWidth: '100%',
        flexShrink: 1,
        minWidth: 0,
    },
    /** A Workspace or changed-option chip's anchor, held to the row so a long value ellipsizes instead of running past the card. */
    stepChipAnchor: {
        maxWidth: '100%',
        flexShrink: 1,
        minWidth: 0,
    },
    /** Its label/value rows (lab `.uwe-kb`). */
    kindCardBody: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx,
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
        paddingLeft: HAPPIER_PAGE_METRICS.cardPaddingPx,
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
    /** The label track: the lab's column; its words wrap inside it. */
    actionFieldLabelColumn: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: theme.space.s4,
        // The lab's column where the row has it (its basis, scaled with the text, comes from WorkflowFieldPair);
        // a card narrower than that gives the label the card's width and its words wrap there (a phone at a
        // large text size cut "Required" at the card's edge).
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
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
    /** A row's helper: its own line under the label and control, from the label's edge to the row's (`WorkflowFieldPair` `note`). */
    actionFieldNoteLine: {
        flexBasis: '100%',
        gap: theme.space.s2,
        paddingTop: theme.space.s4,
        minWidth: 0,
    },
    /** The helper's words: quiet, at the meta size. */
    actionFieldNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
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
        // An authored value takes its row's width and breaks a long token (an id, a marker) inside it, rather
        // than holding its longest word's width past the card's edge.
        flexShrink: 1,
        minWidth: 0,
    },
    /**
     * One binding's controls. They wrap at the pane edge rather than running past it
     * (the width contract, 07 §3): the source select, then its value.
     */
    /** One condition rule, read as a sentence; it wraps between its words, never inside one. */
    conditionRule: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
        minWidth: 0,
    },
    conditionGroup: {
        gap: theme.space.s8,
        alignItems: 'flex-start',
    },
    /** A nested group hangs from a rail, as the document's containers do. */
    conditionNested: {
        borderLeftWidth: 1,
        borderColor: theme.colors.border.default,
        paddingLeft: theme.space.s12,
    },
    conditionLead: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    /** A chosen value, as the reference token the sentence will show. */
    valuePicker: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
        paddingHorizontal: theme.space.s8,
        borderRadius: theme.borderRadius.md,
        maxWidth: '100%',
    },
    valuePickerUnset: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
    },
    valuePickerLabel: {
        ...Typography.variant('body', 'medium'),
        flexShrink: 1,
    },
    /** Sized like its neighbours, so a rule stays one line where the width allows. */
    conditionLiteral: {
        flexGrow: 0,
        flexBasis: 'auto',
        width: 104,
    },
    conditionHint: {
        marginTop: theme.space.s8,
    },
    /** Remove sits at the rule's end, never between its words. */
    conditionRemove: {
        marginLeft: 'auto',
    },
    inlineControl: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        paddingVertical: theme.space.s4,
        minWidth: 0,
        maxWidth: '100%',
    },
    /** A binding's line: its value picker and the value's own field share a top edge, however tall the field grows. */
    bindingLine: {
        alignItems: 'flex-start',
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
    /** A text Action field's box: its words with values inside them (owner 2026-11-15). */
    textFieldBox: {
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        alignSelf: 'stretch',
        minWidth: 0,
    },
    /** A text field while editing (round 1116b g): its label line above the box, the box the row's width. */
    textFieldStack: {
        gap: theme.space.s4,
        minWidth: 0,
        alignSelf: 'stretch',
    },
    textFieldLabelLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    textFieldLabelEnd: {
        marginLeft: 'auto',
    },
    actionFieldStacked: {
        alignSelf: 'stretch',
        gap: theme.space.s4,
        paddingVertical: theme.space.s4,
    },
    textFieldInsert: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s4,
        paddingVertical: theme.space.s4,
        borderRadius: theme.borderRadius.sm,
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

/**
 * The document's grids. The editor publishes which one its document uses, and every grid-dependent row reads it
 * through `useWorkflowDocumentGridStyles`, so names, cards, lanes and the spine move together.
 *
 * - `wide`: numbers hang under the header's mark and names start on the title's edge.
 * - `phone`: the Steps document on a phone (lab round 1116b `page-proposed-open-390`). The numbers and the first
 *   cards' marks stand in one column on the page edge; names and cards share the next edge, at the header's own
 *   mark-to-title gap, so each step reads on one left edge with the spine running down the marks (WF-ACCEPT-1119).
 * - `compact`: one card on its own (the Sentence view's card, the Automate builder; lab round 1116c): its number on
 *   its heading line and the card running under it, the column's full width.
 *
 * `phone` and `compact` are both narrow: their cards recompose for a narrow column.
 */
export type WorkflowDocumentGrid = 'wide' | 'phone' | 'compact';
export const WorkflowDocumentGridContext = React.createContext<WorkflowDocumentGrid>('wide');

const COMPACT_ORDINAL_GAP_PX = HAPPIER_PAGE_METRICS.pageHeaderMarkGapPx;
const COMPACT_GUTTER_PX = ORDINAL_SIZE + COMPACT_ORDINAL_GAP_PX;
const COMPACT_LANE_LEFT_PX = -(COMPACT_GUTTER_PX - ORDINAL_SIZE / 2) - SPINE_WIDTH / 2;

/** The narrow grids' columns: the number on the column's edge, the name at the header's mark-to-title gap after it. */
const narrowDocumentGrid = StyleSheet.create({
    blockColumn: { paddingLeft: COMPACT_GUTTER_PX },
    blockGap: { paddingLeft: COMPACT_GUTTER_PX },
    listEnd: { paddingLeft: COMPACT_GUTTER_PX },
    listNote: { paddingLeft: COMPACT_GUTTER_PX },
    laneEndInserter: { paddingLeft: COMPACT_GUTTER_PX },
    laneLabelRow: { paddingLeft: COMPACT_GUTTER_PX },
    laneTurn: { paddingLeft: COMPACT_GUTTER_PX },
    laneFork: { left: COMPACT_LANE_LEFT_PX, width: COMPACT_GUTTER_PX - LANE_BEND },
    laneJoinBend: { left: COMPACT_LANE_LEFT_PX, width: COMPACT_GUTTER_PX + SPINE_WIDTH },
    heading: { gap: COMPACT_ORDINAL_GAP_PX, marginLeft: -COMPACT_GUTTER_PX },
});
/** `compact` only: the lone card takes the column's whole width, running under its number. */
const cardUnderNumberGrid = StyleSheet.create({
    blockCard: { marginLeft: -COMPACT_GUTTER_PX },
    // A card with no number column has nothing to run under: its host's edge cancels the run-under, so the card
    // keeps the page inset and the phone width its rows wrap at (WAVE-ACCEPT-1117C: x≈0, label-left form).
    cardAlone: { paddingLeft: COMPACT_GUTTER_PX },
});
/** The grid-dependent rows of the wide document, named one by one from the authored styles. */
const WIDE_GRID_STYLES = {
    blockColumn: workflowEditorStyles.blockColumn,
    blockGap: workflowEditorStyles.blockGap,
    listEnd: workflowEditorStyles.listEnd,
    listNote: workflowEditorStyles.listNote,
    laneEndInserter: workflowEditorStyles.laneEndInserter,
    laneLabelRow: workflowEditorStyles.laneLabelRow,
    laneTurn: workflowEditorStyles.laneTurn,
    laneFork: workflowEditorStyles.laneFork,
    laneJoinBend: workflowEditorStyles.laneJoinBend,
    heading: workflowEditorStyles.heading,
    blockCard: workflowEditorStyles.blockCard,
    cardAlone: workflowEditorStyles.cardAlone,
};
/**
 * The phone's rows: the narrow columns layered on, key for key (the compiler checks every key); cards keep the
 * name column. Each pair is a plain (mutable) tuple because React Native's `StyleProp` accepts arrays, not readonly ones.
 */
const PHONE_GRID_STYLES = {
    blockColumn: [workflowEditorStyles.blockColumn, narrowDocumentGrid.blockColumn],
    blockGap: [workflowEditorStyles.blockGap, narrowDocumentGrid.blockGap],
    listEnd: [workflowEditorStyles.listEnd, narrowDocumentGrid.listEnd],
    listNote: [workflowEditorStyles.listNote, narrowDocumentGrid.listNote],
    laneEndInserter: [workflowEditorStyles.laneEndInserter, narrowDocumentGrid.laneEndInserter],
    laneLabelRow: [workflowEditorStyles.laneLabelRow, narrowDocumentGrid.laneLabelRow],
    laneTurn: [workflowEditorStyles.laneTurn, narrowDocumentGrid.laneTurn],
    laneFork: [workflowEditorStyles.laneFork, narrowDocumentGrid.laneFork],
    laneJoinBend: [workflowEditorStyles.laneJoinBend, narrowDocumentGrid.laneJoinBend],
    heading: [workflowEditorStyles.heading, narrowDocumentGrid.heading],
    blockCard: workflowEditorStyles.blockCard,
    cardAlone: workflowEditorStyles.cardAlone,
} satisfies { readonly [Key in keyof typeof WIDE_GRID_STYLES]: unknown };
/** The lone card's rows: the phone's, with the card running under its number. */
const COMPACT_GRID_STYLES = {
    ...PHONE_GRID_STYLES,
    blockCard: [workflowEditorStyles.blockCard, cardUnderNumberGrid.blockCard],
    cardAlone: [workflowEditorStyles.cardAlone, cardUnderNumberGrid.cardAlone],
} satisfies { readonly [Key in keyof typeof WIDE_GRID_STYLES]: unknown };
const GRID_STYLES = { wide: WIDE_GRID_STYLES, phone: PHONE_GRID_STYLES, compact: COMPACT_GRID_STYLES } as const;

/** The grid-dependent document styles for the grid the editor publishes (stable per grid). */
export function useWorkflowDocumentGridStyles(): (typeof GRID_STYLES)[WorkflowDocumentGrid] {
    return GRID_STYLES[React.useContext(WorkflowDocumentGridContext)];
}
