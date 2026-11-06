import { StyleSheet } from 'react-native-unistyles';

import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { Typography } from '@/constants/Typography';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS, HAPPIER_SEGMENTED_METRICS } from '@happier-dev/plugin-ui/presentation';
import { WORKFLOW_DOCUMENT_INSET_PX, WORKFLOW_PAGE_TITLE_EDGE_PX } from '../editor/workflowEditorStyles';

/**
 * Text-labelled controls draw at the WCAG 2.2 pointer floor under every pointer; a finger reaches its
 * touch target through the `HappierPressable` hit area past this drawn box.
 */
const MINIMUM_TARGET_SIZE = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;

/**
 * Shared Run-detail rhythm.
 *
 * One owner so the outcome region, the invocation outline and the selected
 * invocation detail read as one object rather than three surfaces that happen
 * to sit on the same screen. Colors, type and spacing use shared tokens; widths
 * describe the outline/inspector layout rather than a separate design system.
 */
export const workflowRunStyles = StyleSheet.create((theme) => ({
    scroll: {
        flex: 1,
    },
    /** A step's facts above its conversation: sized to its content, never more than half the pane. */
    inspectorAboveConversation: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: '50%',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    /** A held step's region: the value and facts scroll, the decision stays under them, all inside the half. */
    reviewRegion: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s12,
    },
    /** The way back to a review once its conversation is showing: on the pane header's text edge. */
    reopenReview: {
        paddingHorizontal: theme.space.s16,
    },
    /** The same content in the phone's sheet: inset like the sheet's header, clear of its bottom edge. */
    reviewSheet: {
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s24,
    },
    /**
     * The outline and, on wide layouts, its neighbouring inspector. The grid
     * owns the readable width so the inspector sits beside the outline it
     * describes rather than at the far edge of a wide window; each column
     * scrolls on its own, which is what keeps the inspector in place while the
     * outline scrolls.
     */
    grid: {
        flex: 1,
        flexDirection: 'row',
        alignSelf: 'center',
        width: '100%',
    },
    // The page frame's column rule (`PageFrame`, the editor body): capped by the layout width and
    // centred in a wide pane, so a Run sits where the library and editor do (DESIGN-15 R3).
    outline: {
        flex: 1,
        minWidth: 0,
        width: '100%',
        alignSelf: 'center',
    },
    inspector: {
        flexBasis: 360,
        flexGrow: 0,
        flexShrink: 0,
        maxWidth: 480,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
    },
    inspectorContent: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
    },
    root: {
        gap: theme.space.s16,
    },
    outcome: {
        gap: theme.space.s8,
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    /** Pause at boundary, Stop and `⋯` at the header's trailing edge (07 §3 identity-first headers). */
    headerControls: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    /** The view switch hugs its labels at the start of its row rather than spanning the column. */
    viewSwitch: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
        paddingVertical: HAPPIER_PAGE_METRICS.pageTabsGapPx,
    },
    /** The tabs size to themselves, so the view's own actions close the same row. */
    viewTabs: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** Wide: the selected plate bleeds its padding, so the first tab's word sits on the title's edge. */
    viewSwitchOnTitle: {
        paddingLeft: WORKFLOW_PAGE_TITLE_EDGE_PX - HAPPIER_SEGMENTED_METRICS.plain.paddingHorizontalPx,
    },
    /** Wide: this section's words start on the title's edge (lab round 1105 P1). */
    onTitleEdge: {
        paddingLeft: WORKFLOW_PAGE_TITLE_EDGE_PX,
    },
    /** Wide: a list whose marks hang in the gutter under the header's mark and whose names sit on the title's edge. */
    documentInset: {
        paddingLeft: WORKFLOW_DOCUMENT_INSET_PX,
        paddingRight: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    /** A phone's list rows sit on the page's text inset. */
    documentInsetPhone: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    // A phone gives the view switch the full width (lab phone-P1); the view's own actions sit under it.
    viewSwitchPhone: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    // The row reserves its action's target height, so the source action resolving late never pushes the view down.
    viewActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: MINIMUM_TARGET_SIZE,
    },
    /** Wide: the view's own actions close the tab row at its trailing edge (lab run-A); phones stack them. */
    viewActionsTrailing: {
        marginLeft: 'auto',
    },
    viewActionsPhone: {
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sheetBody: {
        padding: theme.space.s16,
    },
    pageSection: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    technicalToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    /**
     * The completion moment's visible half: a brief semantic success wash on
     * the existing outcome surface, using only existing state color roles. It
     * is what pairs with `hapticsLight`, and reduced motion omits it because
     * the status change alone already tells the same truth.
     */
    outcomeCompleted: {
        backgroundColor: theme.colors.state.success.background,
        borderRadius: theme.borderRadius.xl,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        marginHorizontal: -theme.space.s12,
        marginVertical: -theme.space.s8,
    },
    /** The Run's state mark leads its sentence, centred on the first line. */
    outcomeLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    outcomeSentence: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** The state word that leads the outcome line; the rest of the line is prose. */
    outcomeWord: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    outcomeWordFailed: {
        color: theme.colors.state.danger.foreground,
    },
    provenance: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    /** A line that continues the outcome sentence starts under its words, not under its state mark (lab run-R1). */
    outcomeDetail: {
        paddingLeft: ICON_SIZE.md + theme.space.s8,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        flexWrap: 'wrap',
    },
    /** A problem sentence and its repair on one line (wrapping under it when narrow), never a full-width bar. */
    problemLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s12,
        rowGap: theme.space.s4,
    },
    problemText: {
        flexShrink: 1,
        minWidth: 0,
    },
    actionTarget: {
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
    },
    focusTarget: {
        borderWidth: 1,
        borderColor: 'transparent',
    },
    /**
     * Contact feedback for the controls this body owns directly.
     *
     * The canonical button primitives answer press-in themselves; a row or a
     * text-labelled control built from a bare `Pressable` does not, so a
     * delayed action felt inert until its result arrived. This is the same
     * pressed-overlay role the existing prompt-card controls use, not a new
     * press scale or token.
     */
    pressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: theme.borderRadius.md,
    },
    action: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    /** A link to where finished or running work lives ("Open conversation"): present, never loud. */
    quietAction: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.secondary,
    },
    section: {
        gap: theme.space.s8,
    },
    sectionLabel: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.secondary,
    },
    /** A body section's heading ("Needs you"), in the row-title role. */
    sectionTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    sectionHeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    /** A changing count, tabular so it cannot shift the label beside it. */
    sectionCount: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    detailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    detailKey: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.secondary,
    },
    detailValue: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** A value that is prose (a text result, a typed answer) reads as text; mono stays for structured values. */
    detailProse: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    /** Holds a control's place while its availability is still being read; nothing of it shows. */
    reservedSlot: {
        opacity: 0,
        pointerEvents: 'none',
    },
    metric: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
}));
