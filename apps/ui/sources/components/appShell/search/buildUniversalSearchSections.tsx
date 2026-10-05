import * as React from 'react';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import type {
    SelectionListDynamicSection,
    SelectionListOption,
    SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import type { Command } from '@/components/appShell/commandPalette/types';
import {
    buildCommandPaletteOptionId,
    buildCommandPaletteSelectionListSections,
} from '@/components/appShell/commandPalette/buildCommandPaletteSelectionListSections';

import {
    UNIVERSAL_SEARCH_SOURCE_IDS,
    buildUniversalSearchOptionId,
    buildUniversalSearchScopeKey,
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
const DEFAULT_ROW_LIMIT = 20;
export const EXTERNAL_CONVERSATION_SEARCH_OPTION_ID = 'external-conversations:search';

export type UniversalSearchSessionEntity = Readonly<{
    sessionId: string;
    serverId: string;
    accountId: string;
    title: string;
    subtitle?: string;
    searchText?: string;
    exactSearchText?: string;
    updatedAt: number;
}>;

export type UniversalSearchProjectEntity = Readonly<{
    workspaceRefId: string;
    serverId: string;
    accountId: string;
    machineId: string;
    rootPath: string;
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
    /** Calm source-owned coverage/truncation context rendered by SelectionList. */
    resultHint?: string;
    resolve: (query: string, signal: AbortSignal) => Promise<
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

export type BuildUniversalSearchSectionsInput = Readonly<{
    query: string;
    commands: readonly Command[];
    sessions: readonly UniversalSearchSessionEntity[];
    sessionInventoryStatus?: 'idle' | 'loading' | 'ready' | 'error';
    projects: readonly UniversalSearchProjectEntity[];
    /** The resolved settings catalog's own Fuse owner; never a second matcher. */
    searchSettingsPages: (query: string) => readonly UniversalSearchSettingsPageEntity[];
    transcript: UniversalSearchSource;
    files: UniversalSearchSource;
    fileContent?: UniversalSearchSource;
    source?: 'fileContent';
    commits: UniversalSearchSource;
    /** Already-built plugin provider sections; this module adds no plugin policy. */
    pluginSections: readonly SelectionListDynamicSection[];
    /** Explicit activation only: typing in Search never scans Agent transcripts. */
    externalConversationSearch?: Readonly<{ machineLabel: string; onSearch(query: string): void }>;
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
function FileContentSnippet({ match }: Readonly<{ match: NonNullable<UniversalSearchResult['fileContent']> }>): React.ReactElement {
    const { theme } = useUnistyles();
    const start = Math.max(0, match.column16 - 1);
    const lead = match.text.slice(0, start).trimStart();
    const shownLead = lead.length > SNIPPET_LEAD_CHARS + 8 ? `…${lead.slice(-SNIPPET_LEAD_CHARS)}` : lead;
    const text = `${shownLead}${match.text.slice(start)}`;
    const ranges = [{ start: shownLead.length, end: shownLead.length + match.length16, current: false }];
    return (
        <View style={{ marginTop: 2 }}>
            <Text useDefaultTypography={false} numberOfLines={1} style={{ ...Typography.mono(), fontSize: 12, lineHeight: 17, color: theme.colors.text.secondary }}>
                <FindHighlightedText text={text} ranges={ranges} />
            </Text>
        </View>
    );
}

/** A file's own type mark (the Files tree's), not a generic glyph. */
function fileIcon(path: string): () => React.ReactElement {
    const name = path.slice(path.lastIndexOf('/') + 1);
    // A filled type tile reads larger than a line glyph; the small size matches its optical weight.
    return () => <FileIcon fileName={name} size={ICON_SIZE.sm} />;
}

function toOption(
    result: UniversalSearchResult,
    iconName: IconName,
    onCommit: (result: UniversalSearchResult) => void,
): SelectionListOption {
    return {
        id: buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id),
        testID: `universal-search:option:${result.sourceId}:${result.id}`,
        label: result.target.kind === 'workspaceFile' && !result.fileContent && result.target.anchor && 'startLine' in result.target.anchor
            // A `path:line` hit says where it lands.
            ? `${result.title}:${result.target.anchor.startLine}`
            : result.title,
        ...(result.subtitle ? { subtitle: result.subtitle } : {}),
        ...(result.fileContent ? { subtitleContent: () => <FileContentSnippet match={result.fileContent!} /> } : {}),
        ...(result.searchText ? { searchText: result.searchText } : {}),
        ...(result.exactSearchText ? { exactSearchText: result.exactSearchText } : {}),
        ...((result.kind === 'project' || result.kind === 'workspaceFile') && result.subtitle
            ? { subtitleEllipsizeMode: 'head' as const }
            : {}),
        icon: result.fileContent ? fileIcon(result.fileContent.path)
            : result.kind === 'workspaceFile' && result.target.kind === 'workspaceFile' ? fileIcon(result.target.path)
            : icon(iconName),
        onSelect: () => { onCommit(result); },
    };
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
        onCommit: (result: UniversalSearchResult) => void;
    }>,
): SelectionListDynamicSection[] {
    const { source } = input;
    if (source.status === 'absent') return [];

    if (source.status === 'unavailable') {
        return [{
            id: input.sourceId,
            title: input.title,
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
        title: input.title,
        resolverKey: `${input.sourceId}|${source.resolverKey}`,
        visibleWhen: (value: string) => (input.preserveQuery ? value.length : value.trim().length) >= (input.minQueryLength ?? 1),
        resultFiltering: 'provider',
        showSkeletonsOnFirstLoad: true,
        resultTransition: 'none',
        resolve: async (seed, signal) => {
            const resolved = await source.resolve(input.preserveQuery ? seed : seed.trim(), signal);
            const page = isUniversalSearchResolvePage(resolved)
                ? resolved
                : { results: resolved, emptyHint: undefined };
            // Hits arrive grouped by file; each row names its `path:line` (Find lab G1) so any row read alone,
            // spoken or scrolled to, still says where it lands.
            const options = page.results.slice(0, input.rowLimit).map((result) => {
                const option = toOption(result, input.iconName, input.onCommit);
                if (!result.fileContent) return option;
                const location = `${result.fileContent.path}:${result.fileContent.line}`;
                return {
                    ...option,
                    label: location,
                    labelEllipsizeMode: 'head' as const,
                    accessibilityLabel: `${location} ${result.fileContent.text.trim()}`,
                };
            });
            return {
                options,
                ...(page.emptyHint !== undefined ? { emptyHint: page.emptyHint } : {}),
                ...(input.sourceId === UNIVERSAL_SEARCH_SOURCE_IDS.fileContent && page.hasMore
                    ? { resultHint: t('universalSearch.content.refineSearch') }
                    : page.resultHint !== undefined
                    ? { resultHint: page.resultHint }
                    : source.resultHint !== undefined ? { resultHint: source.resultHint } : {}),
            };
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

export function buildUniversalSearchSections(
    input: BuildUniversalSearchSectionsInput,
): ReadonlyArray<SelectionListSectionDescriptor> {
    const query = input.query.trim();
    const rowLimit = input.rowLimit ?? DEFAULT_ROW_LIMIT;
    const onCommit = input.onCommitResult;
    const sections: SelectionListSectionDescriptor[] = [];
    const contentSections = buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent, title: t('universalSearch.content.textInFiles'), source: input.fileContent ?? { status: 'absent' }, iconName: 'file', preserveQuery: true, onCommit }).map((section) => ({ kind: 'dynamic' as const, ...section }));
    if (input.source === 'fileContent') return contentSections;

    // Construction, currentness, availability, i18n and activation of commands
    // all stay with `buildCommandPaletteCommands`.
    const nonRecentCommands = input.commands.filter((command) => command.kind !== 'recentSession');
    const visibleCommands = query.length > 0
        ? nonRecentCommands
        : nonRecentCommands
            .filter((command) => command.emptyQuerySuggested === true);
    const commandSections = buildCommandPaletteSelectionListSections(visibleCommands);

    const sessions = narrowLocalEntities(input.sessions, query, EMPTY_QUERY_RECENT_LIMIT);
    const sessionInventoryHint = query.length > 0
        ? input.sessionInventoryStatus === 'loading'
            ? t('universalSearch.sessionInventoryLoading')
            : input.sessionInventoryStatus === 'error'
                ? t('universalSearch.sessionInventoryIncomplete')
                : undefined
        : undefined;
    const sessionSection: SelectionListSectionDescriptor | null = sessions.length > 0 || sessionInventoryHint
        ? {
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.sessions,
            title: query.length === 0
                ? t('commandPalette.commands.recentSessionsCategory')
                : t('universalSearch.sections.sessions'),
            options: sessions.map((session) => toOption({
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
                target: {
                    kind: 'session',
                    sessionId: session.sessionId,
                    serverId: session.serverId,
                    accountId: session.accountId,
                },
            }, 'chats-circle', onCommit)),
            ...(sessionInventoryHint ? { resultHint: sessionInventoryHint } : {}),
        }
        : null;

    // Settings pages come pre-ranked by the settings catalog's own Fuse owner,
    // which matches keywords and ancestor titles the row never displays. It is a
    // local corpus, so it resolves with no debounce; it is provider-filtered so
    // a keyword-only match is not thrown away by the host matcher.
    const settingsPages = query.length > 0 ? input.searchSettingsPages(query).slice(0, rowLimit) : [];
    const settingsSection: SelectionListSectionDescriptor | null = settingsPages.length > 0
        ? {
            kind: 'dynamic',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
            title: t('universalSearch.sections.settings'),
            resolverKey: `${UNIVERSAL_SEARCH_SOURCE_IDS.settings}|${query}`,
            visibleWhen: (value: string) => value.trim().length > 0,
            debounceMs: 0,
            loadingSkeletonRows: 0,
            resultFiltering: 'provider',
            showSkeletonsOnFirstLoad: true,
            resultTransition: 'none',
            resolve: async () => ({
                options: settingsPages.map((page) => toOption({
                    id: page.id,
                    // Settings pages are host-local: the catalog is the scope.
                    scopeKey: buildUniversalSearchScopeKey(['settings']),
                    sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
                    kind: 'settingsPage',
                    title: page.title,
                    ...(page.subtitle ? { subtitle: page.subtitle } : {}),
                    target: { kind: 'settingsPage', route: page.route },
                }, 'sliders-horizontal', onCommit)),
            }),
        }
        : null;

    // One stable group order; a group appears only when it has rows (or a truthful hint).
    // Empty query: what you had open first, then the suggested commands (Actions, Go to).
    // With a query: matching commands, then Settings, then Sessions.
    if (query.length === 0) {
        if (sessionSection) sections.push(sessionSection);
        sections.push(...commandSections);
    } else {
        sections.push(...commandSections);
        if (settingsSection) sections.push(settingsSection);
        if (sessionSection) sections.push(sessionSection);
    }

    const projects = narrowLocalEntities(input.projects, query, EMPTY_QUERY_RECENT_LIMIT);
    if (query.length > 0 && input.externalConversationSearch) {
        const search = input.externalConversationSearch;
        sections.push({
            kind: 'static',
            id: 'externalConversations',
            options: [{
                id: EXTERNAL_CONVERSATION_SEARCH_OPTION_ID,
                testID: 'universal-search:external-conversations:search',
                label: t('externalSessions.browseContentPaletteSearch', { query: input.query }),
                subtitle: t('externalSessions.browseContentOnMachine', { machine: search.machineLabel }),
                icon: icon('chat-circle-dots'),
                onSelect: () => search.onSearch(input.query),
            }],
        });
    }
    if (projects.length > 0) {
        sections.push({
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.projects,
            title: t('universalSearch.sections.projects'),
            options: projects.map((project) => toOption({
                id: project.workspaceRefId,
                scopeKey: buildUniversalSearchScopeKey([
                    project.accountId,
                    project.serverId,
                    project.machineId,
                    project.rootPath,
                ]),
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
                },
            }, 'folder-open', onCommit)),
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

    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
        title: t('universalSearch.sections.files'),
        source: input.files,
        iconName: 'file',
        rowLimit,
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
            resultTransition: 'none',
        });
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
