import type * as React from 'react';

/**
 * Type definitions for the SelectionList primitive.
 *
 * Phase 1.2 (Lane A) introduced the base shapes (option / static section
 * descriptor / step). Phase 2.1 (Lane B) extends them with the advanced
 * surface: `SelectionListInputBehavior`, `SelectionListOption.autocompleteValue`,
 * `SelectionListDynamicSection`, the dynamic branch of
 * `SelectionListSectionDescriptor`, and the input-mode / behavior / prefix /
 * suffix / value props on `SelectionListProps`. All additions are optional —
 * existing Phase 1 consumers compile unchanged.
 *
 * NOTE: there is intentionally NO `SelectionListFooterAction` type. Functional
 * actions render in the input field's right-side `inputSuffix` slot, not the
 * footer. The footer renders only keyboard hints and is hidden on touch devices.
 *
 * NOTE: there is intentionally NO `SelectionListPathTargetPlatform` type.
 * Path/Windows-vs-Unix is a path-domain concept owned by the path adapter
 * (`apps/ui/sources/utils/path/browseSegments.ts`), NOT generic SelectionList types.
 */

export type SelectionListAccessory = React.ReactNode | (() => React.ReactNode);
export type SelectionListTextEllipsizeMode = 'head' | 'middle' | 'tail' | 'clip';

export type SelectionListKeyboardHint = Readonly<{
    /** Stable id used for testIDs and registry mapping later. */
    id: string;
    /** Display label as rendered in the KeyChip; e.g. '↵', '⌘N', '↑↓', 'Tab'. */
    label: string;
    /** Optional supporting text shown next to the chip in the footer. */
    description?: string;
}>;

/**
 * Status variants used by `StatusPill` and the worktree picker. Listed as a runtime
 * tuple so consumers (and tests) can iterate without retyping the union literally.
 */
export const SELECTION_LIST_STATUS_VARIANTS = [
    'clean',
    'dirty',
    'stale',
    'info',
    'neutral',
] as const;

export type SelectionListStatusVariant = (typeof SELECTION_LIST_STATUS_VARIANTS)[number];

/**
 * Fields shared by both branches of the `SelectionListOption` discriminated
 * union. Authors should not consume this type directly — use
 * `SelectionListOption` so the discriminator is checked at the type level.
 */
type SelectionListOptionBase = Readonly<{
    id: string;
    /**
     * Optional legacy/consumer-facing row testID alias rendered in addition to
     * SelectionList's canonical option wrapper id. Prefer the canonical
     * SelectionList ids for new tests; use this only to preserve existing UI
     * e2e selector contracts during migrations.
     */
    testID?: string;
    label: string;
    /**
     * Optional full-row body. When present, SelectionList still owns row
     * activation, selected/focused styling, a11y ids, and scroll-into-view,
     * while the consumer owns the inner visual content.
     */
    content?: React.ReactNode;
    subtitle?: string;
    /** Optional assistive label for rows whose visible label repeats across sections. */
    accessibilityLabel?: string;
    labelEllipsizeMode?: SelectionListTextEllipsizeMode;
    subtitleEllipsizeMode?: SelectionListTextEllipsizeMode;
    icon?: React.ReactNode;
    /** Right-side accessory (status pill, relative time, key chip, etc.) */
    rightAccessory?: SelectionListAccessory;
    /**
     * When `true`, the navigation chevron is kept VISIBLE even though the row
     * also renders a `rightAccessory`. By default a right accessory suppresses
     * the chevron (the accessory owns the right slot); set this on rows that
     * BOTH carry a status badge AND navigate to a sub-step (`openStep`), so the
     * user still sees there's a further step. No effect without `openStep`.
     */
    keepChevronWithAccessory?: boolean;
    /**
     * Value-mode affordance: when `true`, activating this row (tap or Enter on a
     * focused row) does NOT select/commit — instead it asks the SelectionList to
     * draw attention to the input field (focus + a brief shake). Used by the
     * "type a name" combobox row while the field is empty, so tapping it prompts
     * the user to type rather than silently committing a fallback. The row owner
     * (e.g. `buildInputRow`) sets this only while input is empty and clears it
     * once a value is typed (at which point its `onSelect` commits normally).
     */
    requiresInputValue?: boolean;
    /**
     * Full input value to substitute when the user accepts the autocomplete
     * (Tab anywhere, or → when caret is at end-of-input AND ghost suffix is
     * present). When set on a dynamic-section row, the row also exposes a
     * drill-down chevron on touch.
     */
    autocompleteValue?: string;
    /** Disable the row entirely. */
    disabled?: boolean;
    /**
     * Show the canonical row-level pending affordance (`Item`'s spinner) while
     * retaining the row's identity and position. Use for a row whose activation
     * starts async work; a skeleton or a removed row would move every sibling
     * and destroy the focused/selected identity. A pending row is not
     * activatable.
     */
    loading?: boolean;
}>;

