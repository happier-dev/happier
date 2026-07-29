/**
 * FR4-W2-BODY — option-row rendering extracted from `SelectionListBody.tsx`.
 *
 * Owns:
 *  - testID / role / ARIA / id generation for option rows (with FR3-A
 *    `measureMode` suppression so the hidden measure mirror inside
 *    `SelectionListAnimatedHeight` never duplicates identity props).
 *  - Activation via `activateSelectionListRow` + right-accessory propagation.
 *  - `PlanSuccessRows` mapping helper.
 *  - The two `SlideTransitionSwitch` wrappers (`PlanAnimatedSuccessRows` and
 *    `VirtualizedTransitionShell`) used by the body when a section advertises
 *    a `transitionKey` (directory-drill animation).
 */

import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';

import { activateSelectionListRow } from './SelectionListRowActivation';
import { buildSelectionListOptionA11yProps } from './buildSelectionListOptionA11yProps';
import { renderSelectionListAccessory } from './renderSelectionListAccessory';
import { resolveSelectionListOptionDomId } from './resolveSelectionListOptionDomId';
import { SelectionListInputAttentionContext } from './SelectionListInputAttentionContext';
import { SelectionListScrollIntoViewContext } from './SelectionListScrollIntoViewContext';
import { selectionListTestId } from './_shared';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type { SelectionListOption, SelectionListStep } from './_types';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

export type RenderPlanRowsProps = Readonly<{
    plan: SectionRenderPlan;
    rootTestID: string | undefined;
    stepId: string;
    selectedOptionId: string | null | undefined;
    focusedOptionId: string | null;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    optionPositionById?: ReadonlyMap<string, number>;
    optionSetSize?: number;
    /** FR3-1 / FR3-8 — propagate identity-free measure rendering. */
    measureMode?: boolean;
}>;

