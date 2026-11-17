import type * as React from 'react';
import type { ThemeSelectionSurfaceBinding } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { SelectionListDynamicSectionCache } from './selectionListDynamicSectionCache';

import { SELECTION_LIST_STATUS_VARIANTS } from '@happier-dev/plugin-ui/components';
export { SELECTION_LIST_STATUS_VARIANTS };
import type { SelectionListOptionVisualState } from '@happier-dev/plugin-ui/components';
export type { SelectionListOptionVisualState };
import type { SelectionListLazyVisual } from '@happier-dev/plugin-ui/components';
export type { SelectionListLazyVisual };
import type { SelectionListAccessory } from '@happier-dev/plugin-ui/components';
export type { SelectionListAccessory };
import type { SelectionListTextEllipsizeMode } from '@happier-dev/plugin-ui/components';
export type { SelectionListTextEllipsizeMode };
import type { SelectionListKeyboardHint } from '@happier-dev/plugin-ui/components';
export type { SelectionListKeyboardHint };
import type { SelectionListStatusVariant } from '@happier-dev/plugin-ui/components';
export type { SelectionListStatusVariant };
import type { SelectionListOption as PortableSelectionListOption } from '@happier-dev/plugin-ui/components';
export type SelectionListOption = PortableSelectionListOption<CurrentUiContextCommandInvocation>;
import type { SelectionListVirtualizedOptionSourceItem } from '@happier-dev/plugin-ui/components';
export type { SelectionListVirtualizedOptionSourceItem };
import type { SelectionListVirtualizedOptionSourceHeader } from '@happier-dev/plugin-ui/components';
export type { SelectionListVirtualizedOptionSourceHeader };
import type { SelectionListVirtualizedOptionSource as PortableSelectionListVirtualizedOptionSource } from '@happier-dev/plugin-ui/components';
export type SelectionListVirtualizedOptionSource = PortableSelectionListVirtualizedOptionSource<CurrentUiContextCommandInvocation>;
import type { SelectionListVirtualizationMode } from '@happier-dev/plugin-ui/components';
export type { SelectionListVirtualizationMode };
import type { SelectionListSectionAction } from '@happier-dev/plugin-ui/components';
export type { SelectionListSectionAction };
import type { SelectionListSection as PortableSelectionListSection } from '@happier-dev/plugin-ui/components';
export type SelectionListSection = PortableSelectionListSection<CurrentUiContextCommandInvocation>;
import type { SelectionListDynamicSectionResolveResult as PortableSelectionListDynamicSectionResolveResult } from '@happier-dev/plugin-ui/components';
export type SelectionListDynamicSectionResolveResult = PortableSelectionListDynamicSectionResolveResult<CurrentUiContextCommandInvocation>;
import type { SelectionListDynamicSection as PortableSelectionListDynamicSection } from '@happier-dev/plugin-ui/components';
export type SelectionListDynamicSection = PortableSelectionListDynamicSection<CurrentUiContextCommandInvocation>;
import type { SelectionListSectionDescriptor as PortableSelectionListSectionDescriptor } from '@happier-dev/plugin-ui/components';
export type SelectionListSectionDescriptor = PortableSelectionListSectionDescriptor<CurrentUiContextCommandInvocation>;
import type { SelectionListStep as PortableSelectionListStep } from '@happier-dev/plugin-ui/components';
export type SelectionListStep = PortableSelectionListStep<CurrentUiContextCommandInvocation>;
import type { SelectionListInputMode } from '@happier-dev/plugin-ui/components';
export type { SelectionListInputMode };
import type { SelectionListHeightBehavior } from '@happier-dev/plugin-ui/components';
export type { SelectionListHeightBehavior };
import type { SelectionListPagination } from '@happier-dev/plugin-ui/components';
export type { SelectionListPagination };

/**
 * Adapter that maps the raw input string into domain-specific concepts
 * (filter query, dynamic-section seed, walk-up replacement, autocomplete
 * suppression). All members are optional — when omitted, the library falls
 * back to the documented default behavior. Path / URL / env-var / JSON-pointer
 * adapters live in their own domain folder and plug in via this interface
 * (see `apps/ui/sources/utils/path/browseInputBehavior.ts`).
 */
