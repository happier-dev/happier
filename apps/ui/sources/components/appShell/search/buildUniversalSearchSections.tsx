import * as React from 'react';
import { rankHappierQueryMatches } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import type {
    SelectionListDynamicSection,
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListVirtualizedOptionSource,
    SelectionListVirtualizedOptionSourceHeader,
    SelectionListVirtualizedOptionSourceItem,
} from '@/components/ui/selectionList';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ConversationHitSummary, formatConversationHitSnippet, resolveConversationHitSnippet } from '@/components/sessions/external/browse/ConversationHitSummary';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { KeyboardCommandHint, KeyHint } from '@/components/ui/keyboard/KeyHint';
import { QuickOpenFilePreview } from './QuickOpenFilePreview';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SelectionListOptionStateContext } from '@/components/ui/selectionList/SelectionListOptionStateContext';
import { SelectionListDetailPaneContext } from '@/components/ui/selectionList/SelectionListDetailPaneContext';
import { useCodeTextFile } from '@/components/projects/files/code/useCodeTextFile';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { UniversalSearchSourceFocus } from './UniversalSearchRuntimeContext';
import { boundedReplyHints } from './searchBoundedReplyHints';
import { hasUniversalSearchOptionProjection, projectUniversalSearchOption } from './universalSearchOptionProjection';

const EMPTY_WORKSPACE_SCOPE: WorkspaceScopeBase = { serverId: '', machineId: '', rootPath: '' };

import type { Command } from '@/components/appShell/commandPalette/types';
import {
    buildCommandPaletteOptionId,
    buildCommandPaletteSelectionListSections,
} from '@/components/appShell/commandPalette/buildCommandPaletteSelectionListSections';

import {
    UNIVERSAL_SEARCH_SOURCE_IDS,
    UNIVERSAL_SEARCH_PAGE_SIZE,
    buildUniversalSearchOptionId,
    buildUniversalSearchScopeKey,
    buildUniversalSearchWorkspaceScopeKey,
    type UniversalSearchResult,
} from './universalSearchResult';

/**
 * The one Universal Search section builder.
 *
 * It is a THIN ADAPTER LAYER over canonical domain owners, and deliberately not
 * a registry: every built-in source is an ordinary branch here, resolved from
 * inputs the controller already fetched from that domain's own owner. There is
 * no registration API, no provider lifecycle, no ranking service and no cache —
 * `SelectionList` and `useSelectionListDynamicSections` remain the single owners
 * of query state, debounce, `AbortController`, stale-response fencing, section
 * status and virtualization.
 *
 * Two rules shape everything below.
 *
 * EMPTY QUERY IS A UI STATE, NOT A WIRE REQUEST. Every remote/corpus section
 * declares `visibleWhen: query is non-empty`, so opening Search issues zero
 * requests: the user sees bounded local recents and the command catalog.
 *
 * PROVIDER ORDER IS PRESERVED WHERE A CANONICAL EXECUTOR ALREADY RANKED. FTS,
 * fuzzy settings, file and commit sections declare `resultFiltering: 'provider'`
 * — re-running the host matcher over displayed labels would drop a legitimately
 * relevant row whose title does not literally contain the query. No raw score
 * from two different providers is ever compared, because no score reaches here.
 */

/** Bounded empty-query recents. Not a ranking service — just "what you had open". */
const EMPTY_QUERY_RECENT_LIMIT = 5;
/** Lines the inline Text in files group shows before its "All N matches" row (lab G1: "the best few"). */
const INLINE_FILE_CONTENT_LINES = 3;
export const EXTERNAL_CONVERSATION_SEARCH_OPTION_ID = 'external-conversations:search';
export const ALL_FILE_MATCHES_OPTION_ID = 'fileContent:all-matches';
export const MORE_FILES_OPTION_ID = 'files:more';

export type UniversalSearchSessionEntity = Readonly<{
    sessionId: string;
    serverId: string;
    accountId: string;
    title: string;
    subtitle?: string;
    searchText?: string;
    exactSearchText?: string;
    /** `readSessionRowPresentationAgentId`: the mark the Session list draws; absent when the Agent is unknown. */
    agentId?: string;
    updatedAt: number;
}>;

export type UniversalSearchProjectEntity = Readonly<{
    workspaceRefId: string;
    serverId: string;
    accountId: string;
    machineId: string;
    rootPath: string;
    workspace?: WorkspaceScopeBase['workspace'];
    title: string;
    subtitle?: string;
    lastOpenedAtMs: number;
}>;

export type UniversalSearchSettingsPageEntity = Readonly<{
    id: string;
    route: string;
    title: string;
    subtitle?: string;
}>;

/**
 * A dynamic source the controller already bound to its exact target.
 *
 * `resolverKey` is the target identity — Account scope, Home/server, machine,
 * workspace root, generation. Changing it is how a superseded target's in-flight
 * work is dropped and how its rows are prevented from being replayed from the
 * cross-mount dynamic-section cache after a logout or Account switch.
 */
export type UniversalSearchDynamicSource = Readonly<{
    resolverKey: string;
    loadMore?(): void;
    /** Calm source-owned coverage/truncation context rendered by SelectionList. */
    resultHint?: string;
    resolve: (query: string, signal: AbortSignal, onProgress?: (page: Readonly<{
        results: readonly UniversalSearchResult[];
        emptyHint?: string;
        resultHint?: string;
        hasMore?: boolean;
    }>) => void) => Promise<
        readonly UniversalSearchResult[]
        | Readonly<{
            results: readonly UniversalSearchResult[];
            emptyHint?: string;
            resultHint?: string;
            hasMore?: boolean;
        }>
    >;
}>;

function isUniversalSearchResolvePage(
    value: readonly UniversalSearchResult[] | Readonly<{
        results: readonly UniversalSearchResult[];
        emptyHint?: string;
        resultHint?: string;
        hasMore?: boolean;
    }>,
): value is Readonly<{
    results: readonly UniversalSearchResult[];
    emptyHint?: string;
    resultHint?: string;
    hasMore?: boolean;
}> {
    return typeof value === 'object' && value !== null && 'results' in value;
}

/**
 * A source that exists but currently cannot answer.
 *
 * It renders as an empty section carrying the canonical typed reason as a hint —
 * never as a disabled fake row that could receive activation, and never as an
 * error, because "memory search is off" is not a failure.
 */
export type UniversalSearchUnavailableSource = Readonly<{
    resolverKey: string;
    hint: string;
}>;

export type UniversalSearchSource =
    | (Readonly<{ status: 'ready' }> & UniversalSearchDynamicSource)
    | (Readonly<{ status: 'unavailable' }> & UniversalSearchUnavailableSource)
    /** The source has no target at all here (no workspace, no admitted provider): omit it. */
    | Readonly<{ status: 'absent' }>;

export type UniversalSearchFolderSuggestion = Readonly<{
    id: string;
    name: string;
    subtitle?: string;
    onSelect: () => void;
}>;

/** Rows that change the palette's scope in place; the surface keeps the palette open for them. */
export const FILE_CONTENT_FOLDER_OPTION_PREFIX = 'fileContent:folder:';