/**
 * Discriminated union — a row activation is EITHER a "select" (calls
 * `onSelect` and bubbles the parent's `onSelect`) OR a "navigate" (pushes
 * `openStep` onto the SelectionList step stack). The two branches are mutually
 * exclusive at the type level so consumers cannot accidentally declare both
 * without TypeScript flagging the `never` collision.
 *
 *   - **Select branch** — `openStep` MUST be `undefined`; `onSelect` is the
 *     optional row-specific callback invoked before the orchestrator's
 *     top-level `onSelect`.
 *   - **Step branch** — `openStep` is the next step to push; `onSelect` MUST
 *     be `undefined`. The orchestrator handles the push and never calls the
 *     parent's top-level `onSelect` for this row.
 */
export type SelectionListOption =
    | (SelectionListOptionBase & Readonly<{
        /** When the option just selects (default), called on press / Enter. */
        onSelect?: () => void;
        openStep?: undefined;
    }>)
    | (SelectionListOptionBase & Readonly<{
        /** When set, tapping pushes a new step instead of selecting. */
        openStep: SelectionListStep;
        onSelect?: undefined;
    }>);

/**
 * Per-section virtualization control. `'auto'` (the default) switches to
 * FlashList when the row count exceeds
 * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD` (50, per Phase 0.5). `'force'`
 * always uses FlashList; `'never'` always plain-maps rows under `Item`/
 * `ItemGroup`. Set at the descriptor level so authors can decide per-section
 * without changing the SelectionList orchestrator.
 */
export type SelectionListVirtualizationMode = 'auto' | 'force' | 'never';

export type SelectionListSection = Readonly<{
    id: string;
    /** Uppercase tracking label; renders as a section header. */
    title?: string;
    /** Optional integer rendered as ` · {count}` after the section title. */
    count?: number;
    /** Optional right-side accessory rendered in the section header. */
    headerRightAccessory?: SelectionListAccessory;
    options: ReadonlyArray<SelectionListOption>;
    /**
     * Optional virtualization hint consumed by `SelectionListVirtualizedSection`.
     * Defaults to `'auto'`. See `SelectionListVirtualizationMode`.
     */
    virtualization?: SelectionListVirtualizationMode;
    /**
     * RUX-9.2: when `true`, the prefix-priority ranking skips tier-3
     * (subtitle.includes) for this section. Useful for domains where the
     * subtitle carries data that always contains the query (e.g. the path
     * picker: every row's subtitle is the absolute path which contains the
     * parent directory, so typing inside `~/Documents/` matches EVERY child
     * via subtitle and pollutes the ranking with false positives). Default
     * `false` preserves the legacy three-tier behavior.
     */
    disableSubtitleRanking?: boolean;
}>;

/**
 * Async-resolved section. The library debounces `resolve` calls per
 * `debounceMs`, drops stale responses via a per-section sequence number, and
 * surfaces loading / error / empty / success states to the orchestrator.
 * `visibleWhen(input)` gates whether the section participates in rendering at
 * all for the current input. See `useSelectionListDynamicSections.ts`.
 */
