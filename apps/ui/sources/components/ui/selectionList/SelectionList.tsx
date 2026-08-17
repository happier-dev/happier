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

import { resolveItemGroupColumnCountForWidth } from '@/components/ui/lists/itemGroupColumnLayout';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
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
import { resolveSelectionListA11yPattern } from './buildSelectionListOptionA11yProps';
import {
    resolveSelectionListListboxDomId,
    resolveSelectionListOptionDomId,
} from './resolveSelectionListOptionDomId';
import {
    buildSelectionListGridGeometry,
    resolveSelectionListGridArrowTarget,
    type SelectionListGridGeometry,
} from './selectionListGridGeometry';
import { selectionListTestId } from './_shared';
import type {
    SelectionListDynamicSection,
    SelectionListKeyboardHint,
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from './_types';
import { useSelectionListAutocomplete } from './useSelectionListAutocomplete';
import { useSelectionListDynamicSections } from './useSelectionListDynamicSections';
import {
    useSelectionListKeyboardNav,
    useSelectionListRovingFocus,
    type SelectionListArrowKey,
} from './useSelectionListKeyboardNav';
import { useSelectionListMeasuredPopoverHeight } from './useSelectionListMeasuredPopoverHeight';
import { useSelectionListStepStack } from './useSelectionListStepStack';
import { useHardwareKeyboard } from './useHardwareKeyboard';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.base,
        flexDirection: 'column',
    },
    containerFill: {
        flex: 1,
        minHeight: 0,
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

/**
 * A body measurement together with the step it was taken for. The step tag is
 * what makes a single measurement safe to share: a height read for the step
 * being replaced says nothing about the step replacing it.
 */
type MeasuredStepBodyHeight = Readonly<{ stepId: string; height: number }>;

const IS_WEB = Platform.OS === 'web';
const STABILIZED_HEIGHT_SHRINK_DELAY_MS = 180;
/** Section id for the synthetic, filter-bypassing `buildInputRow` row. */
const SELECTION_LIST_INPUT_ROW_SECTION_ID = 'selection-list:input-row';

/**
 * FR4-2: option-bearing sections contribute focusable rows. Sections in
 * stale-while-revalidate state (`dynamicState: 'loading' | 'error'` with
 * `options.length > 0`) surface prior successful options as real interactive
 * rows in the body (see `SelectionListBody` loading/error branches). They MUST
 * therefore be reachable via Arrow / Enter and via `aria-activedescendant` —
 * otherwise keyboard + screen-reader users lose access to rows that pointer
 * users can still tap. Pure non-interactive sections (skeleton-only loading,
 * error without stale, `empty`, `notFound`) stay excluded.
 *
 * Module-level so the nav array, the option lookup, and the grid geometry all
 * read ONE definition of "focusable" — a disagreement between them would
 * silently misalign nav indexes with layout cells.
 */
function isFocusableSectionPlan(sectionPlan: SectionRenderPlan): boolean {
    if (sectionPlan.dynamicState === undefined) return true;
    if (sectionPlan.dynamicState === 'loading' || sectionPlan.dynamicState === 'error') {
        return sectionPlan.options.length > 0;
    }
    return false;
}

/**
 * Whether a section's OPTIONS reach the screen at all. Distinct from
 * `isFocusableSectionPlan`: `empty` / `notFound` sections render a hint row in
 * place of their options, so they contribute no grid cells.
 */
function sectionPlanRendersOptions(sectionPlan: SectionRenderPlan): boolean {
    return sectionPlan.dynamicState === undefined
        || sectionPlan.dynamicState === 'loading'
        || sectionPlan.dynamicState === 'error';
}

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
 * R14 split this orchestrator from a 1042-line monolith into ~300 lines of
 * pure composition. The body, the render-plan synthesizer, the row-activation
 * contract, and the key-press dispatch all live in adjacent modules with their
 * own unit tests.
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
    //
    // Dispatched DURING RENDER, not from an effect. React discards this render
    // pass and re-runs the component with the new stack before committing, so
    // the body never paints the outgoing root. From an effect it did: a
    // consumer that rebuilds `rootStep` from its own selection (the model
    // picker rebuilds every option when the selected model changes) passes the
    // new `selectedOptionId` in the SAME render, so the list committed one
    // frame applying the new selection to the previous root's options — the
    // selected row's `expandedContent` belonged to a row that was no longer
    // selected, so the inline controls rendered nowhere and the whole list
    // collapsed by the panel's height and sprang back on the next commit.
    // That was the visible "jiggle" on every model change.
    const lastRootStepRef = React.useRef<SelectionListStep>(props.rootStep);
    if (lastRootStepRef.current !== props.rootStep) {
        lastRootStepRef.current = props.rootStep;
        stack.adoptRootStep(props.rootStep);
    }
    const detectedKeyboard = useHardwareKeyboard();
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
    const virtualizedOptionSource = currentStep.virtualizedOptionSource;
    const virtualizedOptionSourceStateKey = virtualizedOptionSource?.stateKey;
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

    // FR4-2 — see `isFocusableSectionPlan` above for why stale option-bearing
    // sections still contribute focusable rows.
    const flatVisibleOptionIds = React.useMemo<ReadonlyArray<string>>(() => {
        if (virtualizedOptionSource) return [];
        const ids: string[] = [];
        for (const sectionPlan of renderPlan) {
            if (!isFocusableSectionPlan(sectionPlan)) continue;
            for (const option of sectionPlan.options) {
                if (option.disabled === true) continue;
                ids.push(option.id);
            }
        }
        return ids;
    }, [renderPlan, virtualizedOptionSource]);

    const findOptionById = React.useCallback(
        (optionId: string): SelectionListOption | undefined => {
            if (virtualizedOptionSource) {
                const optionIndex = virtualizedOptionSource.findOptionIndexById(optionId);
                return optionIndex >= 0
                    ? virtualizedOptionSource.getOption(optionIndex)
                    : undefined;
            }
            for (const sectionPlan of renderPlan) {
                if (!isFocusableSectionPlan(sectionPlan)) continue;
                const match = sectionPlan.options.find(
                    (opt: SelectionListOption) => opt.id === optionId,
                );
                if (match) return match;
            }
            return undefined;
        },
        [renderPlan, virtualizedOptionSource],
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

    // Default keyboard focus. A step can compute it from the live input
    // (`resolveDefaultFocusedOptionId`) — e.g. the worktree name step focuses the
    // "Use suggested name" row while empty, then the live "Create …" row once the
    // user types — falling back to the selected option, then the first row.
    const preferredFocusedOptionId = React.useMemo(() => {
        const fromStep = currentStep.resolveDefaultFocusedOptionId?.(inputValue);
        if (fromStep !== undefined && fromStep !== null) return fromStep;
        return props.selectedOptionId ?? null;
    }, [currentStep, inputValue, props.selectedOptionId]);

    // Roving row focus, owned ONCE (see `useSelectionListRovingFocus`). It is
    // resolved HERE — before autocomplete — because the ghost suffix is a
    // function of the focused row, while the key dispatcher that consumes the
    // ghost only reads it at event time. Mirroring the focused id back through
    // an effect (the previous shape) cost two extra commits per focus change
    // and published one stale frame before settling.
    const focus = useSelectionListRovingFocus({
        flatVisibleOptionIds,
        ...(virtualizedOptionSource === undefined ? {} : { virtualizedOptionSource }),
        preferredFocusedOptionId,
        inputValue,
        inputMode,
    });
    const focusedOptionId = focus.focusedOptionId;

    // Phase 2.3 autocomplete + Phase 2.5 advanced keyboard nav.
    const dynamicSectionIds = React.useMemo(() => new Set(dynamicSections.map((s) => s.id)), [dynamicSections]);

    const focusedOption = React.useMemo(
        () => {
            if (virtualizedOptionSource) {
                return virtualizedOptionSource.isFocusableOptionIndex(focus.focusedIndex)
                    ? virtualizedOptionSource.getOption(focus.focusedIndex)
                    : null;
            }
            return focusedOptionId ? findOptionById(focusedOptionId) ?? null : null;
        },
        [
            virtualizedOptionSource,
            virtualizedOptionSourceStateKey,
            focus.focusedIndex,
            focusedOptionId,
            findOptionById,
        ],
    );
    const focusedOptionSectionId = React.useMemo(() => {
        if (virtualizedOptionSource) return null;
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
    }, [renderPlan, focusedOptionId, virtualizedOptionSource]);
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
    }, [renderPlan, dynamicSectionIds]);

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

    // Lane G — the `columns` variant. Column count comes from the list's OWN
    // measured width (see `handleContainerLayout` below), never from
    // `useWindowDimensions`: this list is routinely a `flex: 1` pane beside a
    // fixed rail inside a capped popover, where the window width is unrelated
    // to the room a row actually gets. Before the first layout the width is
    // `undefined` and the resolver falls to one column.
    const columns = props.columns;
    // The COUNT is the state, not the width. A ResizeObserver reports a fresh
    // width for every sub-pixel change a browser makes, and storing the raw
    // number re-rendered the entire list each time even though the layout was
    // identical. The width is kept in a ref because it is only ever an input to
    // this resolver — nothing renders it — so a change that does not cross a
    // breakpoint now sets no state at all.
    const measuredContainerWidthRef = React.useRef<number | undefined>(undefined);
    const [columnCount, setColumnCount] = React.useState(1);
    const resolveColumnCountForWidth = React.useCallback((widthPx: number | undefined): number => {
        if (!columns || widthPx === undefined) return 1;
        return resolveItemGroupColumnCountForWidth({
            availableWidthPx: widthPx,
            requestedColumns: columns.max,
            minColumnWidthPx: columns.minColumnWidthPx,
            columnGapPx: columns.columnGapPx,
        });
    }, [columns]);
    // Holding the count rather than the width means the resolver's OWN inputs
    // (a caller widening `minColumnWidthPx`, or withdrawing `columns`) would
    // otherwise leave a stale count behind. Re-resolve from the remembered
    // width when they move; no-ops on mount, where both sides are already 1.
    React.useEffect(() => {
        const next = resolveColumnCountForWidth(measuredContainerWidthRef.current);
        setColumnCount((current) => (current === next ? current : next));
    }, [resolveColumnCountForWidth]);

    // Layout position for every RENDERED option — disabled rows included.
    // Building this from `flatVisibleOptionIds` would drop them from the grid
    // entirely, since that array exists to describe navigation, not painting.
    const gridGeometry = React.useMemo(() => {
        if (virtualizedOptionSource) return null;
        if (columnCount <= 1) return null;
        const groups: Array<{ id: string; options: Array<{ id: string; focusable: boolean }> }> = [];
        for (const sectionPlan of renderPlan) {
            if (!sectionPlanRendersOptions(sectionPlan)) continue;
            if (sectionPlan.options.length === 0) continue;
            const sectionFocusable = isFocusableSectionPlan(sectionPlan);
            groups.push({
                id: sectionPlan.id,
                options: sectionPlan.options.map((option) => ({
                    id: option.id,
                    focusable: sectionFocusable && option.disabled !== true,
                })),
            });
        }
        return buildSelectionListGridGeometry({ groups, columnCount });
    }, [renderPlan, columnCount, virtualizedOptionSource]);

    // Desired-column memory. A grid remembers the column the user is aiming at
    // so passing DOWN through a row whose matching cell is disabled does not
    // permanently move the roving column one over. Kept here, in the closure
    // that owns the geometry, rather than widened into the keyboard hook's
    // seam: the hook navigates a flat index space and has no business knowing
    // that columns exist. Scoped to one geometry and one nav index, so any
    // focus change the grid did not cause (typing, filtering, a new plan)
    // invalidates the aim instead of applying it to a different cell.
    const desiredGridColumnRef = React.useRef<{
        geometry: SelectionListGridGeometry;
        navIndex: number;
        column: number;
    } | null>(null);
    const resolveArrowTarget = React.useMemo(() => {
        if (gridGeometry === null) return undefined;
        return (index: number, key: SelectionListArrowKey): number | null => {
            const remembered = desiredGridColumnRef.current;
            const desiredColumn = remembered !== null
                && remembered.geometry === gridGeometry
                && remembered.navIndex === index
                ? remembered.column
                : null;
            const target = resolveSelectionListGridArrowTarget(
                gridGeometry,
                index,
                key,
                desiredColumn,
            );
            if (target === null) return null;
            desiredGridColumnRef.current = {
                geometry: gridGeometry,
                navIndex: target.navIndex,
                column: target.desiredColumn,
            };
            return target.navIndex;
        };
    }, [gridGeometry]);

    const keyboard = useSelectionListKeyboardNav({
        flatVisibleOptionIds,
        ...(virtualizedOptionSource === undefined ? {} : { virtualizedOptionSource }),
        focus,
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
        resolveArrowTarget,
    });

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
    // The container is the only element that knows how much room the list
    // actually got, so it measures for BOTH consumers: the columns variant
    // (width) and stabilized height (height). Each half is independently
    // guarded — the callback is attached whenever either one wants it.
    const handleContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (columns !== undefined) {
            const measuredWidth = event.nativeEvent.layout.width;
            if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
                measuredContainerWidthRef.current = measuredWidth;
                const nextColumnCount = resolveColumnCountForWidth(measuredWidth);
                setColumnCount((current) => (current === nextColumnCount ? current : nextColumnCount));
            }
        }
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
    }, [
        clearStabilizedHeightTimer,
        columns,
        props.maxHeight,
        resolveColumnCountForWidth,
        scheduleStabilizedHeightRelease,
        stabilizeHeight,
    ]);
    const heightStabilityKey = React.useMemo(() => (
        virtualizedOptionSource
            ? `source:${virtualizedOptionSource.items.length}:${virtualizedOptionSource.optionCount}`
            : renderPlan
                .map((sectionPlan) => [
                    sectionPlan.id,
                    sectionPlan.dynamicState ?? 'static',
                    sectionPlan.options.length,
                ].join(':'))
                .join('|')
    ), [renderPlan, virtualizedOptionSource]);
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
    const measuredPopoverHeight = useSelectionListMeasuredPopoverHeight({
        enabled: measureNativeHeight,
        maxHeight: props.maxHeight,
        headerExpected: showSearchHeader,
        footerExpected: keyboardHintsEnabled,
        shrinkDelayMs: STABILIZED_HEIGHT_SHRINK_DELAY_MS,
    });
    /**
     * R1 — SelectionList is the SINGLE owner of the offscreen body
     * measurement. Two consumers ask the same question about the same
     * subtree: `useSelectionListMeasuredPopoverHeight` (the container's
     * concrete native height) and `SelectionListAnimatedHeight` (the
     * step-transition target). They used to answer it with a hidden mirror
     * each, so the native popover path mounted every row THREE times per
     * open — the visible body plus two invisible copies, all of it on the
     * critical path because the container stays `opacity: 0` until the first
     * measurement lands. One host now measures, and republishes.
     *
     * The two consumers' clamps still differ, and both survive: this host is
     * capped at the popover's `maxHeight` (a constant prop, so no feedback
     * loop into the height it is used to compute), and the animator applies
     * its own upper bound — the wrapper's last natural height — to the value
     * it receives. `min` composes, so the animator's target is unchanged.
     */
    const [measuredBody, setMeasuredBody] = React.useState<MeasuredStepBodyHeight | null>(null);
    const measuredPopoverBodyLayout = measuredPopoverHeight.onBodyLayout;
    const measuredStepId = currentStep.id;
    const handleBodyMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (measureNativeHeight) {
            measuredPopoverBodyLayout(event);
        }
        const measured = event.nativeEvent.layout.height;
        if (!Number.isFinite(measured) || measured <= 0) return;
        const next = Math.ceil(measured);
        setMeasuredBody((current) => (
            current !== null
                && current.stepId === measuredStepId
                && Math.abs(current.height - next) <= 1
                ? current
                : { stepId: measuredStepId, height: next }
        ));
    }, [measureNativeHeight, measuredPopoverBodyLayout, measuredStepId]);
    /**
     * The measurement is tagged with the step it was taken for, and only
     * republished to the animator once it matches the step on screen. Without
     * the tag the animator would receive the OUTGOING step's height at the
     * instant it pins — a value that is stale by construction — and animate
     * toward it before the real one arrived.
     */
    const measuredCurrentStepBodyHeight = measuredBody !== null && measuredBody.stepId === currentStep.id
        ? measuredBody.height
        : undefined;
    const fixedMaxHeight = props.heightBehavior === 'fixedToMaxHeight'
        && typeof props.maxHeight === 'number'
        && Number.isFinite(props.maxHeight)
        && props.maxHeight > 0
        ? props.maxHeight
        : undefined;
    const fixedHeight = fixedMaxHeight ?? measuredPopoverHeight.height;
    const useContentSizedFrame = fixedHeight === undefined && props.fillAvailableSpace !== true;
    const containerStyle: StyleProp<ViewStyle> = [
        styles.container,
        props.fillAvailableSpace === true ? styles.containerFill : null,
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
        () => resolveSelectionListListboxDomId(resolvedTestId),
        [resolvedTestId],
    );
    // The popup's ARIA pattern. Resolved ONCE, here, from the caller's declared
    // capabilities — never from the plan, the selection, or the measured column
    // count, all of which move while the popup is open (see
    // `resolveSelectionListA11yPattern` for the two shipped defects that
    // proves). The combobox input advertises it through `aria-haspopup` and the
    // body publishes the same value to every row path, so the container, row
    // and cell roles cannot disagree.
    const popupA11yPattern = React.useMemo(
        () => resolveSelectionListA11yPattern({
            declaresColumns: props.columns !== undefined,
            declaresInlineRowControls: props.optionsHostInlineControls === true,
        }),
        [props.columns, props.optionsHostInlineControls],
    );
    const activeDescendantId = focusedOption
        ? resolveSelectionListOptionDomId({
            option: focusedOption,
            rootTestID: resolvedTestId,
            stepId: currentStep.id,
        })
        : undefined;

    const listBody = (
        <SelectionListBody
            step={currentStep}
            rootTestID={resolvedTestId}
            selectedOptionId={props.selectedOptionId ?? null}
            plan={renderPlan}
            virtualizedOptionSource={virtualizedOptionSource}
            focusedOptionId={focusedOptionId}
            focusedOptionIndex={virtualizedOptionSource === undefined ? undefined : focus.focusedIndex}
            scrollTargetOptionId={props.activeScrollOptionId ?? focusedOptionId ?? props.selectedOptionId ?? null}
            listboxId={listboxId}
            accessibilityLabel={props.listAccessibilityLabel}
            onSelect={props.onSelect}
            onPushStep={handlePushStep}
            showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            pagination={props.pagination}
            columnCount={columnCount}
            columnGapPx={columns?.columnGapPx}
            declaresColumns={columns !== undefined}
            optionPresentation={props.optionPresentation}
            a11yPattern={popupA11yPattern}
        />
    );
    const body = props.contentState !== undefined ? (
        <View style={styles.content}>{props.contentState}</View>
    ) : listBody;

    // FR3-1 / FR3-8 — identity-free measure mirror. An explicit
    // `mode='measure'` SelectionListBody, so the hidden measure subtree never
    // emits duplicate listbox / option testIDs, aria-* props, or roles in the
    // live DOM. The boundary is expressed at the API level instead of relying
    // on post-hoc cloneElement identity stripping.
    const measureBody = (
        <SelectionListBody
            mode="measure"
            step={currentStep}
            rootTestID={resolvedTestId}
            selectedOptionId={props.selectedOptionId ?? null}
            plan={renderPlan}
            virtualizedOptionSource={virtualizedOptionSource}
            focusedOptionId={focusedOptionId}
            focusedOptionIndex={virtualizedOptionSource === undefined ? undefined : focus.focusedIndex}
            listboxId={listboxId}
            accessibilityLabel={props.listAccessibilityLabel}
            onSelect={props.onSelect}
            onPushStep={handlePushStep}
            showsVerticalScrollIndicator={props.showsVerticalScrollIndicator === true}
            pagination={props.pagination}
            columnCount={columnCount}
            columnGapPx={columns?.columnGapPx}
            declaresColumns={columns !== undefined}
            optionPresentation={props.optionPresentation}
            a11yPattern={popupA11yPattern}
        />
    );

    const disableTransitions = props.disableTransitions === true || detectedReducedMotion;
    /**
     * Mount the measure mirror only when a consumer actually reads it: the
     * measured-native container height, or the step-transition animator. With
     * transitions off AND a non-measured height behavior nothing consumes a
     * measurement, and the body mounts exactly once.
     */
    const renderMeasureHost = measureNativeHeight || !disableTransitions;

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
            onLayout={stabilizeHeight || columns !== undefined ? handleContainerLayout : undefined}
            {...headerlessKeyHandler}
        >
            {renderMeasureHost ? (
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
                        inputTestID={props.inputTestID}
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
                        popupRole={popupA11yPattern}
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
                    // height (published from the single offscreen measure
                    // host above), and releases back to `auto` on
                    // completion. Reduced motion: snaps without animation.
                    <SelectionListAnimatedHeight
                        stepKey={currentStep.id}
                        measuredContentHeight={measuredCurrentStepBodyHeight}
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
