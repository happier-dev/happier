import type * as React from 'react';
import type { GestureResponderEvent } from 'react-native';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

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
 * actions render in the input field's right-side `inputSuffix` slot. The footer
 * renders keyboard hints (hidden on touch devices) and, when a list commits to one
 * whole-list action, `footerAction` at its trailing edge on every device.
 *
 * NOTE: there is intentionally NO `SelectionListPathTargetPlatform` type.
 * Path/Windows-vs-Unix is a path-domain concept owned by the path adapter
 * (`apps/ui/sources/utils/path/browseSegments.ts`), NOT generic SelectionList types.
 */

/**
 * A row visual may be supplied directly for small/static lists or through a
 * render-time factory for virtualized lists. Factories are invoked only when
 * the owning row renderer materializes that row. Generic visuals keep their
 * no-argument contract; only right accessories receive current row selection.
 */
export type SelectionListOptionVisualState = Readonly<{ selected: boolean }>;
export type SelectionListLazyVisual = React.ReactNode | (() => React.ReactNode);
export type SelectionListAccessory = React.ReactNode | ((row?: SelectionListOptionVisualState) => React.ReactNode);
export type SelectionListTextEllipsizeMode = 'head' | 'middle' | 'tail' | 'clip';

export type SelectionListKeyboardHint = Readonly<{
    /** Stable id used for testIDs and registry mapping later. */
    id: string;
    /** Display label as rendered in the KeyHint; e.g. '↵', '⌘N', '↑↓', 'Tab'. */
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
    /** Optional stable consumer-facing test id for compatibility adapters. */
    testID?: string;
    /** Plain-text label used for matching and as the synchronous fallback. */
    label: string;
    /** Rich visual label, resolved only by a mounted row; `label` remains its matching/spoken name. */
    labelContent?: SelectionListLazyVisual;
    /** An inline mark after the label, such as a "Default" tag; rendered by the row's `Item`. */
    titleAccessory?: SelectionListLazyVisual;
    /** A short text qualifier after the label, such as "· via DeepSeek"; the row's `Item` keeps the label whole beside it. */
    titleQualifier?: string;
    /** Whether the leading mark and trailing accessory centre on a multi-line row (default) or sit level with the label (`Item.contentAlign`). */
    contentAlign?: 'center' | 'start';
    /** Tints this query's matches in the label: a search hit whose label is the very text that matched. */
    labelHighlightQuery?: string;
    /**
     * Additional canonical plain-text metadata used only for matching. It is
     * ranked after visible label and subtitle matches and is never rendered.
     */
    searchText?: string;
    /** Newline-delimited canonical identities that enter the first match band only on exact equality. */
    exactSearchText?: string;
    /**
     * Render-time title for virtualized rows whose visible text is more
     * expensive to derive than their plain-text matching label.
     */
    renderLabel?: () => string;
    /**
     * Called when pointer activation starts, before a focused input can blur.
     * Consumers use this only to coordinate interaction ordering; selection
     * remains owned by SelectionList and is delivered through `onSelect`.
     */
    onPressIn?: () => void;
    /** Pointer highlight for hosts that keep the active option in a separate input or preview. */
    onHighlight?: () => void;
    /**
     * Optional full-row body. When present, SelectionList still owns row
     * activation, selected/focused styling, a11y ids, and scroll-into-view,
     * while the consumer owns the inner visual content.
     */
    content?: React.ReactNode;
    subtitle?: string;
    /** Item's existing text allowance; 0 lets a complete disclosure grow without truncation. */
    subtitleLines?: number;
    /** Rich visual subtitle; `subtitle` remains the searchable plain-text value. */
    subtitleContent?: SelectionListLazyVisual;
    /**
     * A small mark leading the subtitle line (a presence or trouble dot: "● Online · this
     * computer"). Rendered by the row's `Item`, so the line keeps the row's subtitle typography.
     */
    subtitleLeading?: SelectionListLazyVisual;
    /** Optional assistive label for rows whose visible label repeats across sections. */
    accessibilityLabel?: string;
    /** Render-time assistive label for a virtualized row. */
    renderAccessibilityLabel?: () => string;
    labelEllipsizeMode?: SelectionListTextEllipsizeMode;
    subtitleEllipsizeMode?: SelectionListTextEllipsizeMode;
    icon?: SelectionListLazyVisual;
    /** Right-side accessory (status pill, relative time, key chip, etc.) */
    rightAccessory?: SelectionListAccessory;
    /**
     * Keep an interactive accessory (Switch/menu/button) outside the row's
     * Pressable. This prevents nested-button markup on web while preserving
     * one accessible row activation target beside the independent control.
     */
    rightAccessoryOutsidePressable?: boolean | ((row?: SelectionListOptionVisualState) => boolean);
    /**
     * Extra body rendered directly BELOW the row, by default only while the row
     * is selected. It is mounted as a sibling of the row — outside every
     * Pressable — so the controls it owns (segmented toggles, sliders, chips)
     * activate independently and never nest a button inside the row's button on
     * web. Use it for per-option controls or recovery steps; the row itself
     * stays the selection target.
     */
    expandedContent?: SelectionListLazyVisual;
    /** Previews may follow focus; recovery controls can stay visible even on disabled rows. Defaults to selected. */
    expandedContentVisibility?: 'selected' | 'focused' | 'always';
    /** The active row's detail, shown beside the list when the list declares a `detailPane` and has room. */
    detailContent?: SelectionListLazyVisual;
    /** Hide the compact subtitle while expanded content already shows it. */
    hideSubtitleWhenExpanded?: boolean;
    /**
     * `text` sets the disclosure under the row's title edge, as the row's own bottom content (Item
     * `bottomElementInset="text"`), so its controls read as part of that row; default/none keeps
     * content-owned insets.
     */
    expandedContentInset?: 'text' | 'none';
    /**
     * The row opens and closes its `expandedContent` in place (a "Details" row): it ends in the turning
     * disclosure caret `Item` draws for expandable headers and reports its expanded state.
     */
    disclosure?: boolean;
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
    /**
     * The row is its group's current choice. For lists with one choice per section (an account per
     * connected service), where the list-level `selectedOptionId` can name only one of them. The row
     * owner draws the same check and selected state as for the list's own selection.
     */
    selected?: boolean;
    /** Disable the row entirely. */
    disabled?: boolean;
    /** Show the canonical row-level pending affordance while retaining row identity. */
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
export type SelectionListOption<TInvocation = unknown> =
    | (SelectionListOptionBase & Readonly<{
        /** When the option just selects (default), called on press / Enter. */
        onSelect?(event?: GestureResponderEvent, context?: ActionExecutorContext, invocation?: TInvocation): void;
        openStep?: undefined;
    }>)
    | (SelectionListOptionBase & Readonly<{
        /** When set, tapping pushes a new step instead of selecting. */
        openStep: SelectionListStep<TInvocation>;
        onSelect?: undefined;
    }>);

/**
 * Structural rows consumed by a direct virtualized option source. The source
 * owns only the already-known ordering and section boundaries; SelectionList
 * still owns option materialization, activation, focus, accessibility, and
 * the one canonical virtualizer.
 */
/**
 * Every item carries its own list `key`. The virtualized list compares a replaced listing by calling
 * its key extractor on the PREVIOUS items (LegendList `checkStructuralDataChange`), so a key must
 * never be read back through the current source, whose indexes may no longer cover an old item.
 */
export type SelectionListVirtualizedOptionSourceItem =
    | Readonly<{
        kind: 'section-header';
        key: string;
        sectionIndex: number;
    }>
    | Readonly<{
        kind: 'result-hint';
        key: string;
        sectionIndex: number;
    }>
    | Readonly<{
        kind: 'option';
        key: string;
        /** Opaque source-local option position, not a public option id. */
        optionIndex: number;
        /** One-based listbox position, excluding section headers. */
        positionInSet: number;
    }>;

export type SelectionListVirtualizedOptionSourceHeader = Readonly<{
    id: string;
    title?: string;
    resultHint?: string;
    /** The title is a path or identifier, set in the mono role. */
    monoTitle?: boolean;
    count?: number;
    rightAccessory?: SelectionListLazyVisual;
}>;

/**
 * A direct structural source for a large, already-filtered option corpus.
 *
 * Use this only when the caller can provide the final visual order without
 * eagerly constructing every `SelectionListOption`. `getOption` and
 * `getHeader` run when their virtualized row is materialized. The source must
 * expose its own focus traversal because its opaque option positions need not
 * be dense or match visual-row indices.
 */
export type SelectionListVirtualizedOptionSource<TInvocation = unknown> = Readonly<{
    items: readonly SelectionListVirtualizedOptionSourceItem[];
    optionCount: number;
    /** Changes when mounted option state or focusability changes without a structural source rebuild. */
    stateKey: string;
    getOption: (optionIndex: number) => SelectionListOption<TInvocation>;
    getOptionId: (optionIndex: number) => string;
    findOptionIndexById: (optionId: string) => number;
    /** Visual row position, including section headers/hints; indexed with the inventory. */
    findItemIndexByOptionIndex: (optionIndex: number) => number;
    getFirstFocusableOptionIndex: () => number;
    getNextFocusableOptionIndex: (currentOptionIndex: number, direction: -1 | 1) => number;
    isFocusableOptionIndex: (optionIndex: number) => boolean;
    getHeader: (sectionIndex: number) => SelectionListVirtualizedOptionSourceHeader;
}>;

/**
 * Per-section virtualization control. `'auto'` (the default) switches to
 * virtualized list when the row count exceeds
 * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD` (50, per Phase 0.5). `'force'`
 * always uses virtualized list; `'never'` always plain-maps rows under `Item`/
 * `ItemGroup`. Set at the descriptor level so authors can decide per-section
 * without changing the SelectionList orchestrator.
 */
export type SelectionListVirtualizationMode = 'auto' | 'force' | 'never';

export type SelectionListSectionAction = Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
}>;

