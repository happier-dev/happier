import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
    blockList: {
        gap: theme.margins.lg,
    },
    nestedList: {
        gap: theme.margins.md,
    },
    railRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    rail: {
        width: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
        marginRight: theme.margins.md,
    },
    railSelected: {
        backgroundColor: theme.colors.border.focus,
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
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
    },
    ordinal: {
        ...Typography.default('semiBold'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
        // A stable ordinal width keeps renumbering from moving the prompt edge.
        minWidth: 18,
    },
    headingName: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** The block name as the control that selects the block. */
    headingButton: {
        flexDirection: 'row',
        justifyContent: 'flex-start',
        gap: theme.margins.sm,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        alignItems: 'center',
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.md,
    },
    headingNameInput: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexGrow: 1,
        flexShrink: 1,
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
    groupHeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
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
    branchLabel: {
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
    /** A square icon-only press frame (the block `⋯`). */
    iconTarget: {
        minWidth: TOUCH_TARGET_FLOOR,
        alignItems: 'center',
        borderRadius: theme.borderRadius.md,
    },
    /** The between-block inserter: a hairline with a centred (+), revealed on hover, focus or selection (04 §4.3). */
    inserter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        minHeight: TOUCH_TARGET_FLOOR,
        // Under a precise pointer the inserter lives inside the list's gap rather than adding
        // to it: the blocks keep one rhythm whether the document is editable or read-only, and
        // the gap still leaves clear space between the inserter and its neighbours' controls.
        marginVertical: TOUCH_TARGET_FLOOR === undefined ? -theme.margins.sm : 0,
        borderWidth: 1,
        borderColor: 'transparent',
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
    menuSurface: {
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: theme.borderRadius.xl,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.surface,
        paddingVertical: theme.margins.xs,
        minWidth: 200,
    },
    menuRow: {
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.md,
        minHeight: TOUCH_TARGET_FLOOR,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'transparent',
    },
    menuRowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    menuRowLabel: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
    },
    /** One bound input of an Action or nested-workflow step: its label over its binding. */
    containerSummaryAnchor: {
        alignSelf: 'flex-start',
    },
    /**
     * An Action step's card (lab `editor-S8`): its field rows and its foot, inside one bordered
     * surface the width of the composer above or below it.
     */
    actionCard: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.sm,
        gap: theme.margins.sm,
        minWidth: 0,
    },
    /** A label column beside its binding; the binding moves beneath the label when the card is narrow. */
    actionFieldRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        // A label reads level with its value, not above or below it (lab S6).
        alignItems: 'center',
        columnGap: theme.margins.md,
        rowGap: theme.margins.xs,
        minWidth: 0,
    },
    actionFieldLabelColumn: {
        width: 120,
        minHeight: TOUCH_TARGET_FLOOR,
        justifyContent: 'center',
    },
    actionFieldValue: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    actionCardFoot: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.margins.sm,
        justifyContent: 'space-between',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        paddingTop: theme.margins.xs,
    },
    actionFieldLabel: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    /** A bound literal as the document reads it. */
    actionFieldText: {
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
    },
    menuRowLabelDestructive: {
        ...Typography.default('regular'),
        color: theme.colors.text.destructive,
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