export type SelectionListDynamicSectionResolveResult = Readonly<{
    options: ReadonlyArray<SelectionListOption>;
    emptyHint?: string;
    /**
     * RUX-1 Issue 6: when set, the resolver successfully ran but the target
     * does not exist (e.g. ENOENT for a typo'd path). Distinct from `throw`
     * (treated as a transient error). When `notFound` is `true`, the
     * orchestrator renders a "not found" hint AND skips the input-filter on
     * sibling static sections in the same step so favorites/recents remain
     * visible (they'd otherwise be filtered to empty by the typed path).
     * Pair with `notFoundHint` to override the default copy.
     */
    notFound?: boolean;
    /** Optional override copy for the notFound hint (defaults to `t('selectionList.pathNotFound')`). */
    notFoundHint?: string;
}>;

export type SelectionListDynamicSection = Readonly<{
    id: string;
    title?: string;
    /** Optional right-side accessory rendered in the section header. */
    headerRightAccessory?: SelectionListAccessory;
    /**
     * Optional explicit identity key for the resolver. When present, the
     * dynamic-sections hook treats two descriptors with the same `id` AND same
     * `resolverKey` as referring to the same resolver, regardless of closure
     * identity. When absent, the hook defaults to `descriptor.id` — i.e. plain
     * parent re-renders that hand new resolver closures to the same section id
     * NEVER invalidate the cached state (they previously did under R9's
     * WeakMap-tagged resolver-token approach, causing spurious loading-skeleton
     * flicker on every parent re-render). Callers that legitimately need to
     * invalidate when switching the underlying RPC binding (e.g. machine swap
     * keeps the section id but rebinds the resolver) MUST bump `resolverKey`
     * (e.g. `resolverKey: machineId ?? 'no-machine'`).
     */
    resolverKey?: string;
    /**
     * Returns the section's options for the given seed. Library calls this
     * debounced; passes an `AbortSignal` aborted on the next input change.
     * Throwing or rejecting renders the error state.
     */
    resolve: (
        seed: string,
        abortSignal: AbortSignal,
    ) => Promise<SelectionListDynamicSectionResolveResult>;
    /** Debounce window in ms; default 120ms. */
    debounceMs?: number;
    /** Skeleton row count while loading; default 3. Pass 0 to collapse during load. */
    loadingSkeletonRows?: number;
    /** Hide this section entirely when input doesn't satisfy this predicate. */
    visibleWhen?: (input: string) => boolean;
    /**
     * Optional override for the seed used by `resolve`. Defaults to the
     * library's `inputBehavior.getDynamicSectionSeed(input)`, falling back to
     * the raw input.
     */
    seedFromInput?: (input: string) => string;
    /**
     * Optional virtualization hint consumed by `SelectionListVirtualizedSection`
     * when the dynamic section's resolved rows are rendered. Defaults to `'auto'`.
     */
    virtualization?: SelectionListVirtualizationMode;
    /**
     * RUX-9.2: when `true`, the prefix-priority ranking skips tier-3
     * (subtitle.includes) when filtering the resolved options against the
     * input query. Path picker enables this so typing "de" inside
     * `~/Documents/` does NOT match every child via subtitle. Default
     * `false` preserves the legacy three-tier behavior.
     */
    disableSubtitleRanking?: boolean;
    /**
     * RUX-11.2: when `true`, the render-plan emits the loading entry with
     * skeleton rows on the FIRST fetch (no prior data cached) so users see
     * a placeholder while the resolver runs. When `false` (the default),
     * the section is hidden entirely during first-load to avoid a
     * visible-then-hidden flicker between the empty header + skeleton body
     * and the resolved rows. Stale-while-revalidate (subsequent fetches
     * with cached `lastSuccessOptions`) is unaffected.
     */
    showSkeletonsOnFirstLoad?: boolean;
}>;