export type BuildUniversalSearchSectionsInput = Readonly<{
    query: string;
    /** This mounted producer's current output; retain unchanged rows by their scoped identity. */
    previousSections?: readonly SelectionListSectionDescriptor[];
    commands: readonly Command[];
    sessions: readonly UniversalSearchSessionEntity[];
    /** The Session list's pins, in their order (the organization projection); the empty query leads with them. */
    pinnedSessionIds?: readonly string[];
    sessionInventoryStatus?: 'idle' | 'loading' | 'ready' | 'error';
    projects: readonly UniversalSearchProjectEntity[];
    /** The resolved settings catalog's own Fuse owner; never a second matcher. */
    searchSettingsPages: (query: string) => readonly UniversalSearchSettingsPageEntity[];
    /** The catalog's search-input revision, so admission/locale changes refresh an unchanged query. */
    settingsSearchRevision?: number;
    transcript: UniversalSearchSource;
    files: UniversalSearchSource;
    fileContent?: UniversalSearchSource;
    fileContentScopeLabel?: string;
    /**
     * With no folder in scope (lab ST "No folder in scope"), the recent folders Text in files can search,
     * most recent first; choosing one scopes the search there and keeps the query.
     */
    fileContentFolders?: ReadonlyArray<UniversalSearchFolderSuggestion>;
    onShowAllFileMatches?: () => void;
    source?: UniversalSearchSourceFocus;
    symbols?: UniversalSearchSource;
    recentFiles?: readonly UniversalSearchResult[];
    changedFiles?: readonly UniversalSearchResult[];
    /** Inventory identities stay cheap; the existing virtualizer requests the displayed result only. */
    changedFileSource?: Readonly<{
        count: number;
        getOptionId(index: number): string;
        getResult(index: number): UniversalSearchResult;
    }>;
    /** `folder`: no Session in scope, so Changed is the folder's own uncommitted changes. */
    changedFilesScope?: 'session' | 'folder';
    filesStatusHint?: string;
    /**
     * Quick open typed with no file matching (lab FB2n): one quiet line with the way out, then Recent so the
     * card keeps its size and the eye has somewhere to go.
     */
    filesNoMatch?: Readonly<{ scopeLabel: string; onSearchEverything: () => void }>;
    commits: UniversalSearchSource;
    /** Already-built plugin provider sections; this module adds no plugin policy. */
    pluginSections: readonly SelectionListDynamicSection[];
    /** Explicit activation only: typing in Search never scans Agent transcripts. */
    externalConversationSearch?: Readonly<{
        /** The one machine the scan runs on; absent when it runs on every machine in scope. */
        machineLabel?: string;
        standardSearchEnabled?: boolean;
        onSearch(query: string): void;
    }>;
    /**
     * Records the selected identity. It deliberately does NOT navigate: the
     * option-level callback runs BEFORE the list-level `onSelect`, and plan
     * §4.2 requires commit → dismiss → awaited activation in that order. The
     * surface owns the dismissal and the awaited activation that follow.
     */
    onCommitResult: (result: UniversalSearchResult) => void;
    rowLimit?: number;
}>;

function icon(name: IconName): () => React.ReactElement {
    return () => <Icon name={name} size={ICON_SIZE.md} />;
}

/** Leading code kept before a match deep in a long line, so the match itself stays on screen. */
const SNIPPET_LEAD_CHARS = 32;

/**
 * The matching line under a Text-in-files hit (Find lab `.fd-snip`): one quiet mono line, indentation
 * dropped, the match marked with the Find tint every surface uses, and a long lead elided so the match
 * shows. The row's label already names `path:line`.
 */
type FileContentMatch = NonNullable<UniversalSearchResult['fileContent']>;
/** Every match on one line (the line's row marks them all), in column order. */
type FileContentLine = FileContentMatch & Readonly<{ columns: readonly Readonly<{ column16: number; length16: number }>[] }>;

function FileContentSnippet({ match }: Readonly<{ match: FileContentLine }>): React.ReactElement {
    const { theme } = useUnistyles();
    const start = Math.max(0, match.column16 - 1);
    const lead = match.text.slice(0, start).trimStart();
    const shownLead = lead.length > SNIPPET_LEAD_CHARS + 8 ? `…${lead.slice(-SNIPPET_LEAD_CHARS)}` : lead;
    const text = `${shownLead}${match.text.slice(start)}`;
    const ranges = match.columns.map((column) => ({ start: shownLead.length + column.column16 - 1 - start,
        end: shownLead.length + column.column16 - 1 - start + column.length16, current: false }));
    return (
        <View style={{ marginTop: theme.space.s2 }}>
            <Text useDefaultTypography={false} numberOfLines={1} style={{ ...Typography.variant('meta'), ...Typography.mono(), color: theme.colors.text.secondary }}>
                <FindHighlightedText text={text} ranges={ranges} />
            </Text>
        </View>
    );
}

/**
 * Only the active hit expands, inside its own row (it replaces the one-line snippet, so the line is never
 * shown twice); context comes from the same search response (G1s). Common indentation is dropped and the
 * line numbers sit in one right-aligned gutter (lab `.fd-snip .ln`), so 9 → 10 never shifts the code.
 */
function FileContentPreview({ match, gutterDigits, tone = 'secondary', wrap = false, bandHit = false }: Readonly<{ match: FileContentLine; gutterDigits?: number; tone?: 'primary' | 'secondary'; wrap?: boolean;
    /** The detail column also lays a quiet band under the hit line (lab G1s line 23). */
    bandHit?: boolean }>) {
    const { theme } = useUnistyles();
    const lines = [...match.before, match.text, ...match.after];
    const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length));
    const textStyle = { ...Typography.variant('meta'), ...Typography.mono(), color: tone === 'primary' ? theme.colors.text.primary : theme.colors.text.secondary };
    const digits = gutterDigits ?? String(match.line + match.after.length).length;
    const gutter = { minWidth: Math.ceil(digits * (textStyle.fontSize ?? 12) * 0.6), textAlign: 'right' as const };
    return <View testID="file-content-preview" style={{ marginTop: theme.space.s2 }}>
        {lines.map((text, index) => <View key={index} style={[{ flexDirection: 'row', gap: theme.space.s8 },
            bandHit && index === match.before.length ? { backgroundColor: theme.colors.state.active.background, borderRadius: 4, marginHorizontal: -4, paddingHorizontal: theme.space.s4 } : null]}>
            <Text useDefaultTypography={false} style={[textStyle, gutter, { color: theme.colors.text.tertiary }]}>{match.line - match.before.length + index}</Text>
            <Text useDefaultTypography={false} numberOfLines={wrap ? undefined : 1} style={[textStyle, { flex: 1 }]}>
                <FindHighlightedText text={text.slice(Math.min(indent, text.length - text.trimStart().length))} ranges={index === match.before.length
                    ? match.columns.map((column) => ({ start: column.column16 - 1 - indent, end: column.column16 - 1 - indent + column.length16, current: true }))
                    : undefined} />
            </Text>
        </View>)}
    </View>;
}

/**
 * Whether this row shows its context inline: it is the active row, and the list has no detail column
 * beside it (on a wide card the context lives there instead, lab G1s).
 */
function useRowFocused(): boolean {
    const focused = React.useContext(SelectionListOptionStateContext)?.focused === true;
    const inPane = React.useContext(SelectionListDetailPaneContext);
    return focused && !inPane;
}

/** The detail column for a line hit (lab G1s `.fd-preview`): which file and line, its context, and what Return does. */
/** Lines kept around the hit in the detail column (lab G1s shows about a dozen, the hit near the top third). */
const DETAIL_LINES_BEFORE = 5;
const DETAIL_LINES_AFTER = 6;