export function PlanOptionRow(props: Readonly<{
    option: SelectionListOption;
    rootTestID: string | undefined;
    stepId: string;
    isSelected: boolean;
    isFocused: boolean;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
    positionInSet?: number;
    setSize?: number;
    /**
     * FR3-1 / FR3-8 — when true, suppress every identity / accessibility prop
     * on this row so the hidden measure mirror inside SelectionListAnimatedHeight
     * does not duplicate testIDs / aria-* props in the live DOM. Layout is
     * preserved so the measure host still reports the correct natural height.
     */
    measureMode?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const registerScrollItemLayout = React.useContext(SelectionListScrollIntoViewContext);
    const requestInputAttention = React.useContext(SelectionListInputAttentionContext);
    const optionTestId = resolveSelectionListOptionDomId({
        option: props.option,
        rootTestID: props.rootTestID,
        stepId: props.stepId,
    });
    const optionWrapperTestId = selectionListTestId(
        props.rootTestID,
        props.stepId,
        'option-wrapper',
        props.option.id,
    );
    const handlePress = React.useCallback(() => {
        activateSelectionListRow({
            option: props.option,
            onSelect: props.onSelect,
            onPushStep: props.onPushStep,
            onRequiresInput: requestInputAttention ?? undefined,
        });
    }, [props.option, props.onSelect, props.onPushStep, requestInputAttention]);
    const optionAria = buildSelectionListOptionA11yProps({
        optionTestId,
        isSelected: props.isSelected,
        disabled: props.option.disabled === true,
        positionInSet: props.positionInSet ?? 1,
        setSize: props.setSize ?? 1,
        accessibilityLabel: props.option.accessibilityLabel,
    });
    const customContentAccessibilityProps = Platform.OS === 'web'
        ? optionAria as unknown as Record<string, never>
        : {
            accessibilityLabel: optionAria.accessibilityLabel,
            accessibilityState: optionAria.accessibilityState,
        };
    if (props.measureMode === true) {
        // Identity-free mirror. Skip the role="option" ARIA spread and option
        // testID / wrapper testID. The Item still renders so the layout matches
        // the visible row exactly (height-stable).
        return (
            <View>
                <Item
                    title={props.option.label}
                    subtitle={props.option.subtitleContent ?? props.option.subtitle}
                    titleEllipsizeMode={props.option.labelEllipsizeMode}
                    subtitleEllipsizeMode={props.option.subtitleEllipsizeMode}
                    icon={props.option.icon}
                    rightElement={renderSelectionListAccessory(props.option.rightAccessory)}
                    rightElementOutsidePressable={props.option.rightAccessoryOutsidePressable === true}
                    selected={props.isSelected}
                    focused={props.isFocused}
                    disabled={props.option.disabled === true}
                    loading={props.option.loading === true}
                    showChevron={Boolean(props.option.openStep)}
                    keepChevronWithRightElement={props.option.keepChevronWithAccessory === true}
                    webRole="presentation"
                />
            </View>
        );
    }
    const selectedOrFocused = props.isSelected || props.isFocused;
    const row = props.option.content !== undefined ? (
        <Pressable
            testID={optionTestId}
            onPress={handlePress}
            {...(Platform.OS === 'web'
                ? ({ onKeyDown: (event: any) => {
                    if (props.option.disabled === true) return;
                    const key = event?.nativeEvent?.key ?? event?.key;
                    if (key !== ' ' && key !== 'Spacebar' && key !== 'Enter') return;
                    event?.preventDefault?.();
                    handlePress();
                } } as Record<string, unknown>)
                : {})}
            accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
            disabled={props.option.disabled === true}
            {...customContentAccessibilityProps}
            style={(state) => {
                const hovered = (state as WebHoverablePressableState).hovered === true;
                return ({
                backgroundColor: state.pressed || hovered
                    ? theme.colors.surface.pressed
                    : selectedOrFocused
                        ? theme.colors.surface.selected
                        : undefined,
                opacity: props.option.disabled === true ? 0.5 : 1,
            });}}
        >
            {props.option.content}
        </Pressable>
    ) : (
        <Item
            testID={optionTestId}
            title={props.option.label}
            subtitle={props.option.subtitleContent ?? props.option.subtitle}
            titleEllipsizeMode={props.option.labelEllipsizeMode}
            subtitleEllipsizeMode={props.option.subtitleEllipsizeMode}
            icon={props.option.icon}
            rightElement={renderSelectionListAccessory(props.option.rightAccessory)}
            rightElementOutsidePressable={props.option.rightAccessoryOutsidePressable === true}
            onPress={handlePress}
            selected={props.isSelected}
            focused={props.isFocused}
            disabled={props.option.disabled === true}
            loading={props.option.loading === true}
            showChevron={Boolean(props.option.openStep)}
            keepChevronWithRightElement={props.option.keepChevronWithAccessory === true}
            accessibilityRole="button"
            accessibilityLabel={optionAria.accessibilityLabel}
            webRole="option"
            webId={optionAria.id}
            accessibilityPositionInSet={optionAria['aria-posinset']}
            accessibilitySetSize={optionAria['aria-setsize']}
        />
    );
    return (
        <View
            testID={optionWrapperTestId}
            onLayout={registerScrollItemLayout?.(props.option.id)}
        >
            {row}
        </View>
    );
}

export function PlanSuccessRows(props: RenderPlanRowsProps): React.ReactElement {
    const rows = props.plan.options.map((option, index) => (
        <PlanOptionRow
            key={option.id}
            option={option}
            rootTestID={props.rootTestID}
            stepId={props.stepId}
            isSelected={props.selectedOptionId === option.id}
            isFocused={props.focusedOptionId === option.id}
            onSelect={props.onSelect}
            onPushStep={props.onPushStep}
            positionInSet={props.optionPositionById?.get(option.id) ?? index + 1}
            setSize={props.optionSetSize ?? props.plan.options.length}
            measureMode={props.measureMode}
        />
    ));
    return <>{rows}</>;
}

/**
 * RUX-1 Issue 8: animated wrapper for dynamic-section success rows. Tracks
 * the previous `transitionKey` so the slide direction can be derived from
 * key length (longer key = drill deeper = forward; shorter = walk-up =
 * backward). Same-length swaps default to forward — they're rare in
 * practice (e.g. typing into a sibling directory) and forward feels right
 * for "switching context".
 */
export function PlanAnimatedSuccessRows(props: RenderPlanRowsProps & {
    transitionKey: string;
    sectionTestId: string;
}): React.ReactElement {
    const previousKeyRef = React.useRef<string>(props.transitionKey);
    const direction: 'forward' | 'backward' = React.useMemo(() => {
        const prev = previousKeyRef.current;
        const next = props.transitionKey;
        if (prev === next) return 'forward';
        return next.length < prev.length ? 'backward' : 'forward';
    }, [props.transitionKey]);
    React.useEffect(() => {
        previousKeyRef.current = props.transitionKey;
    }, [props.transitionKey]);
    return (
        <SlideTransitionSwitch
            contentKey={props.transitionKey}
            direction={direction}
            blur={false}
            preset="compact"
            testID={selectionListTestId(props.sectionTestId, 'transition')}
        >
            <PlanSuccessRows
                plan={props.plan}
                rootTestID={props.rootTestID}
                stepId={props.stepId}
                selectedOptionId={props.selectedOptionId}
                focusedOptionId={props.focusedOptionId}
                onSelect={props.onSelect}
                onPushStep={props.onPushStep}
                optionPositionById={props.optionPositionById}
                optionSetSize={props.optionSetSize}
            />
        </SlideTransitionSwitch>
    );
}

/**
 * FR3-9 — `SlideTransitionSwitch` wrapper around virtualized rows for
 * directory-drill animation. Mirrors `PlanAnimatedSuccessRows` direction
 * inference (longer key = drill deeper = forward; shorter = walk-up =
 * backward) but accepts arbitrary children so the virtualized list-hosted
 * virtualized section can participate in the same animation contract as
 * mapped rows.
 *
 * Why a separate component (rather than threading children into
 * `PlanAnimatedSuccessRows`): the mapped helper internally renders
 * `<PlanSuccessRows>` from a `RenderPlanRowsProps`; coupling that helper to
 * "either rows or a virtualized hosting child" would muddy a clean contract.
 * Keeping a small dedicated shell keeps both paths self-contained.
 */
export function VirtualizedTransitionShell(props: Readonly<{
    transitionKey: string;
    sectionTestId: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const previousKeyRef = React.useRef<string>(props.transitionKey);
    const direction: 'forward' | 'backward' = React.useMemo(() => {
        const prev = previousKeyRef.current;
        const next = props.transitionKey;
        if (prev === next) return 'forward';
        return next.length < prev.length ? 'backward' : 'forward';
    }, [props.transitionKey]);
    React.useEffect(() => {
        previousKeyRef.current = props.transitionKey;
    }, [props.transitionKey]);
    return (
        <SlideTransitionSwitch
            contentKey={props.transitionKey}
            direction={direction}
            blur={false}
            preset="compact"
            testID={selectionListTestId(props.sectionTestId, 'transition')}
        >
            {props.children}
        </SlideTransitionSwitch>
    );
}