/**
 * Ordered descriptor — order in the array IS the visual order. No `placement`
 * flag. Each entry is either a static section or a dynamic (async-resolved)
 * section.
 */
export type SelectionListSectionDescriptor =
    | (Readonly<{ kind: 'static' }> & SelectionListSection)
    | (Readonly<{ kind: 'dynamic' }> & SelectionListDynamicSection);

export type SelectionListStep = Readonly<{
    id: string;
    /** Title shown in the header area below the search row when present. */
    title?: string;
    /** Label shown inside the back chip when this step is on the stack (default uses parent step title). */
    backLabel?: string;
    /** Optional placeholder for the input on this step (omit to disable input). */
    inputPlaceholder?: string;
    /**
     * Per-step input mode. Defaults to the SelectionList-level `inputMode` prop
     * (which itself defaults to `'search'`). A step can opt into `'value'` so
     * the input on THAT step is the candidate value (committed via
     * `onCommitInputValue` on Enter / soft-keyboard return), while sibling steps
     * stay in `'search'` (filter) mode. Used by the worktree picker's
     * "name your worktree" step pushed after a base branch is chosen.
     */
    inputMode?: SelectionListInputMode;
    /**
     * Per-step commit handler for `inputMode: 'value'` steps. Receives the
     * current raw input value when the user presses Enter (web) or the
     * soft-keyboard return key (native) without a focused row. Takes precedence
     * over the SelectionList-level `onCommitInputValue` prop when present, so a
     * pushed value step can carry its own commit closure (e.g. the base ref it
     * was opened for) through the otherwise-stateless step tree.
     */
    onCommitInputValue?: (input: string) => void;
    /**
     * Synthesize a single "act on the current input" row from the live input
     * value (combobox-create pattern, e.g. "Create worktree '<typed>'"). When
     * it returns an option, the orchestrator prepends it as a filter-bypassing,
     * default-focused row that reflects what the user is typing; return `null`
     * to omit it (e.g. on empty input). Activating the row runs its `onSelect`
     * and closes through the normal selection path, so it doubles as the
     * keyboard-navigable commit affordance for value-mode steps.
     */
    buildInputRow?: (input: string) => SelectionListOption | null;
    /**
     * When `true`, this step's static + dynamic rows are NOT narrowed by the
     * input value. Use for value-mode steps where the input is the candidate
     * VALUE rather than a search query, so fixed choices (e.g. the worktree
     * "name" step's "Use suggested name" row) stay visible while the user types
     * a custom value. Default `false` preserves the search-filter behavior.
     */
    disableInputFilter?: boolean;
    /**
     * Resolve the option that should be focused/selected BY DEFAULT for the
     * current input value, before the user explicitly navigates rows. Returning
     * a visible option id makes it the keyboard-focused row; returning `null`
     * falls back to the SelectionList-level `selectedOptionId`, then to the
     * first row. Re-evaluated as the input changes, so a value step can move the
     * default highlight as typing begins (e.g. focus the suggested-name row when
     * empty, then the live "Create …" row once the user types). Explicit arrow
     * navigation still overrides this until the input crosses the boundary again.
     */
    resolveDefaultFocusedOptionId?: (input: string) => string | null;
    /** Override the empty-state copy for this step. */
    emptyStateLabel?: string;
    /** Ordered array of section descriptors; the array order IS the visual order. */
    sections: ReadonlyArray<SelectionListSectionDescriptor>;
    /** Footer hints rendered for this step (suppressed when no hardware keyboard). */
    footerHints?: ReadonlyArray<SelectionListKeyboardHint>;
}>;

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

export type SelectionListInputMode = 'search' | 'value';

export type SelectionListHeightBehavior =
    | 'content'
    | 'fixedToMaxHeight'
    | 'stabilizedContentHeight'
    | 'measuredToMaxHeight';

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
 * ARIA identity published on whichever host currently owns the body's scroll
 * container (`SelectionListBodyScrollFrame`, the flat FlashList, or the plain
 * body `View`). `SelectionListBody` is the single producer; the hosts only
 * spread it. Declared here so the three hosts cannot drift apart on what the
 * listbox node carries.
 */
