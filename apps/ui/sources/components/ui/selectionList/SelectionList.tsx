import * as React from 'react';
import {
    Platform,
    type LayoutChangeEvent,
    TextInput as RNTextInput,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { useHasHardwareKeyboard } from '@/hooks/ui/useHasHardwareKeyboard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { SelectionListAnimatedHeight } from './SelectionListAnimatedHeight';
import { SelectionListBody } from './SelectionListBody';
import { SelectionListFooter } from './SelectionListFooter';
import { SelectionListInputAttentionContext } from './SelectionListInputAttentionContext';
import { createSelectionListKeyPressHandler } from './SelectionListKeyboardInput';
import { SelectionListMeasureHost } from './SelectionListMeasureHost';
import { synthesizeSelectionListRenderPlan, type SectionRenderPlan } from './SelectionListRenderPlan';
import { activateSelectionListRow } from './SelectionListRowActivation';
import { SelectionListSearchHeader } from './SelectionListSearchHeader';
import { selectionListTestId } from './_shared';
import type {
    SelectionListDynamicSection,
    SelectionListKeyboardHint,
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from './_types';
import { useSelectionListMeasuredBodyHeightStore } from './selectionListMeasuredBodyHeight';
import { useSelectionListAutocomplete } from './useSelectionListAutocomplete';
import { useSelectionListDynamicSections } from './useSelectionListDynamicSections';
import { useSelectionListKeyboardNav } from './useSelectionListKeyboardNav';
import { useSelectionListMeasuredPopoverHeight } from './useSelectionListMeasuredPopoverHeight';
import { useSelectionListStepStack } from './useSelectionListStepStack';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.base,
        flexDirection: 'column',
    },
    content: {
        // RUX-1 Issue 7: the content zone (body + cross-slide) MUST be the
        // flex grower of the column so the persistent footer below it stays
        // pinned to the bottom of the popover regardless of how tall the
        // body's contents grow. Without `flex: 1` and `minHeight: 0`, a
        // body that exceeds maxHeight pushes the footer off-screen and
        // forces the user to scroll to the very bottom of the list to see
        // the keyboard hints.
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
    },
    contentSized: {
        flexDirection: 'column',
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: 'auto',
        minHeight: 0,
    },
    contentSizedAnimatedHeight: {
        flex: 0,
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: 'auto',
    },
}));

const IS_WEB = Platform.OS === 'web';
const STABILIZED_HEIGHT_SHRINK_DELAY_MS = 180;
/** Section id for the synthetic, filter-bypassing `buildInputRow` row. */
const SELECTION_LIST_INPUT_ROW_SECTION_ID = 'selection-list:input-row';

/**
 * SelectionList — top-level orchestrator with three-zone composition:
 *  - Zone 1: persistent `SelectionListSearchHeader` (outside the cross-slide)
 *  - Zone 2: step body wrapped in `SlideTransitionSwitch` (Lane L's discrete adapter)
 *  - Zone 3: persistent `SelectionListFooter` (outside the cross-slide)
 *
 * Owns:
 *  - the step stack (`useSelectionListStepStack`)
 *  - the input value
 *  - the keyboard nav (`useSelectionListKeyboardNav`) and Escape routing
 *  - keyboard-hints visibility (`useHasHardwareKeyboard` default)
 *
 * Does NOT own:
 *  - animation choreography (delegated to `SlideTransitionSwitch`)
 *  - the leading-slot search↔back swap (owned by `SelectionListSearchHeader`)
 *  - per-row press behaviour (owned by `Item`)
 *  - render-plan synthesis (`synthesizeSelectionListRenderPlan` in
 *    `SelectionListRenderPlan.ts`)
 *  - body rendering (`SelectionListBody` in `SelectionListBody.tsx`)
 *  - per-row activation (`activateSelectionListRow` in
 *    `SelectionListRowActivation.ts`)
 *  - per-event key dispatch (`createSelectionListKeyPressHandler` in
 *    `SelectionListKeyboardInput.ts`)
 *
 * This orchestrator is intentionally bounded by adjacent owners. The body,
 * render-plan synthesizer, row-activation contract, and key-press dispatch all
 * live in adjacent modules with their own unit tests.
 */