export type SelectionListInputBehavior = Readonly<{
    /**
     * Returns the substring of the raw input that should be used to filter rows.
     * Default: identity (the whole input is the query).
     */
    getFilterQueryFromInput?: (input: string) => string;
    /**
     * Returns the seed passed to dynamic sections' `resolve(seed)`.
     * Default: identity.
     */
    getDynamicSectionSeed?: (input: string) => string;
    /**
     * Called when the user presses Backspace with caret at the end of the input
     * AND text composition is inactive. Return a new input value to override
     * default backspace behavior. Return null to fall through to native
     * backspace.
     */
    onBackspaceAtEnd?: (input: string) => string | null;
    /**
     * RUX-13: called when the user presses Shift+Tab AND the SelectionList
     * step stack is already at the root (i.e. there's no parent step to pop
     * back to). Should walk the input up one segment regardless of trailing-
     * separator state — Shift+Tab is an EXPLICIT user intent to back up,
     * unlike Backspace which conservatively requires a trailing separator.
     * Return the new input value, or `null` when there is no parent (e.g.
     * input is empty or already at the platform root). Returning `null`
     * makes the keyboard handler fall through to native focus traversal.
     */
    onBackUp?: (input: string) => string | null;
    /**
     * Generic predicate that gates the autocomplete ghost. Return true to
     * suppress the ghost for the current input (e.g. paths return true when
     * input ends with any separator OR when the input is at root). Default:
     * never suppress.
     *
     * NOTE: this is intentionally a predicate, NOT a single-character match.
     * Path-shaped inputs need to suppress on `/` AND `\\` AND root sequences;
     * future tokenized inputs (e.g. JSON pointers) may have entirely
     * different rules.
     */
    shouldSuppressAutocomplete?: (input: string) => boolean;
}>;

// NOTE: there is intentionally NO `SelectionListPathTargetPlatform` type in
// SelectionList. Path/Windows-vs-Unix is a path-domain concept and must not
// leak into the generic SelectionList types. Path adapters (in
// `apps/ui/sources/utils/path/`) own their own target-platform type and
// parameterise their helpers accordingly.

/**
 * Quick-action keyboard shortcut binding. The orchestrator forwards these to
 * `useSelectionListKeyboardNav`, which dispatches the matching shortcut to the
 * targeted option's activation handler. Currently only `'cmd+n'` is wired —
 * additional shortcuts can be added via the hook without changing this contract.
 */
export type SelectionListQuickActionShortcut = Readonly<{
    /** Keyboard binding identifier (e.g. `'cmd+n'`). */
    shortcut: 'cmd+n';
    /** Stable id of the option to activate when the shortcut fires. */
    optionId: string;
}>;

/**
 * Multi-column row layout for a SelectionList.
 *
 * Column count is decided from the list's OWN measured width, never from the
 * window: a SelectionList commonly lives in a `flex: 1` pane beside a fixed
 * rail inside a capped popover, where window width says nothing about the room
 * a row actually gets. Until the first layout arrives the list renders one
 * column, so the fallback is always the safe one.
 *
 * Everything else — filtering, ranking, sections, steps, keyboard navigation,
 * virtualization, ARIA — is inherited unchanged. Only the visual arrangement
 * and the meaning of ↑/↓/←/→ change.
 */
export type SelectionListColumnsLayout = Readonly<{
    /** Upper bound on columns. The measured width may resolve fewer. */
    max: number;
    /**
     * Narrowest a column may become before collapsing back to one column.
     *
     * Defaults to the shared list-column minimum (320px), which is tuned for
     * FULL-WIDTH settings lists and needs ~652px to fit two columns. A popover
     * pane is nowhere near that, so a popover-hosted list MUST pass its own
     * (smaller) minimum or it will resolve to a single column forever.
     */
    minColumnWidthPx?: number;
    /**
     * Gutter between adjacent columns. Defaults to the shared list gutter.
     *
     * Used for BOTH halves of the decision: how much width the gutters consume
     * when resolving the column count, and the gap actually painted between
     * cells. (It previously only fed the resolver, so a caller widening the
     * gutter got columns narrower than the `minColumnWidthPx` it declared.)
     */
    columnGapPx?: number;
}>;