/**
 * The excerpt the detail column shows: the file read through the workspace file owner when it still has
 * the hit on that line, else the context the search itself returned (a file edited since the search, a
 * read that failed or is still on its way).
 */
function useFileContentExcerpt(match: FileContentLine, scope: WorkspaceScopeBase | null): FileContentLine {
    const file = useCodeTextFile(scope ?? EMPTY_WORKSPACE_SCOPE, scope ? match.path : null);
    return React.useMemo(() => {
        if (file.kind !== 'ready') return match;
        const lines = file.text.split(/\r?\n/);
        if (lines[match.line - 1] !== match.text) return match;
        return { ...match,
            before: lines.slice(Math.max(0, match.line - 1 - DETAIL_LINES_BEFORE), match.line - 1),
            after: lines.slice(match.line, match.line + DETAIL_LINES_AFTER) };
    }, [file, match]);
}

function FileContentDetail({ match: hit, scope }: Readonly<{ match: FileContentLine; scope: WorkspaceScopeBase | null }>) {
    const { theme } = useUnistyles();
    const match = useFileContentExcerpt(hit, scope);
    const split = Math.max(match.path.lastIndexOf('/'), match.path.lastIndexOf('\\'));
    const name = match.path.slice(split + 1);
    return <View testID="file-content-detail" style={{ paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingVertical: MENU_ROW_METRICS.paddingVerticalPx, gap: theme.space.s10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: MENU_ROW_METRICS.iconMarginRightPx }}>
            <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
            <Text numberOfLines={1} style={[Typography.variant('label', 'semiBold'), { flexShrink: 1, color: theme.colors.text.primary }]}>
                <Text style={Typography.default('medium')}>{name}</Text>
                <Text style={[Typography.default(), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{`  · ${t('universalSearch.content.atLine', { line: match.line })}`}</Text>
            </Text>
        </View>
        {/* The column has room to show whole lines (lab G1s wraps them). */}
        <FileContentPreview match={match} tone="primary" wrap bandHit />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 }}>
            <KeyHint label="↵" />
            <Text style={[Typography.variant('meta'), { color: theme.colors.text.tertiary }]}>{t('commandPalette.hints.openAtLine')}</Text>
        </View>
    </View>;
}

/** A Text-in-files hit's second line: the matching line, or its context while the row is active. */
function FileContentSubtitle({ match }: Readonly<{ match: FileContentLine }>) {
    const focused = useRowFocused();
    return focused && (match.before.length > 0 || match.after.length > 0)
        ? <FileContentPreview match={match} />
        : <FileContentSnippet match={match} />;
}

/**
 * A deep directory keeps its first two and last folders around an ellipsis (lab G1 `apps/ui/…/settings/`),
 * so the file name stays readable at any width; web text cannot ellipsize at the head.
 */