export function SelectionList(props: SelectionListProps): React.ReactElement {
    const styles = stylesheet;

    const stack = useSelectionListStepStack(props.rootStep);

    // Phase 1A — rootStep prop-change resync. The step stack reducer initializes
    // from the FIRST `rootStep` and never re-reads the prop, so a parent that
    // swaps `rootStep` after mount would see the orchestrator stuck on the old
    // root. Hand every new root to the stack, which decides whether it is a
    // refresh of the root the user is on (same step id — keep whatever they
    // pushed on top of it) or a different destination (drain the stack).
    const lastRootStepRef = React.useRef<SelectionListStep>(props.rootStep);
    React.useEffect(() => {
        if (lastRootStepRef.current === props.rootStep) return;
        lastRootStepRef.current = props.rootStep;
        stack.adoptRootStep(props.rootStep);
    }, [props.rootStep, stack]);
    const detectedKeyboard = useHasHardwareKeyboard();
    const detectedReducedMotion = useReducedMotionPreference();
    const keyboardHintsEnabled = props.keyboardHintsEnabled ?? detectedKeyboard;

    const isInputControlled = props.inputValue !== undefined;
    const [uncontrolledInputValue, setUncontrolledInputValue] = React.useState<string>('');
    const inputValue = isInputControlled ? (props.inputValue ?? '') : uncontrolledInputValue;
    const setInputValue = React.useCallback(
        (next: string) => {
            if (!isInputControlled) setUncontrolledInputValue(next);
            props.onChangeInputValue?.(next);
        },
        [isInputControlled, props.onChangeInputValue],
    );

    const currentStep = stack.currentStep;
    // Per-step input mode: a pushed step may declare its own `inputMode`
    // (e.g. the worktree "name your worktree" value step) while sibling steps
    // stay in the SelectionList-level mode. Falls back to the prop, then 'search'.
    const inputMode = currentStep.inputMode ?? props.inputMode ?? 'search';
    const inputBehavior = props.inputBehavior;
    const searchInputRef = React.useRef<RNTextInput | null>(null);

    // Input-attention signal: a `requiresInputValue` row (e.g. the worktree
    // "type a name" row while empty) asks to focus + shake the input rather than
    // commit. The nonce drives the header's shake; the focus call summons the
    // cursor so the user can start typing immediately.
    const [inputAttentionNonce, setInputAttentionNonce] = React.useState(0);
    const requestInputAttention = React.useCallback(() => {
        setInputAttentionNonce((current) => current + 1);
        searchInputRef.current?.focus?.();
    }, []);

    // Reset the input when the visible step changes — the placeholder + filter
    // domain are step-specific, so persisting the value across pushes/pops
    // would surface stale text. Skip when controlled (parent owns the value).
    const lastStepIdRef = React.useRef<string>(currentStep.id);
    React.useEffect(() => {
        if (lastStepIdRef.current === currentStep.id) return;
        lastStepIdRef.current = currentStep.id;
        if (!isInputControlled) setUncontrolledInputValue('');
    }, [currentStep.id, isInputControlled]);

    // Filter query is the raw input by default; behavior adapters can map it
    // (e.g. paths surface only the trailing leaf for filtering).
    const filterQuery = React.useMemo(() => {
        if (inputBehavior?.getFilterQueryFromInput) {
            return inputBehavior.getFilterQueryFromInput(inputValue);
        }
        return inputValue;
    }, [inputBehavior, inputValue]);

    // Resolve dynamic sections via the Phase 2.2 hook.
    const dynamicSections = React.useMemo<ReadonlyArray<SelectionListDynamicSection>>(() => {
        const out: SelectionListDynamicSection[] = [];
        for (const section of currentStep.sections) {
            if (section.kind === 'dynamic') {
                const { kind: _kind, ...rest } = section;
                out.push(rest);
            }
        }
        return out;
    }, [currentStep.sections]);

    const dynamicSectionStates = useSelectionListDynamicSections({
        dynamicSections,
        inputValue,
        inputBehavior,
    });

    // Resolve sections to render via the pure synthesizer (R14 extraction).
    const buildInputRow = currentStep.buildInputRow;
    const renderPlan = React.useMemo(
        () => {
            const base = synthesizeSelectionListRenderPlan({
                sections: currentStep.sections,
                inputValue,
                // A value step can opt out of input filtering (`disableInputFilter`)
                // so its fixed rows (e.g. the "Use suggested name" row) stay
                // visible while the user types a custom value rather than being
                // narrowed away as a search query.
                filterQuery: currentStep.disableInputFilter === true ? '' : filterQuery,
                dynamicSectionStates,
            });
            // Combobox-create: a step can synthesize an "act on current input"
            // row (e.g. "Create worktree '<typed>'"). Prepend it as a
            // filter-bypassing section so it always reflects the live input and
            // is the default-focused row; `null` omits it.
            const inputRow = buildInputRow?.(inputValue) ?? null;
            if (!inputRow) return base;
            const inputRowSection: SectionRenderPlan = {
                id: SELECTION_LIST_INPUT_ROW_SECTION_ID,
                options: [inputRow],
            };
            return [inputRowSection, ...base];
        },
        [currentStep.sections, currentStep.disableInputFilter, buildInputRow, dynamicSectionStates, inputValue, filterQuery],
    );

    // FR4-2: option-bearing sections contribute focusable rows. Sections in
    // stale-while-revalidate state (`dynamicState: 'loading' | 'error'` with
    // `options.length > 0`) surface prior successful options as real
    // interactive rows in the body (see `SelectionListBody` loading/error
    // branches). They MUST therefore be reachable via Arrow / Enter and via
    // `aria-activedescendant` — otherwise keyboard + screen-reader users lose
    // access to rows that pointer users can still tap. Pure non-interactive
    // sections (skeleton-only loading, error without stale, `empty`,
    // `notFound`) stay excluded.
    const isFocusableSectionPlan = React.useCallback(
        (sectionPlan: typeof renderPlan[number]): boolean => {
            if (sectionPlan.dynamicState === undefined) return true;
            if (sectionPlan.dynamicState === 'loading' || sectionPlan.dynamicState === 'error') {
                return sectionPlan.options.length > 0;
            }
            return false;
        },
        [],
    );

    const flatVisibleOptionIds = React.useMemo<ReadonlyArray<string>>(() => {
        const ids: string[] = [];
        for (const sectionPlan of renderPlan) {
            if (!isFocusableSectionPlan(sectionPlan)) continue;
            for (const option of sectionPlan.options) {
                if (option.disabled === true) continue;
                ids.push(option.id);
            }
        }
        return ids;
    }, [renderPlan, isFocusableSectionPlan]);

    const findOptionById = React.useCallback(
        (optionId: string): SelectionListOption | undefined => {
            for (const sectionPlan of renderPlan) {
                if (!isFocusableSectionPlan(sectionPlan)) continue;
                const match = sectionPlan.options.find(
                    (opt: SelectionListOption) => opt.id === optionId,
                );
                if (match) return match;
            }
            return undefined;
        },
        [renderPlan, isFocusableSectionPlan],
    );

    const handleActivate = React.useCallback(
        (optionId: string) => {
            const option = findOptionById(optionId);
            if (!option) return;
            activateSelectionListRow({
                option,
                onSelect: props.onSelect,
                onPushStep: stack.pushStep,
                onRequiresInput: requestInputAttention,
            });
        },
        [findOptionById, stack.pushStep, props.onSelect, requestInputAttention],
    );

    const handleClearInput = React.useCallback(() => {
        setInputValue('');
    }, [setInputValue]);

    // Phase 2.3 autocomplete + Phase 2.5 advanced keyboard nav.
    const dynamicSectionIds = React.useMemo(() => new Set(dynamicSections.map((s) => s.id)), [dynamicSections]);
    const [focusedOptionId, setFocusedOptionId] = React.useState<string | null>(null);

    const focusedOption = React.useMemo(
        () => (focusedOptionId ? findOptionById(focusedOptionId) ?? null : null),
        [focusedOptionId, findOptionById],
    );
    const focusedOptionSectionId = React.useMemo(() => {
        if (!focusedOptionId) return null;
        for (const sectionPlan of renderPlan) {
            // FR4-2: include stale option-bearing dynamic sections (same
            // contract as `flatVisibleOptionIds` / `findOptionById`).
            if (!isFocusableSectionPlan(sectionPlan)) continue;
            if (sectionPlan.options.some((o: SelectionListOption) => o.id === focusedOptionId)) {
                return sectionPlan.id;
            }
        }
        return null;
    }, [renderPlan, focusedOptionId, isFocusableSectionPlan]);
    const isFocusedOptionInDynamicSection = focusedOptionSectionId
        ? dynamicSectionIds.has(focusedOptionSectionId)
        : false;

    const [caretAtEnd, setCaretAtEnd] = React.useState<boolean>(true);
    const [isComposing, setIsComposing] = React.useState<boolean>(false);

    const autocomplete = useSelectionListAutocomplete({
        inputValue,
        focusedOption,
        isFocusedOptionInDynamicSection,
        shouldSuppress: inputBehavior?.shouldSuppressAutocomplete,
        isComposing,
    });

    const autocompleteValueByOptionId = React.useMemo(() => {
        const values = new Map<string, string>();
        for (const sectionPlan of renderPlan) {
            if (!isFocusableSectionPlan(sectionPlan)) continue;
            if (!dynamicSectionIds.has(sectionPlan.id)) continue;
            for (const option of sectionPlan.options) {
                if (option.disabled === true) continue;
                if (option.autocompleteValue !== undefined) {
                    values.set(option.id, option.autocompleteValue);
                }
            }
        }
        return values;
    }, [renderPlan, isFocusableSectionPlan, dynamicSectionIds]);

    const handleAcceptAutocomplete = React.useCallback(() => {
        if (autocomplete.ghostSuffix.length > 0) {
            setInputValue(autocomplete.nextInputValue);
        }
    }, [autocomplete.ghostSuffix, autocomplete.nextInputValue, setInputValue]);

    const handleAcceptFocusedAutocomplete = React.useCallback((optionId: string): boolean => {
        const nextValue = autocompleteValueByOptionId.get(optionId);
        if (nextValue === undefined) return false;
        setInputValue(nextValue);
        return true;
    }, [autocompleteValueByOptionId, setInputValue]);

    // Prefer the active step's commit handler (a pushed value step carries its
    // own closure — e.g. the base ref it was opened for); fall back to the
    // SelectionList-level prop for single-instance value-mode consumers.
    const stepCommitInputValue = currentStep.onCommitInputValue;
    const handleCommitInputValue = React.useCallback(() => {
        if (stepCommitInputValue) {
            // A per-step value commit (e.g. the worktree "name" step) is a
            // terminal selection like activating a row, so close the popover.
            // Without this the popover stays open, the consumer rebuilds
            // `rootStep`, and the step stack resets back to the root step.
            // Prop-level value-mode consumers (e.g. the path picker) keep their
            // own close semantics and are unaffected.
            stepCommitInputValue(inputValue);
            props.onRequestClose();
            return;
        }
        props.onCommitInputValue?.(inputValue);
    }, [inputValue, stepCommitInputValue, props.onCommitInputValue, props.onRequestClose]);

    const handleWalkUp = React.useCallback((): boolean => {
        if (!inputBehavior?.onBackspaceAtEnd) return false;
        const next = inputBehavior.onBackspaceAtEnd(inputValue);
        if (next === null) return false;
        setInputValue(next);
        return true;
    }, [inputBehavior, inputValue, setInputValue]);

    // RUX-13: Shift+Tab "back/up" — when the step stack cannot be popped, the
    // hook delegates here. The path adapter walks the input up regardless of
    // trailing separator (more aggressive than `onBackspaceAtEnd`). Returns
    // false when there is genuinely no back action available so the keyboard
    // hook can fall through to native focus traversal.
    const handleBackUp = React.useCallback((): boolean => {
        if (!inputBehavior?.onBackUp) return false;
        const next = inputBehavior.onBackUp(inputValue);
        if (next === null) return false;
        setInputValue(next);
        return true;
    }, [inputBehavior, inputValue, setInputValue]);

    // Default keyboard focus. A step can compute it from the live input
    // (`resolveDefaultFocusedOptionId`) — e.g. the worktree name step focuses the
    // "Use suggested name" row while empty, then the live "Create …" row once the
    // user types — falling back to the selected option, then the first row.
    const preferredFocusedOptionId = React.useMemo(() => {
        const fromStep = currentStep.resolveDefaultFocusedOptionId?.(inputValue);
        if (fromStep !== undefined && fromStep !== null) return fromStep;
        return props.selectedOptionId ?? null;
    }, [currentStep, inputValue, props.selectedOptionId]);

    const keyboard = useSelectionListKeyboardNav({
        flatVisibleOptionIds,
        preferredFocusedOptionId,
        onActivate: handleActivate,
        canPopStep: stack.canPop,
        onPopStep: stack.popStep,
        inputValue,
        onClearInput: handleClearInput,
        // R14: thread the prop-level quick-action shortcuts through to the
        // hook. Previously the prop was declared on `SelectionListProps` but
        // never forwarded — making `Cmd+N` from a parent dead. The hook
        // already covers this code path under
        // `useSelectionListKeyboardNav.advanced.test.ts`.
        quickActionShortcuts: props.quickActionShortcuts,
        inputCaretAtEnd: caretAtEnd,
        ghostSuffixPresent: autocomplete.ghostSuffix.length > 0,
        isComposing,
        onAcceptAutocomplete: handleAcceptAutocomplete,
        onAcceptFocusedAutocomplete: handleAcceptFocusedAutocomplete,
        onCommitInputValue: handleCommitInputValue,
        onWalkUp: handleWalkUp,
        onBackUp: handleBackUp,
        inputMode,
    });

    // Mirror keyboard.focusedIndex back into focusedOptionId for autocomplete/accessibility.
    React.useEffect(() => {
        if (keyboard.focusedIndex < 0 || keyboard.focusedIndex >= flatVisibleOptionIds.length) {
            if (focusedOptionId !== null) setFocusedOptionId(null);
            return;
        }
        const id = flatVisibleOptionIds[keyboard.focusedIndex] ?? null;
        if (id !== focusedOptionId) setFocusedOptionId(id);
    }, [keyboard.focusedIndex, flatVisibleOptionIds, focusedOptionId]);

    const handleKeyPress = React.useMemo(
        () => createSelectionListKeyPressHandler({
            keyboard,
            isComposing,
            focusedOptionId,
            onActivate: handleActivate,
            canPopStep: stack.canPop,
            inputValue,
            onRequestClose: props.onRequestClose,
        }),
        [keyboard, isComposing, focusedOptionId, handleActivate, stack.canPop, inputValue, props.onRequestClose],
    );

    const handlePushStep = React.useCallback(
        (step: SelectionListStep) => {
            stack.pushStep(step);
        },
        [stack],
    );

    // RUX-13: synthesize the "⇧⇥ back" footer hint when there's a real back
    // action available. The hint is shown when EITHER:
    //   - the step stack can pop (sub-step is active), OR
    //   - path-mode `inputBehavior.onBackUp(inputValue)` returns a non-null
    //     replacement (i.e. there's a parent path to walk up to)
    // Otherwise the hint is omitted so the footer doesn't advertise a dead
    // shortcut. Authored step `footerHints` are preserved verbatim and the
    // back hint is appended at the end of the array (the visual order chosen
    // to keep authored hints stable; the back chip is the "extra" cue).
    const backHintAvailable = React.useMemo<boolean>(() => {
        if (stack.canPop) return true;
        if (inputBehavior?.onBackUp) {
            const next = inputBehavior.onBackUp(inputValue);
            if (next !== null) return true;
        }
        return false;
    }, [stack.canPop, inputBehavior, inputValue]);

    const footerHints = React.useMemo<ReadonlyArray<SelectionListKeyboardHint>>(() => {
        const authored = currentStep.footerHints ?? [];
        if (!backHintAvailable) return authored;
        const backHint: SelectionListKeyboardHint = {
            id: 'back',
            label: '⇧⇥',
            description: t('selectionList.backShortcut'),
        };
        return [...authored, backHint];
    }, [currentStep.footerHints, backHintAvailable]);

    const resolvedTestId = props.testID ?? 'selection-list';

    // RV-1 (routing-2): the search header is omitted entirely when the
    // consumer's `rootStep` declares no `inputPlaceholder` (the documented
    // "omit to disable input" contract per `_types.ts`) AND no `inputBehavior`
    // adapter (path / value-mode adapters own backspace/walk-up semantics on
    // the input row) AND `inputMode !== 'value'` (the input IS the candidate
    // value, e.g. the path picker's value-mode where Enter commits the raw
    // input). When omitted the SelectionList degrades to a plain section list
    // — used by simple-mode pickers (session mode, transcript storage,
    // recipient, delivery, Windows launch mode, etc.).
    //
    // Gate on `rootStep.inputPlaceholder` (consumer-level intent) rather than
    // `currentStep.inputPlaceholder` so the header stays stable across step
    // pushes — a sub-step that omits the placeholder must NOT cause the
    // header to vanish mid-flow.
    const showSearchHeader =
        props.rootStep.inputPlaceholder !== undefined
        || inputBehavior !== undefined
        || inputMode === 'value';

    const stabilizeHeight = props.heightBehavior === 'stabilizedContentHeight';
    const stabilizedHeightReleaseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastStabilizedHeightRef = React.useRef<number>(0);
    const [stabilizedMinHeight, setStabilizedMinHeight] = React.useState<number | undefined>(undefined);
    const clearStabilizedHeightTimer = React.useCallback(() => {
        if (stabilizedHeightReleaseTimerRef.current === null) return;
        clearTimeout(stabilizedHeightReleaseTimerRef.current);
        stabilizedHeightReleaseTimerRef.current = null;
    }, []);
    const releaseStabilizedHeight = React.useCallback(() => {
        stabilizedHeightReleaseTimerRef.current = null;
        lastStabilizedHeightRef.current = 0;
        setStabilizedMinHeight(undefined);
    }, []);
    const scheduleStabilizedHeightRelease = React.useCallback(() => {
        clearStabilizedHeightTimer();
        stabilizedHeightReleaseTimerRef.current = setTimeout(
            releaseStabilizedHeight,
            STABILIZED_HEIGHT_SHRINK_DELAY_MS,
        );
    }, [clearStabilizedHeightTimer, releaseStabilizedHeight]);
    const handleContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (!stabilizeHeight) return;
        const measured = event.nativeEvent.layout.height;
        if (!Number.isFinite(measured) || measured <= 0) return;
        const capped = typeof props.maxHeight === 'number' && Number.isFinite(props.maxHeight)
            ? Math.min(measured, props.maxHeight)
            : measured;
        const previous = lastStabilizedHeightRef.current;
        if (previous <= 0 || capped > previous) {
            clearStabilizedHeightTimer();
            lastStabilizedHeightRef.current = capped;
            setStabilizedMinHeight(capped);
            return;
        }
        if (capped < previous) {
            scheduleStabilizedHeightRelease();
        }
    }, [clearStabilizedHeightTimer, props.maxHeight, scheduleStabilizedHeightRelease, stabilizeHeight]);
    const heightStabilityKey = React.useMemo(() => (
        renderPlan
            .map((sectionPlan) => [
                sectionPlan.id,
                sectionPlan.dynamicState ?? 'static',
                sectionPlan.options.length,
            ].join(':'))
            .join('|')
    ), [renderPlan]);
    React.useEffect(() => {
        if (!stabilizeHeight) {
            clearStabilizedHeightTimer();
            releaseStabilizedHeight();
            return;
        }
        if (lastStabilizedHeightRef.current > 0) {
            scheduleStabilizedHeightRelease();
        }
    }, [
        heightStabilityKey,
        inputValue,
        clearStabilizedHeightTimer,
        releaseStabilizedHeight,
        scheduleStabilizedHeightRelease,
        stabilizeHeight,
    ]);
    React.useEffect(() => () => {
        clearStabilizedHeightTimer();
    }, [clearStabilizedHeightTimer]);
    const measureNativeHeight = props.heightBehavior === 'measuredToMaxHeight';
    const disableTransitions = props.disableTransitions === true || detectedReducedMotion;
    const measuredPopoverHeight = useSelectionListMeasuredPopoverHeight({
        enabled: measureNativeHeight,
        maxHeight: props.maxHeight,
        headerExpected: showSearchHeader,
        footerExpected: keyboardHintsEnabled,
        shrinkDelayMs: STABILIZED_HEIGHT_SHRINK_DELAY_MS,
    });
    const fixedMaxHeight = props.heightBehavior === 'fixedToMaxHeight'
        && typeof props.maxHeight === 'number'
        && Number.isFinite(props.maxHeight)
        && props.maxHeight > 0
        ? props.maxHeight
        : undefined;
    const fixedHeight = fixedMaxHeight ?? measuredPopoverHeight.height;
    const useContentSizedFrame = fixedHeight === undefined;
    const containerStyle: StyleProp<ViewStyle> = [
        styles.container,
        props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : null,
        fixedHeight !== undefined ? { height: fixedHeight } : null,
        measuredPopoverHeight.hidden ? { opacity: 0 } : null,
        measureNativeHeight && !measuredPopoverHeight.hidden ? { opacity: 1 } : null,
        fixedHeight === undefined && stabilizedMinHeight !== undefined
            ? { minHeight: stabilizedMinHeight }
            : null,
    ];

    // Pick a direction that maps step-stack changes to SlideTransitionSwitch.
    // The stack reducer emits 'forward' on push, 'backward' on pop, 'replace' on
    // adoptRootStep. We forward as-is.
    const direction = stack.state.direction;

    const listboxId = React.useMemo(
        () => selectionListTestId(resolvedTestId, 'listbox'),
        [resolvedTestId],
    );
    const activeDescendantId = focusedOptionId
        ? selectionListTestId(resolvedTestId, currentStep.id, 'option', focusedOptionId)
        : undefined;

    const body = (
        <SelectionListBody
            step={currentStep}
            rootTestID={resolvedTestId}
            selectedOptionId={props.selectedOptionId ?? null}
            plan={renderPlan}
            focusedOptionId={focusedOptionId}
            scrollTargetOptionId={props.activeScrollOptionId ?? focusedOptionId ?? props.selectedOptionId ?? null}
            listboxId={listboxId}
            accessibilityLabel={props.listAccessibilityLabel}
            onSelect={props.onSelect}
            onPushStep={handlePushStep}
            showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
        />
    );

    // The current step body's natural height is ONE fact with TWO consumers:
    // the native popover height gate (`useSelectionListMeasuredPopoverHeight`,
    // which holds the surface at `opacity: 0` until a height is known) and the
    // step-transition height animator (`SelectionListAnimatedHeight`). It is
    // therefore measured exactly ONCE, here, by the single measure host below —
    // every extra host is a second invisible mount of every row on the
    // popover-open critical path, and a second owner of the same measurement.
    const needsBodyMeasurement = measureNativeHeight || !disableTransitions;

    // FR3-1 / FR3-8 — identity-free measure mirror. `mode='measure'` suppresses
    // every identity-bearing prop the body owns, so the hidden measure subtree
    // never emits duplicate listbox / option testIDs, aria-* props, or roles in
    // the live DOM. The boundary is expressed at the API level instead of
    // relying on post-hoc cloneElement identity stripping.
    const measureBody = needsBodyMeasurement ? (
        <SelectionListBody
            mode="measure"
            step={currentStep}
            rootTestID={resolvedTestId}
            selectedOptionId={props.selectedOptionId ?? null}
            plan={renderPlan}
            focusedOptionId={focusedOptionId}
            listboxId={listboxId}
            accessibilityLabel={props.listAccessibilityLabel}
            onSelect={props.onSelect}
            onPushStep={handlePushStep}
            showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
        />
    ) : null;

    // The mirror's height report must not become orchestrator render state:
    // this component owns BOTH `body` and `measureBody`, so one render here
    // rebuilds both subtrees and re-renders every option row twice over. The
    // mirror re-lays out on every content height change — on web that is every
    // filter keystroke that changes the list height — so the animator reads the
    // number from an external store instead, and a measurement outside a step
    // transition costs nothing. The measurement is tagged with the step it
    // describes so a mid-transition animator cannot mistake the OUTGOING step's
    // height for the incoming target; the id is captured at layout time rather
    // than mirrored through an effect that can lag an `onLayout`.
    const measuredBodyHeights = useSelectionListMeasuredBodyHeightStore();
    const onPopoverBodyLayout = measuredPopoverHeight.onBodyLayout;
    const measuredStepId = currentStep.id;
    const handleBodyMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (measureNativeHeight) onPopoverBodyLayout(event);
        // With transitions disabled the height animator is never mounted, so
        // there is no consumer for this measurement.
        if (disableTransitions) return;
        measuredBodyHeights.publish(measuredStepId, event.nativeEvent.layout.height);
    }, [
        disableTransitions,
        measureNativeHeight,
        measuredBodyHeights,
        measuredStepId,
        onPopoverBodyLayout,
    ]);

    React.useEffect(() => {
        if (!IS_WEB || props.autoFocusInputOnWeb !== true || !showSearchHeader) return;
        searchInputRef.current?.focus?.();
    }, [currentStep.id, props.autoFocusInputOnWeb, showSearchHeader]);

    // FR3-4: headerless keyboard host. When the search header is omitted
    // (inputless list chips: session-mode, transcript-storage, recipient,
    // delivery, Windows launch mode, etc.), the container View becomes the
    // sole key-event surface so Arrow / Enter / Escape / Shift+Tab still work.
    // The handler is identical to the one the header's TextInput would receive;
    // we attach via `onKeyDown` (web) so it sits on the actual DOM container
    // without competing with `onKeyPress` from a TextInput-shaped event.
    //
    // Native (iOS/Android) does not need this — there is no hardware keyboard
    // hierarchy to bind to and the visual surface relies on row taps. The
    // prop is silently ignored by the native View renderer.
    const headerlessKeyHandler: Record<string, unknown> = showSearchHeader
        ? {}
        : { onKeyDown: handleKeyPress };

    return (
        <SelectionListInputAttentionContext.Provider value={requestInputAttention}>
        <View
            testID={resolvedTestId}
            style={containerStyle}
            pointerEvents={measuredPopoverHeight.hidden ? 'none' : undefined}
            onLayout={stabilizeHeight ? handleContainerLayout : undefined}
            {...headerlessKeyHandler}
        >
            {needsBodyMeasurement ? (
                <SelectionListMeasureHost
                    rootTestID={resolvedTestId}
                    onMeasureLayout={handleBodyMeasureLayout}
                    measureMaxHeight={props.maxHeight}
                >
                    {measureBody}
                </SelectionListMeasureHost>
            ) : null}
            {showSearchHeader ? (
                <View
                    testID={selectionListTestId(resolvedTestId, 'headerFrame')}
                    collapsable={false}
                    onLayout={measureNativeHeight ? measuredPopoverHeight.onHeaderLayout : undefined}
                >
                    <SelectionListSearchHeader
                        testID={selectionListTestId(resolvedTestId, 'header')}
                        value={inputValue}
                        onChangeText={setInputValue}
                        placeholder={currentStep.inputPlaceholder ?? ''}
                        canPop={stack.canPop}
                        backLabel={currentStep.backLabel ?? props.rootStep.title}
                        onPopStep={stack.popStep}
                        onKeyPress={handleKeyPress}
                        // Native soft-keyboard return commits the value when this
                        // step is in value mode (web commits via the keydown
                        // listener instead; the header guards against double-fire).
                        onSubmitEditing={inputMode === 'value' ? handleCommitInputValue : undefined}
                        ghostSuffix={autocomplete.ghostSuffix}
                        inputValueEllipsizeMode={props.inputValueEllipsizeMode}
                        inputPrefix={props.inputPrefix}
                        inputSuffix={props.inputSuffix}
                        inputRef={searchInputRef}
                        onCaretAtEndChange={setCaretAtEnd}
                        onIsComposingChange={setIsComposing}
                        listboxId={listboxId}
                        activeDescendantId={activeDescendantId}
                        attentionNonce={inputAttentionNonce}
                    />
                </View>
            ) : null}
            <View
                testID={selectionListTestId(resolvedTestId, 'content')}
                style={useContentSizedFrame ? styles.contentSized : styles.content}
            >
                {disableTransitions ? (
                    body
                ) : (
                    // RUX-14: wrap the SlideTransitionSwitch in
                    // SelectionListAnimatedHeight so the OUTER container
                    // shrinks/grows in lockstep with the inner slide rather
                    // than snapping abruptly when the spring settles. The
                    // animator pins height to the previous step's measured
                    // natural height, animates to the new step's natural
                    // height (supplied by the single measure host above,
                    // which mirrors `body` offscreen), and releases back to
                    // `auto` on completion. Reduced motion: snaps without
                    // animation.
                    <SelectionListAnimatedHeight
                        stepKey={currentStep.id}
                        measuredHeights={measuredBodyHeights}
                        style={useContentSizedFrame ? styles.contentSizedAnimatedHeight : undefined}
                        testID={selectionListTestId(resolvedTestId, 'animatedHeight')}
                    >
                        <SlideTransitionSwitch
                            contentKey={currentStep.id}
                            direction={direction}
                            blur={false}
                            preset="compact"
                            testID={selectionListTestId(resolvedTestId, 'transition')}
                        >
                            {body}
                        </SlideTransitionSwitch>
                    </SelectionListAnimatedHeight>
                )}
            </View>
            {keyboardHintsEnabled ? (
                <View
                    testID={selectionListTestId(resolvedTestId, 'footerFrame')}
                    collapsable={false}
                    onLayout={measureNativeHeight ? measuredPopoverHeight.onFooterLayout : undefined}
                >
                    <SelectionListFooter
                        testID={selectionListTestId(resolvedTestId, 'footer')}
                        hints={footerHints}
                        hardwareKeyboardAvailable={keyboardHintsEnabled}
                    />
                </View>
            ) : null}
        </View>
        </SelectionListInputAttentionContext.Provider>
    );
}