/**
 * How an option row presents itself.
 *
 * `'row'` — the default and the untouched path: flush rows whose selected fill
 *   spans the full list width, exactly as every existing consumer renders
 *   today.
 *
 * `'card'` — each option becomes its own rounded surface that OWNS its fill
 *   and clips its children. Three things follow from that and none of them are
 *   expressible at a call site:
 *     - the card is the positioning context for the row's trailing accessory,
 *       which becomes an absolute top-right overlay and therefore costs zero
 *       layout height (in-flow stacking grew the row by ~20px);
 *     - the card wraps BOTH the row and its `expandedContent`, so a selected
 *       option and its inline controls read as ONE shape rather than a row
 *       plus a separately-tinted panel;
 *     - the card becomes the single owner of the selected fill, so the row
 *       beneath must stop painting its own square one.
 *
 * Unselected cards paint `surface.base` and are therefore invisible on a base
 * pane BY DESIGN — only the selected card is meant to read as an envelope.
 */
export type SelectionListOptionPresentation = 'row' | 'menu' | 'card' | 'section';
// `'section'`: a settings body whose own `ItemGroup` slots share the list (Board settings) — section
// titles and rows sit on the grouped section's insets, so the panel has one left edge.

export type SelectionListSelection =
    | Readonly<{ kind: 'single'; selectedId: string | null }>
    | Readonly<{ kind: 'multiple'; selectedIds: ReadonlySet<string> }>;

/** One choice of a {@link SelectionListFilter}. */
export type SelectionListFilterOption = Readonly<{
    id: string;
    /** Already-translated label. */
    label: string;
    subtitle?: string;
    /** A leading mark (an Agent's brand mark), shown in the popover row and, when selected, the chip. */
    icon?: React.ReactNode;
    /** A quiet trailing fact for the row (an identity colour swatch); never a control. */
    accessory?: React.ReactNode;
    disabled?: boolean;
}>;

/**
 * A filter chip: what is being chosen, its current value and how to change it. Single choice, or
 * several at once with `selectedIds` (the popover stays open and each row toggles).
 *
 * The popover lists `options` (a small `SelectionList`), unless the filter's canonical owner draws
 * its own chooser (`renderPopoverContent`, e.g. the machine list the machine owner already has).
 * A filter with neither is a fixed scope: the chip shows the value and does not open.
 */
