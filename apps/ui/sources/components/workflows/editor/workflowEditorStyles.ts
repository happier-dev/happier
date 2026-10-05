import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import type { HappierPressableStyleState } from '@happier-dev/plugin-ui/presentation';

/**
 * Text-labelled authoring controls cannot declare a square the way
 * `IconButton` does, so they take the canonical platform target as a real
 * minimum height. `hitSlop` is not an option: react-native-web's `Pressable`
 * never reads it and the desktop app IS the web bundle, so a slop-declared
 * target there is a target that does not exist. Growth is on the free vertical
 * axis, so wrapping chip rows still meet at their gap rather than overlapping.
 */
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

/**
 * Shared editor rhythm.
 *
 * The execution rail — one quiet leading hairline that connects ordered work and
 * folds into a group summary — is this feature's visual signature. Structure is
 * carried by whitespace, alignment and that rail rather than by nesting a card
 * inside a card. Every value comes from the existing theme tokens; this module
 * introduces no palette, font or spacing system of its own.
 */
export const workflowEditorStyles = StyleSheet.create((theme) => ({
    /**
     * The real press frame for a text-labelled authoring control. Its border is
     * reserved (transparent) so the shared focus ring (`focusRingStyle`) can
     * paint it without moving layout.
     */
    actionTarget: {
        minHeight: MINIMUM_TARGET_SIZE,
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
        borderRadius: theme.borderRadius.md,
        borderColor: theme.colors.border.strong,
    },
    /** A square icon-only press frame (the block `⋯`). */
    iconTarget: {
        minWidth: MINIMUM_TARGET_SIZE,
        alignItems: 'center',
        borderRadius: theme.borderRadius.md,
    },
    /** The between-block inserter: a hairline with a centred (+), revealed on hover, focus or selection (04 §4.3). */
    inserter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        minHeight: 24,
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
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
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
        alignItems: 'flex-start',
        columnGap: theme.margins.md,
        rowGap: theme.margins.xs,
        minWidth: 0,
    },
    actionFieldLabelColumn: {
        width: 120,
        minHeight: MINIMUM_TARGET_SIZE,
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
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
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
    referenceSelect: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    /**
     * Contact feedback for a text-labelled authoring control, applied through
     * its `HappierPressable` state callback (see {@link workflowPressFeedbackStyle}).
     * The same surface roles `IconButton` uses: hover reinforces and press
     * answers on contact. Focus appearance is not owned here.
     */
    pressHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    pressPressed: {
        backgroundColor: theme.colors.surface.pressed,
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

/**
 * The feedback half of a text-labelled workflow control's `HappierPressable`
 * style callback: `style={(state) => [base, workflowPressFeedbackStyle(state, theme.colors.border.focus)]}`.
 *
 * Detection is `HappierPressable`'s (its `focused` is already keyboard-only);
 * the ring's appearance is the one shared owner `focusRingStyle`, painted on
 * the border `actionTarget` reserves. This module draws no ring of its own.
 */
export function workflowPressFeedbackStyle(state: HappierPressableStyleState, focusColor: string) {
    return [
        state.hovered ? workflowEditorStyles.pressHovered : null,
        state.pressed ? workflowEditorStyles.pressPressed : null,
        focusRingStyle({ focused: state.focused, color: focusColor }),
    ];
}