export type SelectionListListboxAriaProps = Readonly<{
    id: string;
    role: 'listbox';
    accessibilityLabel?: string;
    'aria-label'?: string;
}>;

export type SelectionListProps = Readonly<{
    /** Root step. Pushes accumulate above this. */
    rootStep: SelectionListStep;
    /**
     * Accessible name for the owned listbox. A sectioned surface (suggestions,
     * pickers) is otherwise announced as an unnamed list box, leaving the
     * section titles without the context they belong to. Blank values are
     * ignored so the host never publishes an empty accessible name.
     */
    listAccessibilityLabel?: string;
    /** Currently-selected option id (rendered with selected style). Optional. */
    selectedOptionId?: string | null;
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
    /** Optional element rendered to the left of the input (e.g. folder icon). */
    inputPrefix?: React.ReactNode;
    /**
     * Optional element rendered inside the input field on the right side. Use
     * this for functional actions (e.g. "Open tree browser" button) — they
     * always render regardless of input modality. The footer is reserved for
     * keyboard hints only.
     */
    inputSuffix?: React.ReactNode;
    /** Optional controlled input value. Library is uncontrolled when omitted. */
    inputValue?: string;
    /** Optional visual truncation for the input value (useful for path-like values). */
    inputValueEllipsizeMode?: SelectionListTextEllipsizeMode;
    onChangeInputValue?: (next: string) => void;
    /** Called when an option is selected (may close the popover). */
    onSelect: (id: string, option: SelectionListOption) => void;
    /**
     * Called when the user commits the raw input value (only when
     * `inputMode === 'value'` and Enter is pressed without a focused row).
     * Receives the current input string.
     */
    onCommitInputValue?: (input: string) => void;
    /** Called when the user explicitly closes (Escape after stack drains). */
    onRequestClose: () => void;
    /** Render keyboard chips/footer hints; defaults to useHasHardwareKeyboard(). */
    keyboardHintsEnabled?: boolean;
    /**
     * Focus the search/value input when this list mounts or changes step on web.
     * Ignored on native so opening a popover/modal never summons the software keyboard.
     */
    autoFocusInputOnWeb?: boolean;
    /** Disable internal step transitions for testing. */
    disableTransitions?: boolean;
    /** Stable testID root (default 'selection-list'). */
    testID?: string;
    /** Cap container height; defaults to undefined (popover-driven). */
    maxHeight?: number;
    /**
     * Whether the owned scroll hosts should show the platform vertical scroll
     * indicator. Defaults to false so compact popovers keep their chrome quiet.
     */
    showsVerticalScrollIndicator?: boolean;
    /**
     * Height policy for the outer list container.
     *
     * - `content` (default): natural content height, capped by `maxHeight`.
     * - `stabilizedContentHeight`: natural content height capped by
     *   `maxHeight`, with immediate growth and debounced shrink so dynamic
     *   typeahead popovers avoid rapid height jitter without empty max-height
     *   space.
     * - `measuredToMaxHeight`: measure the body/header/footer segments and
     *   use a concrete native height of `min(contentHeight, maxHeight)`.
     *   The first paint stays hidden at the max-height fallback until a real
     *   measurement exists, and later shrink updates are debounced.
     * - `fixedToMaxHeight`: use `maxHeight` as the actual height as well as
     *   the cap. Reserved for embedded surfaces that genuinely require a
     *   fixed viewport.
     */
    heightBehavior?: SelectionListHeightBehavior;
    /**
     * Optional keyboard shortcuts that activate a specific option by id (e.g.
     * Cmd+N → "Create new worktree"). Forwarded to
     * `useSelectionListKeyboardNav`; does NOT bypass the option's `disabled`
     * guard.
     */
    quickActionShortcuts?: ReadonlyArray<SelectionListQuickActionShortcut>;
}>;