export type SelectionListSection<TInvocation = unknown> = Readonly<{
    id: string;
    /** Uppercase tracking label; renders as a section header. */
    title?: string;
    /** Quiet scope or context at the trailing edge of the section header. */
    rightAccessory?: SelectionListLazyVisual;
    /** Optional integer rendered as ` · {count}` after the section title. */
    count?: number;
    /** One quiet destination at the header's trailing edge ("New machine · Presets"); never an option. */
    action?: SelectionListSectionAction;
    options: ReadonlyArray<SelectionListOption<TInvocation>>;
    /** Query projection for grouped rows (for example, matches inside a closed disclosure).
     * Owns matching and ordering for a nonempty query; empty input keeps `options` as authored.
     */
    filterOptions?: (query: string) => ReadonlyArray<SelectionListOption<TInvocation>>;
    /** Optional non-activatable status rendered after this static section. */
    resultHint?: string;
    /**
     * The section reads as ONE disclosure row (its title and count), closed until pressed; open, its rows follow
     * it in one column (owner 11-16). A search shows its matches whether it is open or not.
     */
    collapsible?: boolean;
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
export type SelectionListDynamicSectionResolveResult<TInvocation = unknown> = Readonly<{
    options: ReadonlyArray<SelectionListOption<TInvocation>>;
    emptyHint?: string;
    /** Optional non-activatable status shown after a successful nonempty result set. */
    resultHint?: string;
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

export type SelectionListDynamicSection<TInvocation = unknown> = Readonly<{
    id: string;
    title?: string;
    rightAccessory?: SelectionListLazyVisual;
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
        /** Current results while the same request is still resolving; never cached as final. */
        onProgress?: (result: SelectionListDynamicSectionResolveResult<TInvocation>) => void,
        /** Current output for this target, so producers can retain unchanged option identities. */
        previousOptions?: readonly SelectionListOption<TInvocation>[],
    ) => Promise<SelectionListDynamicSectionResolveResult<TInvocation>>;
    /**
     * Binds resolved or retained row data to this descriptor's current presentation
     * and actions. Runs before matching and activation, including while cached
     * results refresh or a request fails. Keep unchanged projected rows stable;
     * changing this binding does not invalidate or repeat the resolver request.
     */
    projectOptions?: (options: readonly SelectionListOption<TInvocation>[]) => readonly SelectionListOption<TInvocation>[];
    /** Debounce window in ms; default 120ms. */
    debounceMs?: number;
    /** Skeleton row count while loading; default 3. Pass 0 to collapse during load. */
    loadingSkeletonRows?: number;
    /**
     * A first load that says so in one quiet line ("Searching messages…") instead of skeleton rows, for a
     * group whose results take noticeably long and whose row shape varies (Find lab ST: "one line").
     */
    loadingHint?: string;
    /**
     * Host copy for a failed resolve ("Couldn't search PRs & Issues"). The resolver's own message stays in
     * diagnostics; without this the generic localized fallback shows.
     */
    errorHint?: string;
    /**
     * Opt-in Retry link on this section's failure line (already-translated label). It re-runs this section's
     * resolver; a `SelectionListSectionFailure` marked `retryable: false` still shows no link.
     */
    retryLabel?: string;
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
     * Who decides which resolved rows are shown for the current query.
     *
     * - `'host'` (default): canonical SelectionList matching/ranking narrows
     *   the resolver's rows, exactly as every incumbent consumer expects.
     * - `'provider'`: the resolver's canonical executor already filtered and
     *   ranked the rows (full-text/semantic transcript search, SCM queries,
     *   plugin providers), so its order and membership are preserved verbatim.
     *   Re-running host matching there drops legitimately relevant rows whose
     *   displayed label/subtitle does not literally contain the query.
     */
    resultFiltering?: 'host' | 'provider';
    /**
     * Motion applied when a successful resolver seed replaces the section's rows.
     *
     * Directory/path pickers retain the default `'drill'` spatial transition.
     * High-frequency query providers use `'none'` so every keystroke remains a
     * local result update rather than presenting as navigation into a new place. They also keep
     * their last settled result visible while a refinement of the query resolves.
     */
    resultTransition?: 'drill' | 'none';
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
export type SelectionListSectionDescriptor<TInvocation = unknown> =
    | (Readonly<{ kind: 'static' }> & SelectionListSection<TInvocation>)
    | (Readonly<{ kind: 'dynamic' }> & SelectionListDynamicSection<TInvocation>);

export type SelectionListStep<TInvocation = unknown> = Readonly<{
    id: string;
    /** Keep one flat virtualized body from the first render, including empty/multi-source search results. */
    virtualization?: 'force';
    /** Title shown in the header area below the search row when present. */
    title?: string;
    /** Label shown inside the back chip when this step is on the stack (default uses parent step title). */
    backLabel?: string;
    /** Optional placeholder for the input on this step (omit to disable input). */
    inputPlaceholder?: string;
    /**
     * When true, the shared header remains visible for context but the field
     * is read-only (for example while choosing a Search scope). The step can
     * still disable filtering independently via `disableInputFilter`.
     */
    inputReadOnly?: boolean;
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
    buildInputRow?: (input: string) => SelectionListOption<TInvocation> | null;
    /**
     * When `true`, this step's static + dynamic rows are NOT narrowed by the
     * input value. Use for value-mode steps where the input is the candidate
     * VALUE rather than a search query, so fixed choices (e.g. the worktree
     * "name" step's "Use suggested name" row) stay visible while the user types
     * a custom value. Default `false` preserves the search-filter behavior.
     */
    disableInputFilter?: boolean;
    /** Rank a nonempty search as one result set, instead of retaining authored section priority. */
    searchAcrossSections?: boolean;
    /**
     * Resolve the option that should be focused/selected BY DEFAULT for the
     * current input value, before the user explicitly navigates rows. Returning
     * a visible option id makes it the keyboard-focused row; returning `null`
     * falls back to the SelectionList-level `selectedOptionId`, then to the
     * first row unless `autoFocusFirstOption` is false. Re-evaluated as the input changes, so a value step can move the
     * default highlight as typing begins (e.g. focus the suggested-name row when
     * empty, then the live "Create …" row once the user types). Explicit arrow
     * navigation still overrides this until the input crosses the boundary again.
     */
    resolveDefaultFocusedOptionId?: (input: string) => string | null;
    /** Disable the first-row fallback; selected/preferred rows and arrow navigation still focus normally. */
    autoFocusFirstOption?: boolean;
    /** Override the empty-state copy for this step. */
    emptyStateLabel?: string;
    /**
     * The empty state while a search is typed: its sentence (it may name the query) and, when `clearLabel`
     * is given, a quiet link that empties the search. A search that finds nothing is never a dead end.
     */
    emptyStateForQuery?: (query: string) => Readonly<{ label: string; clearLabel?: string }>;
    /** Ordered array of section descriptors; the array order IS the visual order. */
    sections: ReadonlyArray<SelectionListSectionDescriptor<TInvocation>>;
    /**
     * Direct structural source for a large server-filtered corpus. It is
     * mutually exclusive with authored sections: callers provide `sections: []`
     * and let this source preserve their precomputed visual order through the
     * canonical body virtualizer.
     */
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource<TInvocation>;
    /** Footer hints rendered for this step (suppressed when no hardware keyboard). */
    footerHints?: ReadonlyArray<SelectionListKeyboardHint>;
}>;

export type SelectionListInputMode = 'search' | 'value';

export type SelectionListHeightBehavior =
    | 'content'
    | 'fixedToMaxHeight'
    | 'stabilizedContentHeight'
    | 'measuredToMaxHeight';

/**
 * Cursor-owned pagination state for a SelectionList surface.
 *
 * Supplying this contract forces the body through its single flattened
 * virtualized list owner, even for a small or single-section page. `requestKey`
 * should be the current opaque source cursor (or another scope-qualified
 * page identity). SelectionList uses it only to suppress duplicate
 * `onEndReached` delivery for the same page; the data hook remains the
 * canonical cursor and request owner.
 */
export type SelectionListPagination = Readonly<{
    hasMore: boolean;
    loadingMore: boolean;
    requestKey: string | null;
    error?: string | null;
    onEndReached: () => void;
    onRetry?: () => void;
    loadingLabel: string;
    moreLabel: string;
    retryLabel: string;
    endReachedLabel: string;
    /** A quiet line above the "more" control: what the last page added (nothing new), while more remains. */
    moreNotice?: string | null;
    /** `edge`: the closing line sits on the rows' edge as a quiet status line (default: a centred end marker). */
    endReachedPlacement?: 'centered' | 'edge';
}>;