function compactDirectory(directory: string): string {
    const parts = directory.split(/[\\/]/).filter(Boolean);
    return parts.length > 3 ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}/` : directory;
}

/** File identity keeps its directory quiet, its name readable and its line tabular (lab G1). */
function FileContentLabel({ match }: Readonly<{ match: FileContentMatch }>) {
    const { theme } = useUnistyles();
    const split = Math.max(match.path.lastIndexOf('/'), match.path.lastIndexOf('\\'));
    return <Text numberOfLines={1} ellipsizeMode="head" style={[Typography.variant('label', 'semiBold'), { color: theme.colors.text.primary }]}>
        <Text style={[Typography.default(), { color: theme.colors.text.tertiary }]}>{compactDirectory(match.path.slice(0, split + 1))}</Text>
        <Text style={Typography.default('medium')}>{match.path.slice(split + 1)}</Text>
        <Text style={[Typography.default(), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{`:${match.line}`}</Text>
    </Text>;
}

/** The Text in files scope's file heading (lab G1s): type mark, name, quiet folder, match count right. */
function FileContentGroupHeader({ path, matches }: Readonly<{ path: string; matches: number }>) {
    const { theme } = useUnistyles();
    const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: MENU_ROW_METRICS.iconMarginRightPx,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingTop: MENU_ROW_METRICS.paddingVerticalPx, paddingBottom: theme.space.s2 }}>
        <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx, alignItems: 'center' }}><FileIcon fileName={path.slice(split + 1)} size={ICON_SIZE.sm} appearance="line" /></View>
        <Text numberOfLines={1} ellipsizeMode="head" style={[Typography.variant('label', 'semiBold'), { flex: 1, color: theme.colors.text.primary }]}>
            <Text style={Typography.default('medium')}>{path.slice(split + 1)}</Text>
            {split >= 0 ? <Text style={[Typography.default(), { color: theme.colors.text.tertiary }]}>{`  ${compactDirectory(path.slice(0, split)).replace(/\/$/, '')}`}</Text> : null}
        </Text>
        <Text style={[Typography.variant('meta'), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{matches}</Text>
    </View>;
}

/** Recent rows kept under a no-match line (lab FB2n shows three): enough to land somewhere, not a second list. */
const NO_MATCH_RECENT_ROWS = 3;

/** A group title inside one dynamic section, in the list's own section-title type (lab FB2n "Recent"). */
function QuickOpenGroupHeading({ title }: Readonly<{ title: string }>) {
    const { theme } = useUnistyles();
    return <Text style={[Typography.variant('meta', 'semiBold'), { color: theme.colors.text.secondary,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingTop: theme.space.s12, paddingBottom: theme.space.s4 }]}>{title}</Text>;
}

function AllMatchesLabel({ label }: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return <Text numberOfLines={1} style={[Typography.variant('meta'), { color: theme.colors.text.secondary }]}>{label}</Text>;
}

function FileContentScopeStatus({ label }: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return <Text style={[Typography.variant('meta'), Typography.tabular(), { color: theme.colors.text.secondary,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingTop: MENU_ROW_METRICS.paddingVerticalPx }]}>{label}</Text>;
}

/** A line under its file heading: the line number in a quiet gutter, then the code (lab G1s `.fd-snip`). */
function FileContentLineLabel({ match, gutterDigits }: Readonly<{ match: FileContentLine; gutterDigits: number }>) {
    const { theme } = useUnistyles();
    const focused = useRowFocused();
    if (focused && (match.before.length > 0 || match.after.length > 0)) {
        return <FileContentPreview match={match} gutterDigits={gutterDigits} tone="primary" />;
    }
    const text = match.text.trimStart();
    const shift = match.text.length - text.length;
    const ranges = match.columns.map((column) => ({ start: column.column16 - 1 - shift, end: column.column16 - 1 - shift + column.length16, current: false }));
    const style = { ...Typography.variant('meta'), ...Typography.mono() };
    // The same right-aligned gutter as the expanded context, so the code never shifts when a row becomes active.
    const gutter = { minWidth: Math.ceil(gutterDigits * (style.fontSize ?? 12) * 0.6), textAlign: 'right' as const };
    return <View style={{ flexDirection: 'row', gap: theme.space.s8 }}>
        <Text useDefaultTypography={false} style={[style, Typography.tabular(), gutter, { color: theme.colors.text.tertiary }]}>{match.line}</Text>
        <Text useDefaultTypography={false} numberOfLines={1} style={[style, { flex: 1, color: theme.colors.text.primary }]}>
            <FindHighlightedText text={text} ranges={ranges} />
        </Text>
    </View>;
}

/** Same-line matches become one line (a row per line, every match on it marked), in response order. */
function groupFileContentLines(results: readonly UniversalSearchResult[]): Array<Readonly<{ result: UniversalSearchResult; line: FileContentLine }>> {
    const lines: Array<{ result: UniversalSearchResult; line: FileContentLine }> = [];
    for (const result of results) {
        const match = result.fileContent;
        if (!match) continue;
        const last = lines[lines.length - 1];
        if (last && last.line.path === match.path && last.line.line === match.line) {
            last.line = { ...last.line, columns: [...last.line.columns, { column16: match.column16, length16: match.length16 }] };
            continue;
        }
        lines.push({ result, line: { ...match, columns: [{ column16: match.column16, length16: match.length16 }] } });
    }
    return lines;
}

function TextInFilesShortcut() {
    return <KeyboardCommandHint commandId="search.textInFiles" />;
}

/** The Agent's own mark for a conversation from its history; identity marks stand alone. */
function agentIcon(agentId: string): () => React.ReactElement {
    return () => <AgentIcon agentId={agentId} size={ICON_SIZE.md} />;
}

/**
 * A file's type mark exactly as the Files tree draws it (`FileIcon` at the tree's size, `line` appearance):
 * one glyph weight and box in every palette row kind (Files rows, text-in-files headings, the preview),
 * with the type in its tint. Live over lab (filled TSX/TS/MD badges): one FileIcon owner.
 */
function fileIcon(path: string): () => React.ReactElement {
    const name = path.slice(path.lastIndexOf('/') + 1);
    // A filled type tile reads larger than a line glyph; the small size matches its optical weight.
    return () => <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />;
}

/** One outline level of indentation (lab LS3 `.lx-sym`: nesting by indentation, no tree chrome). */
const SYMBOL_DEPTH_INDENT_PX = 20;

/** Symbol kinds drawn in the app's one icon family (ink, no colour); kinds without their own glyph share one. */
const SYMBOL_KIND_ICONS: Readonly<Record<string, IconName>> = {
    function: 'code', method: 'code', constructor: 'code' as const satisfies IconName, operator: 'code', event: 'code',
    class: 'cube', struct: 'cube', object: 'cube',
    interface: 'diamond', type: 'diamond', typeParameter: 'diamond',
    enum: 'list-bullets', enumMember: 'circle',
    property: 'tag', field: 'tag', key: 'tag',
    variable: 'circle', constant: 'circle', string: 'circle', number: 'circle', boolean: 'circle', array: 'circle', null: 'circle',
    module: 'stack-simple', namespace: 'stack-simple', package: 'stack-simple', file: 'file',
    heading: 'text-h',
};

type SymbolMetadata = NonNullable<UniversalSearchResult['symbol']> & Readonly<{ container?: string }>;

/**
 * An `@` row (lab LS3 S): kind glyph · name · where it sits, indented by its outline depth. The glyph
 * lives in the label so it indents with the name; the line number is the row's right column.
 */
function SymbolRowLabel({ name, symbol, query }: Readonly<{ name: string; symbol: SymbolMetadata; query?: string }>) {
    const { theme } = useUnistyles();
    const ranges = query ? queryRanges(name, query) : undefined;
    return <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, paddingLeft: symbol.depth * SYMBOL_DEPTH_INDENT_PX }}>
        <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx, marginRight: MENU_ROW_METRICS.iconMarginRightPx, alignItems: 'center' }}>
            <Icon name={SYMBOL_KIND_ICONS[symbol.kind] ?? 'code'} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
        </View>
        <Text numberOfLines={1} style={[Typography.variant('label'), { flexShrink: 1, color: theme.colors.text.primary }]}>
            {ranges?.length ? <FindHighlightedText text={name} ranges={ranges} /> : name}
            {symbol.container ? <Text style={[Typography.variant('meta'), Typography.mono(), { color: theme.colors.text.tertiary }]}>{`  ${symbol.container}`}</Text> : null}
        </Text>
    </View>;
}

function SymbolLine({ line }: Readonly<{ line: number }>) {
    const { theme } = useUnistyles();
    return <Text style={[Typography.variant('meta'), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{line}</Text>;
}

function toOption(
    result: UniversalSearchResult,
    iconName: IconName,
    onCommit: (result: UniversalSearchResult) => void,
    fileLine?: FileContentLine,
    /** The typed query: a row whose title is the text that matched tints it. */
    titleQuery?: string,
    previous?: SelectionListOption,
): SelectionListOption {
    return projectUniversalSearchOption(previous, { result, iconName, onCommit, fileLine, titleQuery }, () => ({
        id: buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id),
        testID: `universal-search:option:${result.sourceId}:${result.id}`,
        label: result.target.kind === 'workspaceFile' && !result.fileContent && result.target.anchor && 'startLine' in result.target.anchor
            // A `path:line` hit says where it lands.
            ? `${result.title}:${result.target.anchor.startLine}`
            : result.conversation ? stripMarkdown(result.title) : result.title,
        ...(result.subtitle ? { subtitle: result.subtitle } : {}),
        ...(titleQuery && !result.conversation && !result.fileContent ? { labelHighlightQuery: titleQuery } : {}),
        ...(result.fileContent ? {
            subtitleContent: () => <FileContentSubtitle match={fileLine ?? { ...result.fileContent!, columns: [result.fileContent!] }} />,
            detailContent: () => <FileContentDetail match={fileLine ?? { ...result.fileContent!, columns: [result.fileContent!] }}
                scope={result.target.kind === 'workspaceFile' ? result.target.scope : null} />,
        } : {}),
        ...(result.kind === 'workspaceFile' && !result.fileContent && result.target.kind === 'workspaceFile' ? (() => {
            const target = result.target;
            const line = target.anchor ? 'startLine' in target.anchor ? target.anchor.startLine : 'line' in target.anchor ? target.anchor.line : null : null;
            // Quick open's preview column (lab FB2): the file itself, at the line the query carries.
            return { detailContent: () => <QuickOpenFilePreview scope={target.scope} path={target.path} line={line} /> };
        })() : {}),
        ...(result.symbol && result.target.kind === 'workspaceSymbol' ? (() => {
            const target = result.target;
            const symbol: SymbolMetadata = result.symbol;
            return {
                // The scope token already names the file; the row says what the symbol is and where it sits.
                subtitle: undefined,
                labelContent: () => <SymbolRowLabel name={result.title} symbol={symbol} query={titleQuery} />,
                rightAccessory: () => <SymbolLine line={symbol.line} />,
                accessibilityLabel: [result.title, symbol.container, t('universalSearch.content.atLine', { line: symbol.line })].filter(Boolean).join(', '),
                detailContent: () => <QuickOpenFilePreview scope={target.scope} path={target.path} line={symbol.line} symbol={result.title} />,
            };
        })() : {}),
        ...(result.conversation ? {
            contentAlign: 'start' as const,
            labelHighlightQuery: result.conversation.query.trim() || undefined,
            subtitle: formatConversationHitSnippet(result.conversation.snippet),
            subtitleContent: () => <ConversationHitSummary
                snippet={resolveConversationHitSnippet({ title: result.title, snippet: result.conversation!.snippet, query: result.conversation!.query })}
                query={result.conversation!.query}
                where={result.conversation!.machineLabel} atMs={result.conversation!.atMs} />,
            // The row's spoken name is what it shows: the conversation, what matched, where.
            accessibilityLabel: [stripMarkdown(result.title), formatConversationHitSnippet(result.conversation.snippet), result.conversation.machineLabel].filter(Boolean).join(', '),
        } : {}),
        ...(result.searchText ? { searchText: result.searchText } : {}),
        ...(result.exactSearchText ? { exactSearchText: result.exactSearchText } : {}),
        ...((result.kind === 'project' || result.kind === 'workspaceFile') && result.subtitle
            ? { subtitleEllipsizeMode: 'head' as const }
            : {}),
        ...(result.fileChange ? { rightAccessory: () => <DiffStat added={result.fileChange!.added} removed={result.fileChange!.removed} /> } : {}),
        // A symbol row draws its kind glyph in its label, where it indents with the name.
        ...(result.symbol ? {} : { icon: result.agentId ? agentIcon(result.agentId)
            : result.conversation?.agentId ? agentIcon(result.conversation.agentId)
            : result.fileContent ? fileIcon(result.fileContent.path)
            : result.kind === 'workspaceFile' && result.target.kind === 'workspaceFile' ? fileIcon(result.target.path)
            : icon(iconName) }),
        onSelect: () => { onCommit(result); },
    }));
}

function buildDynamicSection(
    input: Readonly<{
        sourceId: string;
        title: string;
        source: UniversalSearchSource;
        iconName: IconName;
        rowLimit?: number;
        minQueryLength?: number;
        preserveQuery?: boolean;
        scopeLabel?: string;
        onShowAll?: () => void;
        /** The Text in files scope: every line, grouped under its file (lab G1s). */
        groupByFile?: boolean;
        /** Quick open: what an empty typed result shows instead of nothing (lab FB2n). */
        noMatch?: Readonly<{ scopeLabel: string; onSearchEverything: () => void; recent: readonly UniversalSearchResult[] }>;
        onCommit: (result: UniversalSearchResult) => void;
    }>,
): SelectionListDynamicSection[] {
    const { source } = input;
    if (source.status === 'absent') return [];

    if (source.status === 'unavailable') {
        return [{
            id: input.sourceId,
            title: input.title,
            rightAccessory: input.scopeLabel,
            resolverKey: `${input.sourceId}|${source.resolverKey}`,
            visibleWhen: (value: string) => (input.preserveQuery ? value.length : value.trim().length) >= (input.minQueryLength ?? 1),
            debounceMs: 0,
            loadingSkeletonRows: 0,
            showSkeletonsOnFirstLoad: true,
            resultTransition: 'none',
            // A truthful, non-activatable availability statement resolved through
            // the canonical empty-hint path. The shell and every healthy section
            // stay usable beside it.
            resolve: async () => ({ options: [], emptyHint: source.hint }),
        }];
    }

    return [{
        id: input.sourceId,
        // In the Text in files scope the token in the field names the group; the status row leads instead.
        ...(input.groupByFile ? {} : { title: input.title, rightAccessory: input.scopeLabel }),
        resolverKey: `${input.sourceId}|${source.resolverKey}`,
        visibleWhen: (value: string) => (input.preserveQuery ? value.length : value.trim().length) >= (input.minQueryLength ?? 1),
        resultFiltering: 'provider',
        showSkeletonsOnFirstLoad: true,
        // The group keeps its place and says it is still looking in one quiet line (lab ST), never a block of
        // placeholder bars taller than the results that replace them.
        loadingHint: t('universalSearch.searchingGroup'),
        errorHint: t('universalSearch.groupFailed', { group: input.title }),
        retryLabel: t('common.retry'),
        resultTransition: 'none',
        resolve: async (seed, signal, onProgress, previousOptions) => {
            const project = (resolved: Awaited<ReturnType<typeof source.resolve>>) => {
                const previousById = new Map(previousOptions?.map(option => [option.id, option]));
                const page = isUniversalSearchResolvePage(resolved)
                    ? resolved
                    : { results: resolved, emptyHint: undefined };
                // Hits arrive grouped by file; each row is one matching line and names its `path:line` (Find lab G1)
                // so any row read alone, spoken or scrolled to, still says where it lands.
                const lines = groupFileContentLines(page.results);
                const options: SelectionListOption[] = lines.length === 0
                    ? page.results.slice(0, input.rowLimit).map((result) => toOption(result, input.iconName, input.onCommit, undefined, seed.trim() || undefined,
                        previousById.get(buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id))))
                    : input.groupByFile
                        ? (() => {
                            // One gutter per file, as wide as its last shown line number.
                            const gutterDigitsByPath = new Map<string, number>();
                            for (const { line } of lines) {
                                gutterDigitsByPath.set(line.path, Math.max(gutterDigitsByPath.get(line.path) ?? 1, String(line.line + line.after.length).length));
                            }
                            return lines.flatMap(({ result, line }, index): SelectionListOption[] => {
                            const location = `${line.path}:${line.line}`;
                            const lineOption: SelectionListOption = {
                                ...toOption(result, input.iconName, input.onCommit, line),
                                label: location,
                                labelContent: () => <FileContentLineLabel match={line} gutterDigits={gutterDigitsByPath.get(line.path) ?? 1} />,
                                // The code is the row's title here; the file heading above says where.
                                subtitle: undefined, subtitleContent: undefined,
                                // An empty mark slot keeps the code on the file name's edge.
                                icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
                                accessibilityLabel: `${location} ${line.text.trim()}`,
                            };
                            if (index > 0 && lines[index - 1]!.line.path === line.path) return [lineOption];
                            const matches = lines.filter((entry) => entry.line.path === line.path)
                                .reduce((count, entry) => count + entry.line.columns.length, 0);
                            return [{
                                id: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}:file:${line.path}`,
                                label: line.path,
                                // A heading, not a choice: it reads at full strength and the keyboard passes over it.
                                disabled: true,
                                content: <FileContentGroupHeader path={line.path} matches={matches} />,
                            }, lineOption];
                        });
                        })()
                        : lines.slice(0, input.rowLimit).map(({ result, line }) => {
                            const location = `${line.path}:${line.line}`;
                            return {
                                ...toOption(result, input.iconName, input.onCommit, line),
                                label: location,
                                labelContent: () => <FileContentLabel match={line} />,
                                labelEllipsizeMode: 'head' as const,
                                accessibilityLabel: `${location} ${line.text.trim()}`,
                            };
                        });
                if (input.sourceId === UNIVERSAL_SEARCH_SOURCE_IDS.fileContent && !input.groupByFile && input.onShowAll && (options.length > 0 || page.hasMore)) {
                    const files = new Set(page.results.filter(result => result.fileContent).map(result => result.fileContent!.path)).size;
                    options.push({
                        id: ALL_FILE_MATCHES_OPTION_ID,
                        testID: 'universal-search:all-file-matches',
                        label: page.hasMore ? t('universalSearch.content.moreMatches')
                            : t('universalSearch.content.allMatches', { matches: page.results.length, files }),
                        // A summary, not a hit: set at the meta step in quiet ink, like the lab's "All 11 matches in 4 files".
                        labelContent: () => <AllMatchesLabel label={page.hasMore ? t('universalSearch.content.moreMatches')
                            : t('universalSearch.content.allMatches', { matches: page.results.length, files })} />,
                        rightAccessory: () => <TextInFilesShortcut />,
                        // An empty mark slot puts "All N matches" on the text column of the lines above (lab G1).
                        icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
                        onSelect: input.onShowAll,
                    });
                }
                const noMatch = input.noMatch;
                if (noMatch && options.length === 0 && seed.trim() && page.emptyHint === undefined) {
                    const label = t('universalSearch.quickOpen.noMatch', { query: seed.trim(), scope: noMatch.scopeLabel });
                    options.push({
                        id: `${UNIVERSAL_SEARCH_SOURCE_IDS.files}:no-match`,
                        testID: 'universal-search:files-no-match',
                        label,
                        accessibilityLabel: `${label}. ${t('universalSearch.quickOpen.searchEverything')}`,
                        labelContent: () => <AllMatchesLabel label={label} />,
                        rightAccessory: () => <AllMatchesLabel label={t('universalSearch.quickOpen.searchEverything')} />,
                        icon: icon('magnifying-glass'),
                        onSelect: noMatch.onSearchEverything,
                    });
                    if (noMatch.recent.length > 0) {
                        options.push({
                            id: `${UNIVERSAL_SEARCH_SOURCE_IDS.files}:no-match:recent`,
                            label: t('universalSearch.quickOpen.recent'),
                            // A heading, not a choice: the keyboard passes over it.
                            disabled: true,
                            content: <QuickOpenGroupHeading title={t('universalSearch.quickOpen.recent')} />,
                        }, ...noMatch.recent.slice(0, NO_MATCH_RECENT_ROWS).map(result => toOption(result, 'file', input.onCommit)));
                    }
                }
                if (input.sourceId === UNIVERSAL_SEARCH_SOURCE_IDS.files && page.hasMore && source.loadMore) {
                    options.push({ id: MORE_FILES_OPTION_ID, label: t('universalSearch.quickOpen.showMore'), onSelect: source.loadMore });
                }
                if (input.groupByFile && lines.length > 0) {
                    // The scope's status line (lab G1s): how much was found; the Text in files token says where.
                    options.unshift({
                        id: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}:status`,
                        label: t('universalSearch.content.matchesInFiles', { matches: page.results.length, files: new Set(lines.map((entry) => entry.line.path)).size }),
                        disabled: true,
                        content: <FileContentScopeStatus label={t('universalSearch.content.matchesInFiles', { matches: page.results.length, files: new Set(lines.map((entry) => entry.line.path)).size })} />,
                    });
                }
                // Inside the Text in files scope there is nowhere further to go: an incomplete page says so.
                const scopeHints = input.groupByFile ? boundedReplyHints({ rowCount: lines.length, incomplete: page.hasMore === true }) : {};
                const resultHint = page.resultHint ?? scopeHints.resultHint ?? source.resultHint;
                // Coverage still describes the searched corpus when it yields no rows.
                // SelectionList needs its empty-state hint to retain that section.
                const emptyHint = page.emptyHint ?? scopeHints.emptyHint ?? (options.length === 0 ? resultHint : undefined);
                previousOptions = options;
                return {
                    options,
                    ...(emptyHint !== undefined ? { emptyHint } : {}),
                    ...(resultHint !== undefined ? { resultHint } : {}),
                };
            };
            const resolved = await source.resolve(input.preserveQuery ? seed : seed.trim(), signal,
                onProgress ? page => onProgress(project(page)) : undefined);
            return project(resolved);
        },
    }];
}

function narrowLocalEntities<T>(
    entities: readonly T[],
    query: string,
    recentLimit: number,
): readonly T[] {
    // On an empty query the list is a bounded "what you had open" set. With a
    // query the host matcher does the narrowing and ranking, so every candidate
    // must be offered. SelectionList virtualizes the resulting rows; there is no
    // pre-match display cap that can hide a valid later candidate.
    return query.length === 0 ? entities.slice(0, recentLimit) : entities;
}

type UniversalSearchSectionProjection = Readonly<{
    sections: readonly SelectionListSectionDescriptor[];
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource;
}>;

function buildVirtualizedFilesOptions(input: BuildUniversalSearchSectionsInput): SelectionListVirtualizedOptionSource | undefined {
    const recent = input.recentFiles ?? [];
    const changed = input.changedFileSource ?? {
        count: input.changedFiles?.length ?? 0,
        getOptionId: (index: number) => {
            const result = input.changedFiles![index]!;
            return buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id);
        },
        getResult: (index: number) => input.changedFiles![index]!,
    };
    const items: SelectionListVirtualizedOptionSourceItem[] = [];
    const headers: SelectionListVirtualizedOptionSourceHeader[] = [];
    const ids: string[] = [];
    const positions = new Map<string, Readonly<{ optionIndex: number; itemIndex: number }>>();
    const changedIndexes: number[] = [];
    const addOption = (id: string) => {
        const optionIndex = ids.length;
        ids.push(id);
        positions.set(id, { optionIndex, itemIndex: items.length });
        items.push({ kind: 'option', key: id, optionIndex, positionInSet: optionIndex + 1 });
    };
    const addHeader = (id: string, title: string) => {
        const sectionIndex = headers.length;
        headers.push({ id, title, ...(sectionIndex === 0 && input.filesStatusHint ? { resultHint: input.filesStatusHint } : {}) });
        items.push({ kind: 'section-header', key: `${id}::header`, sectionIndex });
    };
    const addHint = () => {
        const sectionIndex = headers.length - 1;
        const header = headers[sectionIndex];
        if (header?.resultHint) items.push({ kind: 'result-hint', key: `${header.id}::resultHint`, sectionIndex });
    };
    if (recent.length > 0) {
        addHeader('files:recent', t('universalSearch.quickOpen.recent'));
        for (const result of recent) addOption(buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id));
        addHint();
    }
    const recentIds = new Set(ids);
    for (let index = 0; index < changed.count; index += 1) {
        const id = changed.getOptionId(index);
        if (recentIds.has(id)) continue;
        if (changedIndexes.length === 0) addHeader('files:changed', input.changedFilesScope === 'folder'
            ? t('universalSearch.quickOpen.changedInFolder') : t('universalSearch.quickOpen.changed'));
        changedIndexes.push(index);
        addOption(id);
    }
    if (changedIndexes.length > 0) addHint();
    if (ids.length === 0) return undefined;
    const focusable = (index: number) => index >= 0 && index < ids.length;
    return {
        items, optionCount: ids.length, stateKey: '',
        getOption: index => {
            if (!focusable(index)) throw new RangeError('Unknown quick-open option');
            return toOption(index < recent.length ? recent[index]! : changed.getResult(changedIndexes[index - recent.length]!), 'file', input.onCommitResult);
        },
        getOptionId: index => ids[index] ?? '',
        findOptionIndexById: id => positions.get(id)?.optionIndex ?? -1,
        findItemIndexByOptionIndex: index => positions.get(ids[index] ?? '')?.itemIndex ?? -1,
        getFirstFocusableOptionIndex: () => 0,
        getNextFocusableOptionIndex: (index, direction) => (index + direction + ids.length) % ids.length,
        isFocusableOptionIndex: focusable,
        getHeader: sectionIndex => headers[sectionIndex]!,
    };
}

export function buildUniversalSearchSections(input: BuildUniversalSearchSectionsInput): readonly SelectionListSectionDescriptor[];
export function buildUniversalSearchSections(input: BuildUniversalSearchSectionsInput, projection: 'virtualized'): UniversalSearchSectionProjection;
export function buildUniversalSearchSections(
    { previousSections, ...input }: BuildUniversalSearchSectionsInput,
    projection?: 'virtualized',
): ReadonlyArray<SelectionListSectionDescriptor> | UniversalSearchSectionProjection {
    if (projection === 'virtualized') {
        const virtualizedOptionSource = input.source === 'files' && !input.query.trim() ? buildVirtualizedFilesOptions(input) : undefined;
        return virtualizedOptionSource ? { sections: [], virtualizedOptionSource } : { sections: buildUniversalSearchSections({ ...input, previousSections }) };
    }
    const query = input.query.trim();
    const rowLimit = input.rowLimit ?? UNIVERSAL_SEARCH_PAGE_SIZE;
    const onCommit = input.onCommitResult;
    const previousOptions = new Map(previousSections?.flatMap(section => section.kind === 'static'
        ? section.options.filter(hasUniversalSearchOptionProjection).map(option => [option.id, option] as const) : []));
    const localOption = (result: UniversalSearchResult, iconName: IconName, titleQuery?: string) =>
        toOption(result, iconName, onCommit, undefined, titleQuery,
            previousOptions.get(buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id)));
    const sections: SelectionListSectionDescriptor[] = [];
    const scopedToContent = input.source === 'fileContent';
    if (input.source === 'symbols') return buildDynamicSection({ sourceId: 'symbols',
        title: t('universalSearch.quickOpen.symbols'), source: input.symbols ?? { status: 'absent' },
        iconName: 'file', minQueryLength: 0, onCommit }).map(section => ({ kind: 'dynamic' as const, ...section }));
    if (input.source === 'files') {
        const recentIds = new Set(input.recentFiles?.map(result => buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id)));
        if (!query) {
            const groups = [
                { id: 'files:recent', title: t('universalSearch.quickOpen.recent'), results: input.recentFiles },
                // A Session lists what it changed; a project (no Session) lists the folder's uncommitted changes.
                { id: 'files:changed', title: input.changedFilesScope === 'folder' ? t('universalSearch.quickOpen.changedInFolder') : t('universalSearch.quickOpen.changed'), results: input.changedFiles?.filter(result => !recentIds.has(buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id))) },
            ].flatMap(({ id, title, results }): SelectionListSectionDescriptor[] => results?.length ? [{
                kind: 'static', id, title, options: results.map(result => localOption(result, 'file')),
            }] : []);
            if (input.filesStatusHint && groups.length > 0) return groups.map((group, index) => index === 0 ? { ...group, resultHint: input.filesStatusHint } : group);
            if (input.filesStatusHint) return buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
                title: t('universalSearch.sections.files'), source: { status: 'unavailable',
                    resolverKey: input.files.status === 'absent' ? input.filesStatusHint : input.files.resolverKey, hint: input.filesStatusHint },
                iconName: 'file', minQueryLength: 0, onCommit }).map(section => ({ kind: 'dynamic' as const, ...section }));
            // Nothing recent and nothing changed yet: the folder's own files, never "No matches" for an empty query (lab FB2).
            if (groups.length === 0) return buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
                title: t('universalSearch.sections.files'), source: input.files, iconName: 'file', minQueryLength: 0, onCommit,
            }).map(section => ({ kind: 'dynamic' as const, ...section }));
            return groups;
        }
        return buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files, title: t('universalSearch.sections.files'),
            source: input.files, iconName: 'file', onCommit,
            ...(input.filesNoMatch ? { noMatch: { ...input.filesNoMatch, recent: input.recentFiles ?? [] } } : {}),
        }).map(section => ({ kind: 'dynamic' as const, ...section }));
    }
    const folders = input.fileContentFolders ?? [];
    const noFolderInScope = (input.fileContent ?? { status: 'absent' }).status === 'absent';
    // No folder in scope (lab ST): the group offers the recent folders instead of guessing one. Inline it
    // waits for a query and shows a few. The Text in files scope opens on all of them as local rows, so a
    // reordering never blanks the list; the typed query is what the chosen folder is searched for, and the
    // step's empty line says how to get a folder when there are none.
    const folderSuggestions = (rows: readonly UniversalSearchFolderSuggestion[]) => rows.map((folder): SelectionListOption => ({
        id: `${FILE_CONTENT_FOLDER_OPTION_PREFIX}${folder.id}`,
        label: t('universalSearch.content.searchInFolder', { name: folder.name }),
        ...(folder.subtitle ? { subtitle: folder.subtitle } : {}),
        icon: icon('folder'),
        onSelect: folder.onSelect,
    }));
    const contentSections: SelectionListSectionDescriptor[] = noFolderInScope && scopedToContent
        ? folders.length > 0 ? [{ kind: 'static', id: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent, options: folderSuggestions(folders) }] : []
        : noFolderInScope && folders.length > 0 && !scopedToContent
        ? [{
            kind: 'dynamic' as const,
            id: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent,
            title: t('universalSearch.content.textInFiles'),
            resolverKey: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}|folders|${folders.map((folder) => folder.id).join('|')}`,
            visibleWhen: (value: string) => value.length > 0,
            resultFiltering: 'provider' as const,
            debounceMs: 0,
            resultTransition: 'none' as const,
            resolve: async () => ({ options: folderSuggestions(folders.slice(0, INLINE_FILE_CONTENT_LINES)) }),
        }]
        : buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent, title: t('universalSearch.content.textInFiles'), source: input.fileContent ?? { status: 'absent' }, iconName: 'file', preserveQuery: true, scopeLabel: input.fileContentScopeLabel, onShowAll: input.onShowAllFileMatches, onCommit,
        // Inline (lab G1) the group shows the best few lines and then "All N matches"; the scope lists every line by file.
        ...(scopedToContent ? { groupByFile: true } : { rowLimit: INLINE_FILE_CONTENT_LINES }) }).map((section) => ({ kind: 'dynamic' as const, ...section }));
    if (scopedToContent) return contentSections;

    // Construction, currentness, availability, i18n and activation of commands
    // all stay with `buildCommandPaletteCommands`.
    const nonRecentCommands = input.commands.filter((command) => command.kind !== 'recentSession');
    const visibleCommands = query.length > 0
        ? nonRecentCommands
        : nonRecentCommands
            .filter((command) => command.emptyQuerySuggested === true);
    const commandSections = buildCommandPaletteSelectionListSections(visibleCommands, previousSections, query || undefined);

    // Empty query: pinned Sessions lead (lab palette "Pinned"), and Recent shows only the unpinned ones.
    const pinnedSessionIds = query.length === 0 ? input.pinnedSessionIds ?? [] : [];
    const pinnedSessionIdSet = new Set(pinnedSessionIds);
    const sessionsById = pinnedSessionIds.length > 0 ? new Map(input.sessions.map(session => [session.sessionId, session])) : null;
    const pinnedSessions = sessionsById ? pinnedSessionIds.flatMap(sessionId => sessionsById.get(sessionId) ?? []) : [];
    const sessions = narrowLocalEntities(pinnedSessions.length > 0
        ? input.sessions.filter(session => !pinnedSessionIdSet.has(session.sessionId)) : input.sessions, query, EMPTY_QUERY_RECENT_LIMIT);
    const sessionInventoryHint = query.length > 0
        ? input.sessionInventoryStatus === 'loading'
            ? t('universalSearch.sessionInventoryLoading')
            : input.sessionInventoryStatus === 'error'
                ? t('universalSearch.sessionInventoryIncomplete')
                : undefined
        : undefined;
    const sessionOption = (session: UniversalSearchSessionEntity) => localOption({
        id: session.sessionId,
        // The same session id can exist on two Homes; the Home the row
        // was projected from is part of what the user selected.
        scopeKey: buildUniversalSearchScopeKey([session.accountId, session.serverId]),
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.sessions,
        kind: 'session',
        title: session.title,
        ...(session.subtitle ? { subtitle: session.subtitle } : {}),
        ...(session.searchText ? { searchText: session.searchText } : {}),
        ...(session.exactSearchText ? { exactSearchText: session.exactSearchText } : {}),
    ...(session.agentId ? { agentId: session.agentId } : {}),
        target: {
            kind: 'session',
            sessionId: session.sessionId,
            serverId: session.serverId,
            accountId: session.accountId,
        },
    }, 'chats-circle', query || undefined);
    const pinnedSessionSection: SelectionListSectionDescriptor | null = pinnedSessions.length > 0
        ? { kind: 'static', id: `${UNIVERSAL_SEARCH_SOURCE_IDS.sessions}:pinned`, title: t('universalSearch.sections.pinned'), options: pinnedSessions.map(sessionOption) }
        : null;
    const sessionSection: SelectionListSectionDescriptor | null = sessions.length > 0 || sessionInventoryHint
        ? {
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.sessions,
            title: query.length === 0
                ? t('commandPalette.commands.recentSessionsCategory')
                : t('universalSearch.sections.sessions'),
            options: sessions.map(sessionOption),
            ...(sessionInventoryHint ? { resultHint: sessionInventoryHint } : {}),
        }
        : null;

    // The Settings catalog ranks and admits literal matches or title typos. Its shared row projection
    // shows the description/keyword when it explains the hit; preserve that provider order.
    // SelectionList owns dispatch for a changed query. Building descriptors as other sources
    // publish must not run the catalog's Fuse search again.
    const settingsSection: SelectionListSectionDescriptor | null = query.length > 0
        ? {
            kind: 'dynamic',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
            title: t('universalSearch.sections.settings'),
            // The catalog is the target; the typed query is the seed, so refining it keeps the group continuous.
            resolverKey: `${UNIVERSAL_SEARCH_SOURCE_IDS.settings}|${input.settingsSearchRevision ?? 0}`,
            visibleWhen: (value: string) => value.trim().length > 0,
            debounceMs: 0,
            resultFiltering: 'provider',
            // No first-load placeholder: matching is local and settles at once, and a group header
            // with no rows must never show while the catalog's verdict for the query is pending.
            resultTransition: 'none',
            resolve: async (seed, _signal, _onProgress, previous) => {
                const previousById = new Map(previous?.map(option => [option.id, option]));
                return {
                    options: input.searchSettingsPages(seed.trim()).slice(0, rowLimit).map((page) => toOption({
                        id: page.id,
                        // Settings pages are host-local: the catalog is the scope.
                        scopeKey: buildUniversalSearchScopeKey(['settings']),
                        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
                        kind: 'settingsPage',
                        title: page.title,
                        ...(page.subtitle ? { subtitle: page.subtitle } : {}),
                        target: { kind: 'settingsPage', route: page.route },
                    }, 'sliders-horizontal', onCommit, undefined, undefined,
                        previousById.get(buildUniversalSearchOptionId(UNIVERSAL_SEARCH_SOURCE_IDS.settings,
                            buildUniversalSearchScopeKey(['settings']), page.id)))),
                };
            },
        }
        : null;

    // One stable group order; a group appears only when it has rows (or a truthful hint).
    // Empty query: what you had open first, then the suggested commands (Actions, Go to).
    // With a query: matching commands, then Settings, then Sessions.
    if (query.length === 0) {
        if (pinnedSessionSection) sections.push(pinnedSessionSection);
        if (sessionSection) sections.push(sessionSection);
        sections.push(...commandSections);
    } else {
        sections.push(...commandSections);
        if (settingsSection) sections.push(settingsSection);
        if (sessionSection) sections.push(sessionSection);
    }

    const projects = narrowLocalEntities(input.projects, query, EMPTY_QUERY_RECENT_LIMIT);
    if (projects.length > 0) {
        sections.push({
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.projects,
            title: t('universalSearch.sections.projects'),
            options: projects.map((project) => localOption({
                id: project.workspaceRefId,
                scopeKey: buildUniversalSearchWorkspaceScopeKey(project.accountId, project),
                sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.projects,
                kind: 'project',
                title: project.title,
                ...(project.subtitle ? { subtitle: project.subtitle } : {}),
                target: {
                    kind: 'project',
                    workspaceRefId: project.workspaceRefId,
                    serverId: project.serverId,
                    accountId: project.accountId,
                    machineId: project.machineId,
                    rootPath: project.rootPath,
                    ...(project.workspace ? { workspace: project.workspace } : {}),
                },
            }, 'folder-open', query || undefined)),
        });
    }

    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.transcript,
        title: t('universalSearch.sections.messages'),
        source: input.transcript,
        iconName: 'chat-circle-dots',
        rowLimit,
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    if (query.length > 0 && input.externalConversationSearch && input.externalConversationSearch.standardSearchEnabled !== false) {
        const search = input.externalConversationSearch;
        sections.push({
            kind: 'static',
            id: 'externalConversations',
            // Lab H1: the group names where the scan runs; the row is the one action.
            title: search.machineLabel
                ? t('externalSessions.browseContentOnMachine', { machine: search.machineLabel })
                : t('conversationSearch.scopeAllMachinesSubtitle'),
            options: [{
                id: EXTERNAL_CONVERSATION_SEARCH_OPTION_ID,
                testID: 'universal-search:external-conversations:search',
                label: t('externalSessions.browseContentPaletteSearch', { query: input.query }),
                icon: icon('chat-circle-dots'),
                onSelect: () => search.onSearch(input.query),
            }],
        });
    }

    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
        title: t('universalSearch.sections.files'),
        source: input.files,
        iconName: 'file',
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    sections.push(...contentSections);
    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.commits,
        title: t('universalSearch.sections.commits'),
        source: input.commits,
        iconName: 'git-branch',
        rowLimit,
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    for (const section of input.pluginSections) {
        // Query-result motion and first-load truth are host presentation policy,
        // not plugin descriptor policy. Keep every admitted plugin section on
        // the same high-frequency Search behavior as built-in providers.
        sections.push({
            kind: 'dynamic',
            ...section,
            showSkeletonsOnFirstLoad: true,
            loadingHint: t('universalSearch.searchingGroup'),
            // A failing provider says so in host copy, like every built-in group; its message stays in logs.
            errorHint: t('universalSearch.groupFailed', { group: section.title ?? section.id }),
            retryLabel: t('common.retry'),
            resultTransition: 'none',
        });
    }

    // A named Session or Project is the reader's content. Keep its group ahead
    // of settings/commands matched by descriptions or catalog keywords, using
    // the same title matcher as SelectionList rather than another score.
    if (query.length > 0) {
        const titleMatches = new Set(sections.filter(section => section.kind === 'static'
            && (section.id === UNIVERSAL_SEARCH_SOURCE_IDS.sessions || section.id === UNIVERSAL_SEARCH_SOURCE_IDS.projects)
            && rankHappierQueryMatches(section.options, query, option => ({ label: option.label })).length > 0));
        return [...sections.filter(section => titleMatches.has(section)), ...sections.filter(section => !titleMatches.has(section))];
    }
    return sections;
}

/** Resolve the command a rendered option id refers to, if any. */
export function findCommandForOptionId(
    commands: readonly Command[],
    optionId: string,
): Command | null {
    for (const command of commands) {
        if (buildCommandPaletteOptionId(command.id) === optionId) return command;
    }
    return null;
}
