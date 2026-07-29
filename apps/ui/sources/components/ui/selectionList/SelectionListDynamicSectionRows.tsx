/**
 * FR4-W2-BODY — dynamic-state row rendering extracted from
 * `SelectionListBody.tsx`. Single source of truth for skeleton / error /
 * not-found / empty-hint row visuals + a11y, shared between:
 *
 *  - the per-section path (`renderSectionElement` in SelectionListBody.tsx),
 *    which composes section header + dynamic rows + optional stale option
 *    rows inside one wrapping `View`; and
 *  - the flat virtualized list path (`SelectionListVirtualizedBody.tsx`), which emits
 *    each dynamic row as a standalone virtualized list row (no shared section
 *    wrapper).
 *
 * Style + opacity (stale wrapper) and constants are owned by this module so
 * both call sites stay visually identical without leaking the body's
 * stylesheet across files.
 */

import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS,
    SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
} from './_constants';
import { activateSelectionListRow } from './SelectionListRowActivation';
import {
    PlanAnimatedSuccessRows,
    PlanSuccessRows,
    VirtualizedTransitionShell,
} from './SelectionListOptionRow';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import { SelectionListSectionHeader } from './SelectionListSectionHeader';
import { SelectionListSkeletonRow } from './SelectionListSkeletonRow';
import { SelectionListVirtualizedSection } from './SelectionListVirtualizedSection';
import { SelectionListScrollIntoViewContext } from './SelectionListScrollIntoViewContext';
import { selectionListTestId } from './_shared';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
    SelectionListVirtualizationMode,
} from './_types';

export const SELECTION_LIST_STALE_OPTIONS_OPACITY = 0.6;

const dynamicRowStyles = StyleSheet.create((theme) => ({
    errorRow: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: 6,
        marginHorizontal: 12,
        marginVertical: 4,
    },
    errorText: {
        color: theme.colors.text.secondary,
    },
    emptyHintRow: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    emptyHintText: {
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
    },
    staleSection: {
        opacity: SELECTION_LIST_STALE_OPTIONS_OPACITY,
    },
}));

/** Re-export the stylesheet so the body composition (per-section path) can
 * reuse the exact same style objects for stale wrapping. */
export const selectionListDynamicRowStyles = dynamicRowStyles;

/**
 * Loading skeleton row — used by both the flat virtualized list path (one row per
 * skeleton) and the per-section path (rendered inside a single accessibility
 * container).
 */
export function SelectionListLoadingSkeletonRow(props: Readonly<{
    index: number;
    /** When provided, used as the row's testID; otherwise no testID is set. */
    testID: string | undefined;
}>): React.ReactElement {
    return (
        <SelectionListSkeletonRow
            index={props.index}
            testID={props.testID}
        />
    );
}

/**
 * Container for one or more skeleton rows. Mirrors the per-section renderer
 * which wraps the array of skeletons in a single `accessibilityHidden` View
 * so AT only announces the visible (stale) rows.
 */
export function SelectionListLoadingSkeletonGroup(props: Readonly<{
    count: number;
    sectionTestId: string;
    measureMode: boolean;
    /** When provided, used to compose per-row testIDs. */
    rowTestIdBase: (i: number) => string | undefined;
    /** Outer container testID (the `:loading` namespace). */
    containerTestId: string | undefined;
}>): React.ReactElement {
    const a11yHide = props.measureMode
        ? {}
        : ({ accessibilityHidden: true, 'aria-hidden': true } as Record<string, unknown>);
    return (
        <View testID={props.containerTestId} {...a11yHide}>
            {Array.from({ length: props.count }, (_, i) => (
                <SelectionListSkeletonRow
                    key={`skeleton-${i}`}
                    index={i}
                    testID={props.rowTestIdBase(i)}
                />
            ))}
        </View>
    );
}

/**
 * Error row — visually identical between the per-section and flat paths. The
 * caller decides whether to render the `role="alert"` aria spread (full
 * rendering) or omit it (measure mode mirror).
 */
export function SelectionListErrorRow(props: Readonly<{
    label: string;
    testID: string | undefined;
    measureMode: boolean;
}>): React.ReactElement {
    const styles = dynamicRowStyles;
    const aria = props.measureMode
        ? {}
        : ({ role: 'alert', 'aria-live': 'polite' } as Record<string, unknown>);
    return (
        <View testID={props.testID} style={styles.errorRow} {...aria}>
            <Text style={styles.errorText}>{props.label}</Text>
        </View>
    );
}