export type SelectionListFilter = Readonly<{
    id: string;
    /** What is being chosen ("Agent", "Machine"): the chip's accessible name is `<label>: <value>`. */
    label: string;
    /** The chip text; defaults to the selected option's label. */
    valueLabel?: string;
    /**
     * A shorter chip text for the chip row beneath the field (a phone's width), where a long value
     * would be cut. The accessible name and the chip beside the field keep `valueLabel`.
     */
    rowValueLabel?: string;
    /** The chip's leading glyph; defaults to the selected option's icon. */
    icon?: React.ReactNode;
    /**
     * A dot after the value: the presence of what the value names (a machine), or `attention` when
     * what the filter covers is incomplete (a source still being read). Omitted: no dot.
     */
    presence?: 'online' | 'offline' | 'attention';
    /**
     * One quiet word after the value that says how it came to be the value ("Studio Mac  Auto": picked for
     * the viewer, not chosen by them). Never a count or a state; omit it for a value the viewer chose.
     */
    note?: string;
    /**
     * The part of the value that tells it apart from a same-named sibling (a Machine's short id). It stays whole
     * and visible while `valueLabel` shortens, and joins the value in the accessibility label.
     */
    valueQualifier?: string;
    /**
     * Draw only the leading glyph (with the presence dot and the open caret) where the room is not
     * the chip's: a phone's navigation header beside the page title and its action. The accessible
     * name and the popover keep the whole value. A filter without a glyph keeps its text.
     */
    iconOnly?: boolean;
    /** Draw the filter's name, quieter, before its value ("Agents  Claude, Codex"). */
    showLabel?: boolean;
    /**
     * The filter sets where the search looks (a Machine, a Home). It stays on the field's row at every
     * width, while other filters move beneath a narrow field, and before it has a value the chip reads
     * as the filter's name ("Machine") rather than the placeholder value; the accessible name keeps both.
     */
    pairsWithSearch?: boolean;
    /** The filter narrows what is shown: the chip takes the accent edge so a narrowed view is never missed. */
    active?: boolean;
    /** The value is a placeholder ("Choose a machine") rather than a choice. */
    muted?: boolean;
    options?: ReadonlyArray<SelectionListFilterOption>;
    selectedId?: string | null;
    /** Several choices at once: these rows are checked, the popover stays open, `onChange` gets the toggled id. */
    selectedIds?: ReadonlySet<string>;
    onChange?: (id: string, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => void;
    /** The canonical owner's own chooser. `close` dismisses the popover. */
    renderPopoverContent?: (context: Readonly<{ close: () => void; maxHeight: number }>) => React.ReactNode;
    /** Controlled popover state, for a page state that opens the filter ("Choose another"). */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    /** How many things the filter leaves in view ("Changed only 14"), after the value in a quieter tone. */
    count?: string;
    /**
     * Hold the count's two-digit slot while it is not known yet, so a chip that gains its count
     * ("All" then "All 5") keeps its width and its neighbours stay where they were drawn.
     */
    reserveCount?: boolean;
    /** Hold the presence dot's slot while there is no dot, so a dot that appears later moves nothing. */
    reservePresence?: boolean;
    /**
     * An on/off filter that is on: the chip ends in × and pressing it turns the filter off. Such a
     * chip has no chooser; `clearAccessibilityLabel` names what pressing it does ("Show all files").
     */
    onClear?: (context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => void;
    clearAccessibilityLabel?: string;
    /**
     * An on/off choice drawn as a chip ("Also add to: ✓ Home"): pressing it turns it on or off. It has no
     * chooser; `selected` draws the check and the accent edge, and announces the chip as checked.
     */
    onToggle?: (context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => void;
    selected?: boolean;
    /**
     * A destination, not a filter (a phone Store's Installed, Updates and kinds): pressing the chip opens that
     * page. It has no chooser and no caret; `count` follows its name and joins its accessible name.
     */
    onPress?: () => void;
    /** The chip's testID; its popover list is `<testID>.list` and each option `<testID>:<optionId>`. */
    testID?: string;
    /** What else the chip's value means ("Changed for this step"), announced after its name. */
    accessibilityHint?: string;
}>;

export type SelectionListProps = Readonly<{
    /** Addresses supplied by the picker owner; ordinary lists retain their existing presentation. */
    themeSurface?: ThemeSelectionSurfaceBinding;
    /** Opt this mounted chooser into the current page's shared UI/agent command path. */
    currentUiContextCommandScope?: string;
    /** The containing overlay opts in; inline lists keep the page's command projection. */
    currentUiContextForegroundOverlay?: boolean;
    /** `none` lays the picker flat on its host; the default paints the base surface. */
    surface?: 'base' | 'none';
    /** Root step. Pushes accumulate above this. */
    rootStep: SelectionListStep;
    /**
     * Controlled mirror of the consumer's active step. While defined:
     *   - a step whose id is mounted is refreshed in place (content rebuild,
     *     never navigation, never remount, query and focus preserved);
     *   - `null` pops the list back to the root;
     *   - an unmounted id is pushed.
     *
     * Pushed steps are snapshots, so a route-sized consumer that owns its own
     * step state republishes the active step here to keep hydration and
     * pagination flowing into it. Leave undefined for fully uncontrolled lists.
     */
    syncActiveStep?: SelectionListStep | null;
    /**
     * Called when the mounted step ID changes (mount, push, pop, drain). Not
     * called for same-id content refreshes, which are not navigation.
     */
    onActiveStepChange?: (step: SelectionListStep) => void;
    /** Accessible name for the owned listbox. */
    listAccessibilityLabel?: string;
    /** Currently-selected option id (rendered with selected style). Optional. */
    selectedOptionId?: string | null;
    /**
     * Controlled selection state. Existing single-select callers may keep using
     * `selectedOptionId`; it is normalized to the single branch once inside the
     * orchestrator. Multiple selection never owns keyboard focus and never
     * closes the list when a row is toggled.
     */
    selection?: SelectionListSelection;
    /**
     * Optional externally-owned active row for scroll-into-view. Most
     * SelectionList surfaces use internal keyboard focus; externally-keyed
     * popovers such as slash autocomplete can pass their own highlighted row.
     */
    activeScrollOptionId?: string | null;
    /**
     * `'search'` (default): input filters the list; Enter on the input commits
     * the focused row.
     * `'value'`: input is the candidate value; Enter on the input commits the
     * raw input value unless a row was explicitly focused by keyboard
     * navigation (then row's onSelect wins).
     */
    inputMode?: SelectionListInputMode;
    /** Tokenization adapter; controls how typed input maps to filter / dynamic seed / walk-up. */
    inputBehavior?: SelectionListInputBehavior;
    /**
     * Optional cache owner for dynamic results. Universal Search injects an
     * auth-lifetime cache so private rows and activation closures never enter
     * the process-wide picker cache; existing pickers retain the default.
     */
    dynamicSectionCache?: SelectionListDynamicSectionCache;
    /**
     * Where the canonical search/value input sits relative to the results.
     *
     * `'top'` (default) is the incumbent composition. `'bottom'` seats the very
     * same input — one query, one ref, one `aria-controls`/`aria-activedescendant`
     * relationship, one scroll owner — beneath the results, for keyboard-seated
     * surfaces where the field must stay directly above the software keyboard.
     * `'body'` seats it after `bodyHeader`, inside the scroll body, as a bordered
     * field, for a pane that scrolls as one. No placement creates a second
     * TextInput or a second query state.
     */
    inputPlacement?: 'top' | 'bottom' | 'body';
    /**
     * `'check'` (default): the current choice of a single-choice list carries a trailing check (the
     * picker anatomy). `'none'`: the options draw their own selection state — a list of per-group
     * radios (one choice per connected service) whose `selectedOptionId` only seeds focus.
     * `'enter'`: the rows are commands, not choices (the ⌘K palette). The row the keyboard is on
     * shows the ↵ it runs with, only while a hardware keyboard is present (`keyboardHintsEnabled`).
     */
    selectionMark?: 'check' | 'enter' | 'none';
    /**
     * Content a picker shows above its rows (a pane title, a status line, a notice) that must scroll
     * WITH the rows. It renders inside the body's one scroll owner, before the first section, and
     * stays mounted in every body state (rows, empty). Not part of the measured height: a list with
     * body slots sizes itself from its container (`fillAvailableSpace` / `maxHeight`).
     */
    bodyHeader?: React.ReactNode;
    /** Content after the last row that scrolls with the rows (a "Custom…" entry). See `bodyHeader`. */
    bodyFooter?: React.ReactNode;
    /**
     * The one action the list commits to as a whole ("Replace in 3 files"), seated at the footer's
     * trailing edge beside the keyboard hints. Unlike the hints it also renders on touch devices, where
     * the footer then holds only this action. Row-level actions still belong to their rows.
     */
    footerAction?: React.ReactNode;
    /**
     * A row pinned under the scroller and above the keyboard hints ("New session…"). It never moves
     * while the list filters. Unlike `bodyFooter` it does not scroll with the rows.
     */
    pinnedRow?: React.ReactNode;
    /** Optional element rendered to the left of the input (e.g. folder icon). */
    inputPrefix?: React.ReactNode;
    /** Notified when the search field gains focus (a host revealing rows only once someone starts adding). */
    onInputFocus?: () => void;
    /**
     * Optional element rendered inside the input field on the right side. Use
     * this for functional actions (e.g. "Open tree browser" button) — they
     * always render regardless of input modality. The footer is reserved for
     * keyboard hints only.
     */
    inputSuffix?: React.ReactNode;
    /**
     * Optional row of controls beneath the search field (filter chips that do not fit beside it on a
     * phone). It belongs to the header zone, so it stays on screen in every content state and
     * never scrolls with the results.
     */
    inputAccessoryRow?: React.ReactNode;
    /**
     * Filters that narrow what the list shows (machine, Agent, source, Home). Each renders as one
     * compact chip beside the search field — or on its own row beneath it when the list is too
     * narrow for both — and opens a small popover to change its value. The consumer owns what a
     * filter means; SelectionList owns how filters look and behave.
     */
    filters?: ReadonlyArray<SelectionListFilter>;
    /** Optional controlled input value. Library is uncontrolled when omitted. */
    inputValue?: string;
    /** Optional visual truncation for the input value (useful for path-like values). */
    inputValueEllipsizeMode?: SelectionListTextEllipsizeMode;
    onChangeInputValue?: (next: string) => void;
    /** Called when an option is selected (may close the popover). */
    onSelect: (id: string, option: SelectionListOption, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => void;
    /**
     * Cmd/Ctrl+Enter on the focused row: the row's secondary commit ("Add and place"). Without it,
     * Cmd/Ctrl+Enter selects like Enter.
     */
    onCommandSelect?: (id: string, option: SelectionListOption) => void;
    /**
     * Called when the user commits the raw input value (only when
     * `inputMode === 'value'` and Enter is pressed without a focused row).
     * Receives the current input string.
     */
    onCommitInputValue?: (input: string) => void;
    /** Called when the user explicitly closes (Escape after stack drains). */
    onRequestClose: (context?: ActionExecutorContext) => void;
    /** Render keyboard hints only with a detected hardware keyboard; false opts out even on desktop. */
    keyboardHintsEnabled?: boolean;
    /**
     * Focus the search/value input when this list mounts or changes step on web.
     * Ignored on native so opening a popover/modal never summons the software keyboard.
     */
    autoFocusInputOnWeb?: boolean;
    /**
     * Focus the search/value input on iOS/Android, summoning the software keyboard.
     *
     * Deliberately separate from the web opt-in rather than one platform-blind flag: a picker or
     * popover opening on a phone must NOT raise the keyboard, while a surface the user explicitly
     * opened to type into — the keyboard-seated universal Search plane — must. Each caller states
     * the platform intent it actually wants.
     */
    autoFocusInputOnNative?: boolean;
    /** Disable internal step transitions for testing. */
    disableTransitions?: boolean;
    /** Stable testID root (default 'selection-list'). */
    testID?: string;
    /** Optional stable consumer-facing test id for the editable search/value input. */
    inputTestID?: string;
    /** Cap container height; defaults to undefined (popover-driven). */
    maxHeight?: number;
    /**
     * Whether the owned scroll hosts should show the platform vertical scroll
     * indicator. Defaults to false so compact popovers keep their chrome quiet.
     */
    showsVerticalScrollIndicator?: boolean;
    /** Optional cursor pagination state. Forces one virtualized scroll owner. */
    pagination?: SelectionListPagination;
    /** Replaces the rows with an owner-supplied loading/error/offline state. */
    contentState?: React.ReactNode;
    /**
     * Height policy for the outer list container.
     *
     * - `content` (default): natural content height, capped by `maxHeight`.
     * - `fixedToMaxHeight`: use `maxHeight` as the actual height as well as
     *   the cap. Use only when the surface is intentionally a fixed viewport.
     * - `stabilizedContentHeight`: natural content height capped by
     *   `maxHeight`, with immediate growth and debounced shrink. Dynamic
     *   popovers use this to avoid per-keystroke height jitter without
     *   forcing empty space.
     * - `measuredToMaxHeight`: measure the body/header/footer segments and
     *   use a concrete native height of `min(contentHeight, maxHeight)`.
     *   The first paint stays hidden at the max-height fallback until a real
     *   measurement exists, and later shrink updates are debounced.
     */
    heightBehavior?: SelectionListHeightBehavior;
    /**
     * A column beside the list for the active row's `detailContent` (Find lab G1s preview), shown only while
     * the list is at least `minListWidthPx` wide; narrower, rows carry their own detail
     * (`SelectionListDetailPaneContext` says which).
     */
    detailPane?: Readonly<{ minListWidthPx: number; widthPx: number }>;
    /** Fill the parent's flex viewport while keeping SelectionList as the sole scroll owner. */
    fillAvailableSpace?: boolean;
    /**
     * Optional keyboard shortcuts that activate a specific option by id (e.g.
     * Cmd+N → "Create new worktree"). Forwarded to
     * `useSelectionListKeyboardNav`; does NOT bypass the option's `disabled`
     * guard.
     */
    quickActionShortcuts?: ReadonlyArray<SelectionListQuickActionShortcut>;
    /**
     * Arrange option rows into a responsive grid instead of a single stack.
     * Omit for the classic one-row-per-option list.
     */
    columns?: SelectionListColumnsLayout;
    /**
     * Visual presentation for option rows. Defaults to `'row'` — the tree every
     * existing consumer already renders. See {@link SelectionListOptionPresentation}.
     */
    optionPresentation?: SelectionListOptionPresentation;
    /**
     * DECLARE that option rows may host interactive `expandedContent` (inline
     * segmented controls, switches) while this list is open.
     *
     * A popup whose rows hold interactive controls is a grid, not a listbox
     * (WAI-ARIA APG, "combobox with grid popup"), and a composite widget may
     * not change pattern mid-interaction. So this is a declaration and not
     * something the list detects: whether an option carries `expandedContent`
     * right now depends on the selection, and the shipped picker rebuilds its
     * options from the selection on every change.
     *
     * Omit it — as every list without inline row controls does — and the list
     * emits exactly the `listbox`/`option` markup it always has. Declaring it
     * without ever rendering `expandedContent` is safe (a one-column grid);
     * rendering `expandedContent` without declaring it is not, and is the one
     * shape this contract asks callers to avoid.
     */
    optionsHostInlineControls?: boolean;
}>;