/**
 * Not-found row (resolver verdict). Same visual as the empty-hint row but
 * carries `role="status"` so AT announces the path-resolution result.
 */
export function SelectionListNotFoundRow(props: Readonly<{
    label: string;
    testID: string | undefined;
    measureMode: boolean;
}>): React.ReactElement {
    const styles = dynamicRowStyles;
    const aria = props.measureMode
        ? {}
        : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>);
    return (
        <View testID={props.testID} style={styles.emptyHintRow} {...aria}>
            <Text style={styles.emptyHintText}>{props.label}</Text>
        </View>
    );
}

/**
 * Empty-hint row — descriptor-provided "no matches" message. No role/aria-
 * live announcement (parity with the per-section renderer).
 */
export function SelectionListEmptyHintRow(props: Readonly<{
    hint: string;
    testID: string | undefined;
}>): React.ReactElement {
    const styles = dynamicRowStyles;
    return (
        <View testID={props.testID} style={styles.emptyHintRow}>
            <Text style={styles.emptyHintText}>{props.hint}</Text>
        </View>
    );
}

const sectionWrapStyles = StyleSheet.create(() => ({
    sectionWrap: {
        flexDirection: 'column',
    },
    virtualizedSectionWrap: {
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
}));

function SelectionListSectionScrollOffsetFrame(props: Readonly<{
    children: React.ReactNode;
    style: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement {
    const parentRegisterItemLayout = React.useContext(SelectionListScrollIntoViewContext);
    const sectionOffsetYRef = React.useRef(0);
    const registerItemLayout = React.useCallback<NonNullable<typeof parentRegisterItemLayout>>((optionId) => {
        const parentHandler = parentRegisterItemLayout?.(optionId);
        return (event) => {
            const layout = event.nativeEvent?.layout;
            if (!layout || typeof layout.y !== 'number') {
                parentHandler?.(event);
                return;
            }
            parentHandler?.({
                ...event,
                nativeEvent: {
                    ...event.nativeEvent,
                    layout: {
                        ...layout,
                        y: sectionOffsetYRef.current + layout.y,
                    },
                },
            });
        };
    }, [parentRegisterItemLayout]);

    return (
        <SelectionListScrollIntoViewContext.Provider
            value={parentRegisterItemLayout ? registerItemLayout : null}
        >
            <View
                testID={props.testID}
                style={props.style}
                onLayout={(event) => {
                    const nextY = event.nativeEvent.layout.y;
                    if (typeof nextY === 'number') {
                        sectionOffsetYRef.current = nextY;
                    }
                }}
            >
                {props.children}
            </View>
        </SelectionListScrollIntoViewContext.Provider>
    );
}

/**
 * Per-section render context. Plumbed through the body composition so the
 * dynamic-section renderer doesn't need to know about the body's full prop
 * surface (no leaky `SelectionListBodyProps` coupling).
 */
export type SelectionListSectionRenderContext = Readonly<{
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionId: string | null | undefined;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById: ReadonlyMap<string, number>;
    optionSetSize: number;
    showsVerticalScrollIndicator: boolean;
    /** FR3-1 / FR3-8 — identity-free measure rendering. */
    measureMode: boolean;
}>;

/**
 * Render the section nodes from the plan. Extracted so the body can decide
 * whether to wrap them in a ScrollView (non-virtualized) or render them flat
 * (virtualized — virtualized list owns the scroll container).
 */
export function renderSelectionListSectionNodes(
    plan: ReadonlyArray<SectionRenderPlan>,
    virtualizedSectionIds: ReadonlySet<string>,
    ctx: SelectionListSectionRenderContext,
): ReadonlyArray<React.ReactNode> {
    return plan.map((sectionPlan) =>
        renderSelectionListSectionElement(
            sectionPlan,
            virtualizedSectionIds.has(sectionPlan.id),
            ctx,
        ),
    );
}

/**
 * Render a single section. Branches on `dynamicState` to emit
 * loading/error/empty/success variants and on virtualization to choose
 * between the virtualized virtualized list path and the plain mapped path.
 *
 * R16c (Major 5): the body-level resolver decides whether THIS section is
 * allowed to virtualize. The descriptor's own virtualization hint is the
 * upstream signal; the resolver downgrades extra virtualized-eligible
 * sections to plain rendering and emits a dev warning. `allowVirtualization`
 * is the per-section verdict from the resolver.
 */
function renderSelectionListSectionElement(
    sectionPlan: SectionRenderPlan,
    allowVirtualization: boolean,
    ctx: SelectionListSectionRenderContext,
): React.ReactElement | null {
    const wrapStyles = sectionWrapStyles;
    const dynStyles = dynamicRowStyles;
    const { measureMode } = ctx;
    const sectionTestId = selectionListTestId(
        ctx.rootTestID,
        'section',
        sectionPlan.id,
    );
    const headerTestId = selectionListTestId(sectionTestId, 'header');
    const wrapperStyle = sectionPlan.isStale === true
        ? [wrapStyles.sectionWrap, dynStyles.staleSection]
        : wrapStyles.sectionWrap;
    const header = (
        <SelectionListSectionHeader
            testID={measureMode ? undefined : headerTestId}
            title={sectionPlan.title}
            count={sectionPlan.count}
        />
    );
    const sectionTestIdForRender = measureMode ? undefined : sectionTestId;

    if (sectionPlan.dynamicState === 'loading') {
        const skeletonCount = sectionPlan.skeletonRowCount ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS;
        return (
            <SelectionListSectionScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
            >
                {header}
                <SelectionListLoadingSkeletonGroup
                    count={skeletonCount}
                    sectionTestId={sectionTestId}
                    measureMode={measureMode}
                    containerTestId={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'loading')}
                    rowTestIdBase={(i) => measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'loading', `row-${i}`)}
                />
                {sectionPlan.isStale === true && sectionPlan.options.length > 0 ? (
                    <PlanSuccessRows
                        plan={sectionPlan}
                        rootTestID={ctx.rootTestID}
                        stepId={ctx.stepId}
                        selectedOptionId={ctx.selectedOptionId}
                        focusedOptionId={ctx.focusedOptionId}
                        onSelect={ctx.onSelect}
                        onPushStep={ctx.onPushStep}
                        optionPositionById={ctx.optionPositionById}
                        optionSetSize={ctx.optionSetSize}
                        measureMode={measureMode}
                    />
                ) : null}
            </SelectionListSectionScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'error') {
        const errorLabel = sectionPlan.hint ?? t('selectionList.dynamicSectionError');
        return (
            <SelectionListSectionScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
            >
                {header}
                <SelectionListErrorRow
                    label={errorLabel}
                    testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'error')}
                    measureMode={measureMode}
                />
                {sectionPlan.options.length > 0 ? (
                    <View style={dynStyles.staleSection}>
                        <PlanSuccessRows
                            plan={sectionPlan}
                            rootTestID={ctx.rootTestID}
                            stepId={ctx.stepId}
                            selectedOptionId={ctx.selectedOptionId}
                            focusedOptionId={ctx.focusedOptionId}
                            onSelect={ctx.onSelect}
                            onPushStep={ctx.onPushStep}
                            optionPositionById={ctx.optionPositionById}
                            optionSetSize={ctx.optionSetSize}
                            measureMode={measureMode}
                        />
                    </View>
                ) : null}
            </SelectionListSectionScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'notFound') {
        const notFoundLabel = sectionPlan.hint ?? t('selectionList.pathNotFound');
        return (
            <SelectionListSectionScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
            >
                {header}
                <SelectionListNotFoundRow
                    label={notFoundLabel}
                    testID={measureMode ? undefined : selectionListTestId(sectionTestId, 'notFound')}
                    measureMode={measureMode}
                />
            </SelectionListSectionScrollOffsetFrame>
        );
    }

    if (sectionPlan.dynamicState === 'empty') {
        if (sectionPlan.hint === undefined || sectionPlan.hint.length === 0) {
            return null;
        }
        return (
            <SelectionListSectionScrollOffsetFrame
                key={sectionPlan.id}
                testID={sectionTestIdForRender}
                style={wrapperStyle}
            >
                {header}
                <SelectionListEmptyHintRow
                    hint={sectionPlan.hint}
                    testID={measureMode
                        ? undefined
                        : selectionListTestId(sectionTestId, 'emptyHint')}
                />
            </SelectionListSectionScrollOffsetFrame>
        );
    }

    // Success — render via the virtualized helper when its row count crosses
    // the virtualization threshold (or is forced); otherwise plain map.
    const sectionForRender: SelectionListSection = {
        id: sectionPlan.id,
        title: sectionPlan.title,
        count: sectionPlan.count,
        options: sectionPlan.options,
        virtualization: sectionPlan.virtualization,
    };
    const handleVirtualizedSelect = (option: SelectionListOption) => {
        activateSelectionListRow({
            option,
            onSelect: ctx.onSelect,
            onPushStep: ctx.onPushStep,
        });
    };
    const mode: SelectionListVirtualizationMode =
        sectionPlan.virtualization ?? 'auto';
    const eligibleForVirtualization =
        mode === 'force'
        || (
            mode === 'auto'
            && sectionPlan.options.length > SELECTION_LIST_VIRTUALIZATION_THRESHOLD
        );
    // R16c (Major 5): the body-level resolver may downgrade additional
    // virtualization-eligible sections to plain rendering when a step
    // declares more than one. `allowVirtualization` is false for those.
    const willVirtualize = eligibleForVirtualization && allowVirtualization;

    if (willVirtualize && !measureMode) {
        const virtualizedNode = (
            <SelectionListVirtualizedSection
                section={sectionForRender}
                stepId={ctx.stepId}
                rootTestID={ctx.rootTestID}
                selectedOptionId={ctx.selectedOptionId ?? null}
                // F4 — thread the keyboard-driven focused option through
                // so the virtualized renderer can mirror focused styling
                // AND so it can scroll the focused row into view
                // (matching the plain mapped path's UX).
                focusedOptionId={ctx.focusedOptionId}
                onSelectOption={handleVirtualizedSelect}
                optionPositionById={ctx.optionPositionById}
                optionSetSize={ctx.optionSetSize}
                virtualization={sectionPlan.virtualization}
                showsVerticalScrollIndicator={ctx.showsVerticalScrollIndicator}
            />
        );
        // FR3-9: when the virtualized section advertises a `transitionKey`
        // (dynamic directory drill seed), wrap it in the same
        // `SlideTransitionSwitch` that `PlanAnimatedSuccessRows` uses on the
        // mapped row path so directory drill-downs cross-slide instead of
        // snapping when the row count crosses the virtualization threshold.
        const virtualizedTransitionKey = typeof sectionPlan.transitionKey === 'string'
            && sectionPlan.transitionKey.length > 0
            ? sectionPlan.transitionKey
            : undefined;
        if (virtualizedTransitionKey !== undefined) {
            return (
                <View
                    key={sectionPlan.id}
                    style={[wrapperStyle, wrapStyles.virtualizedSectionWrap]}
                >
                    <VirtualizedTransitionShell
                        transitionKey={virtualizedTransitionKey}
                        sectionTestId={sectionTestId}
                    >
                        {virtualizedNode}
                    </VirtualizedTransitionShell>
                </View>
            );
        }
        return (
            <View
                key={sectionPlan.id}
                style={[wrapperStyle, wrapStyles.virtualizedSectionWrap]}
            >
                {virtualizedNode}
            </View>
        );
    }

    // RUX-1 Issue 8: when the dynamic section advertises a `transitionKey`
    // (the resolver seed), wrap the success rows in a SlideTransitionSwitch
    // so directory drill-downs cross-slide instead of snapping. Static
    // sections never set transitionKey, so they render plainly.
    const useAnimatedRows = typeof sectionPlan.transitionKey === 'string'
        && sectionPlan.transitionKey.length > 0;

    return (
        <SelectionListSectionScrollOffsetFrame
            key={sectionPlan.id}
            testID={sectionTestIdForRender}
            style={wrapperStyle}
        >
            {header}
            {useAnimatedRows && !measureMode ? (
                <PlanAnimatedSuccessRows
                    plan={sectionPlan}
                    rootTestID={ctx.rootTestID}
                    stepId={ctx.stepId}
                    selectedOptionId={ctx.selectedOptionId}
                    focusedOptionId={ctx.focusedOptionId}
                    onSelect={ctx.onSelect}
                    onPushStep={ctx.onPushStep}
                    optionPositionById={ctx.optionPositionById}
                    optionSetSize={ctx.optionSetSize}
                    transitionKey={sectionPlan.transitionKey as string}
                    sectionTestId={sectionTestId}
                />
            ) : (
                <PlanSuccessRows
                    plan={sectionPlan}
                    rootTestID={ctx.rootTestID}
                    stepId={ctx.stepId}
                    selectedOptionId={ctx.selectedOptionId}
                    focusedOptionId={ctx.focusedOptionId}
                    onSelect={ctx.onSelect}
                    onPushStep={ctx.onPushStep}
                    optionPositionById={ctx.optionPositionById}
                    optionSetSize={ctx.optionSetSize}
                    measureMode={measureMode}
                />
            )}
        </SelectionListSectionScrollOffsetFrame>
    );
}
