import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import {
    isMemoryDocumentSearchHitV1,
    isMemorySessionSearchHitV1,
    MemorySearchResultV1Schema,
    type MemoryDocumentSearchCoverageV1,
    type MemoryDocumentSearchHitV1,
    type MemorySearchCorpusV1,
    type MemorySearchErrorCode,
    type MemorySearchHitV1,
    type MemorySearchResultV1,
    type MemorySearchScope,
} from '@happier-dev/protocol/memory/memorySearch';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { SessionListIdentity, useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { MemoryMachineChoice } from './MemoryMachineChoice';
import { useMemoryOffline } from './useMemoryOffline';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useServerScopedMachine, useSession } from '@/sync/store/hooks';
import { getMachineDisplayName, getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { formatMemoryDate, memoryTopicLabel } from './MemoryDocumentBody';
import { memoryDocumentSearchHitHref } from './memoryDocumentRoutes';

const CORPORA: readonly MemorySearchCorpusV1[] = ['documents', 'sessions'];
/** Typing settles before a machine is asked; a superseded query is cancelled, not raced. */
const SEARCH_SETTLE_MS = 250;
const GLOBAL_SCOPE: MemorySearchScope = { type: 'global' };

type Results = Readonly<{
    contextKey: string;
    /** The exact peer these results came from; a Machine id is only meaningful inside its Home. */
    serverId: string;
    machineId: string;
    query: string;
    status: 'searching' | 'ready' | 'failed';
    documentsCoverage: MemoryDocumentSearchCoverageV1 | null;
    /** Preserve the negotiated cause and exact peer for the presentation owner's repair UI. */
    failure: Readonly<{
        error: Extract<MemorySearchResultV1, { ok: false }>;
        target: Readonly<{ serverId: string; machineId: string }>;
    }> | null;
    documents: readonly MemoryDocumentSearchHitV1[];
    sessions: readonly MemorySearchHitV1[];
}>;

/**
 * One search over remembered facts (every topic, the archive included) and past sessions (lab
 * `c-mem S`). One engine: the daemon's `memory.search` with the document corpus, through the shared
 * provider decision; it never opens a second index. A remembered hit opens the memory page at its
 * topic (D4-3 `{ type: 'topic', title }`); a session hit opens that session at the match.
 */
export function useMemorySearchPanelModel(props: Readonly<{
    serverId: string;
    scope?: MemorySearchScope;
}>): Readonly<{
    query: string;
    setQuery: React.Dispatch<React.SetStateAction<string>>;
    retry: () => void;
    results: Results | null;
    target: ReturnType<typeof useMemorySearchProvider>['daemonTarget'];
    /** The Machine the person chose to search (with its Home), kept while it cannot answer; it never authorizes a request. */
    selectedTarget: Readonly<{ serverId: string; machineId: string }> | null;
    /** No Memory Machine is chosen for this Home: choosing one is what search needs. */
    machineChoiceNeeded: boolean;
    normalized: string;
}> {
    const { serverId } = props;
    const accountScope = useActiveServerAccountScope();
    const scope = props.scope ?? GLOBAL_SCOPE;
    const scopeKey = JSON.stringify(scope);
    const stableScope = React.useMemo(() => scope, [scopeKey]);
    const provider = useMemorySearchProvider({ kind: 'exact', serverId }, { corpora: CORPORA, scope: stableScope });
    const target = provider.queryAvailable ? provider.daemonTarget : null;
    const [query, setQuery] = React.useState('');
    const [storedResults, setResults] = React.useState<Results | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    const normalized = query.trim();
    const accountId = accountScope?.accountId ?? null;
    const machineId = target?.machineId ?? null;
    const targetServerId = target?.serverId ?? null;
    const contextKey = JSON.stringify([serverId, accountId, scopeKey,
        provider.selectedDaemonTarget?.serverId ?? targetServerId,
        provider.selectedDaemonTarget?.machineId ?? machineId]);
    const results = storedResults?.contextKey === contextKey
        && (machineId === null || storedResults.machineId === machineId) ? storedResults : null;

    React.useEffect(() => {
        if (normalized.length === 0 || !accountId) {
            setResults(null);
            return;
        }
        if (!machineId || !targetServerId) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            // The last results stay on screen while the next query runs.
            setResults((previous) => ({ contextKey, serverId: targetServerId, machineId, query: normalized, status: 'searching', failure: null,
                documentsCoverage: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.documentsCoverage : null,
                documents: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.documents : [],
                sessions: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.sessions : [] }));
            void (async () => {
                try {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    const outcome = await createDefaultActionExecutor().execute('memory.search', {
                        machineId,
                        query: { v: 1, query: normalized, scope: stableScope, mode: 'auto', corpora: CORPORA },
                    }, { serverId: targetServerId, expectedAccountId: accountId, surface: 'ui',
                        authority: 'present_user', signal: controller.signal });
                    if (controller.signal.aborted) return;
                    const result = MemorySearchResultV1Schema.parse(outcome.ok ? outcome.result : { v: 1, ...outcome });
                    if (!result.ok) {
                        if (result.errorCode === 'memory_project_scope_unsupported') {
                            setResults(previous => ({ contextKey, serverId: targetServerId, machineId,
                                query: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.query : normalized,
                                status: 'ready', documentsCoverage: { state: 'unavailable' },
                                failure: { error: result, target: { serverId: targetServerId, machineId } },
                                documents: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.documents : [],
                                sessions: previous?.contextKey === contextKey && previous.machineId === machineId ? previous.sessions : [] }));
                            return;
                        }
                        const failure = { error: result, target: { serverId: targetServerId, machineId } };
                        setResults(previous => previous?.contextKey === contextKey && previous.machineId === machineId ? { ...previous, status: 'failed', failure } : {
                            contextKey, serverId: targetServerId, machineId, query: normalized, status: 'failed', failure, documentsCoverage: null, documents: [], sessions: [],
                        });
                        return;
                    }
                    setResults({
                        contextKey,
                        serverId: targetServerId,
                        machineId,
                        query: normalized,
                        status: 'ready',
                        failure: null,
                        documentsCoverage: result.project && result.project.state !== 'ready'
                            ? result.project : result.documents ?? { state: 'unavailable' },
                        documents: result.hits.filter(isMemoryDocumentSearchHitV1),
                        sessions: result.hits.filter(isMemorySessionSearchHitV1),
                    });
                } catch {
                    if (!controller.signal.aborted) setResults(previous => previous?.contextKey === contextKey && previous.machineId === machineId ? { ...previous, status: 'failed', failure: null } : {
                        contextKey, serverId: targetServerId, machineId, query: normalized, status: 'failed', failure: null, documentsCoverage: null, documents: [], sessions: [],
                    });
                }
            })();
        }, SEARCH_SETTLE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [accountId, attempt, machineId, normalized, targetServerId, stableScope, contextKey]);

    return { query, setQuery, retry, results, target, selectedTarget: provider.selectedDaemonTarget ?? null,
        machineChoiceNeeded: provider.machineChoiceNeeded === true, normalized };
}

export const MemorySearchPanel = React.memo(function MemorySearchPanel(props: Readonly<{
    testID: string;
    serverId: string;
    scope?: MemorySearchScope;
    /** The Project's name when `scope` is a Project: a search that finds nothing there says where it looked. */
    scopeName?: string;
    /** Opened on demand the field takes focus; a field that always heads a list waits to be chosen. */
    autoFocus?: boolean;
    placeholder?: string;
    /**
     * What the panel shows until a query is typed (a memory page's own facts). Without it the panel is
     * search only; with it the field heads that content and results take its place while searching.
     */
    idle?: React.ReactNode;
    /** `page`: the field heads a page's list, on the page column's edge. */
    placement?: 'pane' | 'page';
}>) {
    const styles = stylesheet;
    const { serverId, testID } = props;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    // Searching wider than the Project is the person's explicit choice, never a silent fallback.
    const [widened, setWidened] = React.useState(false);
    const projectScoped = props.scope?.type === 'project';
    const { query, setQuery, retry, results, target, selectedTarget, machineChoiceNeeded, normalized } = useMemorySearchPanelModel({
        serverId, scope: widened ? GLOBAL_SCOPE : props.scope,
    });
    const isSessionVisible = useSessionRecordingVisibility();
    const sessionHits = React.useMemo(() => results?.sessions.filter(hit => isSessionVisible({ sessionId: hit.sessionId, serverId })) ?? [],
        [results?.sessions, isSessionVisible, serverId]);
    const unsupported = results?.failure?.error.errorCode === 'memory_project_scope_unsupported' ? results.failure.target : null;
    const openDocument = React.useCallback((hit: MemoryDocumentSearchHitV1) => {
        router.push(memoryDocumentSearchHitHref(hit) as never);
    }, [router]);
    const openSession = React.useCallback((hit: MemorySearchHitV1) => {
        fireAndForget(navigateToSession(hit.sessionId, { serverId, query: { jumpSeq: hit.seqFrom } }), { tag: 'MemorySearchPanel.session' });
    }, [navigateToSession, serverId]);

    const count = (results?.documents.length ?? 0) + sessionHits.length;
    const searching = normalized.length > 0;
    // A Home that is offline is the page's one line to say; until something is typed the Machine is not blamed for it.
    const homeOffline = useMemoryOffline(serverId).offline && !searching;
    return (
        <View testID={testID}>
            <View style={props.placement === 'page' ? undefined : styles.field}>
                <CompactSearchField
                    placement={props.placement === 'page' ? 'page' : undefined}
                    testID={`${testID}.input`}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={props.placeholder ?? t('memoryContext.memory.searchPlaceholder')}
                    accessibilityLabel={t('memoryContext.memory.search')}
                    editable={target !== null}
                    autoFocus={props.autoFocus ?? true}
                    // With nothing found and remembered facts unsearchable, the notice below speaks alone (no "0 results").
                    trailing={results && results.status !== 'failed' && searching
                        && (count > 0 || results.status === 'searching' || results.documentsCoverage?.state === 'ready'
                            || results.documentsCoverage?.state === 'pending') ? (
                        <Text style={styles.count}>{results.status === 'searching'
                            ? t('universalSearch.searchingGroup')
                            : t('memoryContext.memory.resultCount', { count })}</Text>
                    ) : undefined}
                />
            </View>
            {target === null && machineChoiceNeeded ? (
                <MemoryMachineChoice testID={`${testID}.machine`} invitation={t('memoryContext.memory.searchNeedMachine')} />
            ) : target === null && !homeOffline ? (
                <SearchUnavailableNotice testID={`${testID}.unavailable`} serverId={selectedTarget?.serverId ?? null} machineId={selectedTarget?.machineId ?? null}
                    onTurnOn={() => router.push(SETTINGS_ROUTES.search as never)} />
            ) : null}
            {props.idle !== undefined && !searching ? props.idle : <>
            {target === null ? null : results?.status === 'failed' ? (
                <SearchFailedNotice testID={testID} serverId={results.serverId} machineId={results.machineId} cause={results.failure?.error.errorCode ?? null}
                    onRetry={retry} onTurnOn={() => router.push(SETTINGS_ROUTES.search as never)} />
            ) : unsupported ? (
                <ProjectScopeUnsupportedNotice testID={`${testID}.projectUnsupported`} serverId={unsupported.serverId} machineId={unsupported.machineId}
                    onSearchEverything={() => setWidened(true)} />
            ) : projectScoped && widened ? (
                <SearchNotice testID={`${testID}.widened`} kind="warning" title={t('memoryContext.memory.searchingEverything')}
                    action={{ label: t('memoryContext.memory.searchOnlyProject'), onPress: () => setWidened(false) }} />
            ) : null}
            {!unsupported && results?.documentsCoverage && results.documentsCoverage.state !== 'ready' ? (
                <DocumentsCoverageNotice testID={`${testID}.documentsCoverage`} pending={results.documentsCoverage.state === 'pending'}
                    serverId={results.serverId} machineId={results.machineId} />
            ) : null}
            {results && results.documents.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('memoryContext.memory.remembered')} count={results.documents.length} first />
                    {results.documents.map((hit, index) => {
                        const where = typeof hit.location === 'object' ? memoryTopicLabel(hit.location.title)
                            : hit.location === 'archive' ? t('memoryContext.memory.archive') : null;
                        return (
                            <Item
                                key={`${hit.ref.artifactId}:${hit.factId ?? index}`}
                                testID={`${testID}.remembered.${index}`}
                                // The words that matched are marked in the fact (the Find surfaces' own marks).
                                title={(
                                    <Text numberOfLines={2} style={[styles.hitTitle, hit.location === 'archive' ? styles.retired : null]}>
                                        <FindHighlightedText text={hit.summary} ranges={queryRanges(hit.summary, results.query)} />
                                    </Text>
                                )}
                                accessibilityLabel={hit.summary}
                                subtitle={where ?? undefined}
                                showChevron={false}
                                onPress={() => openDocument(hit)}
                            />
                        );
                    })}
                </>
            ) : null}
            {results && sessionHits.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('memoryContext.memory.pastSessions')} count={sessionHits.length} first={results.documents.length === 0} />
                    {sessionHits.map((hit, index) => (
                        <SessionHitRow
                            key={`${hit.sessionId}:${hit.seqFrom}`}
                            testID={`${testID}.session.${index}`}
                            hit={hit}
                            query={results.query}
                            serverId={serverId}
                            onOpen={openSession}
                        />
                    ))}
                </>
            ) : null}
            {results?.status === 'ready' && results.documentsCoverage?.state === 'ready' && count === 0 ? (
                // A Project search that found nothing says it searched only that Project; widening is the person's choice.
                projectScoped && !widened && props.scopeName ? (
                    <SearchNotice testID={`${testID}.empty`} kind="empty"
                        title={t('memoryContext.memory.noResultsInProject', { query: results.query, project: props.scopeName })}
                        action={{ label: t('memoryContext.memory.searchEverything'), onPress: () => setWidened(true) }} />
                ) : (
                    <Text testID={`${testID}.empty`} style={styles.hint}>{t('memoryContext.memory.noResults', { query: results.query })}</Text>
                )
            ) : null}
            </>}
        </View>
    );
});

/** One quiet state line inside the section's gutters: what is wrong, and Retry when asking again can help. */
function SearchNotice(props: Readonly<{
    testID: string; kind: 'loading' | 'warning' | 'error' | 'empty' | 'unavailable'; title: string; onRetry?: () => void;
    iconName?: IconName;
    action?: Readonly<{ label: string; onPress: () => void }>;
}>) {
    const styles = stylesheet;
    return (
        <View style={styles.notice}>
            <SurfaceStateCard
                testID={props.testID}
                size="line"
                kind={props.kind}
                iconName={props.iconName}
                title={props.title}
                action={props.action ?? (props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined)}
            />
        </View>
    );
}

/**
 * Search cannot run: name the Machine the person chose when there is one (it is away or has memory
 * search off), otherwise say what a search needs; either way lead to the setting that provides it.
 */
function SearchUnavailableNotice(props: Readonly<{
    testID: string; serverId: string | null; machineId: string | null; onTurnOn: () => void;
}>) {
    const machine = useServerScopedMachine(props.serverId, props.machineId);
    // A Machine that cannot answer is said quietly beside its name (lab L9 partial search); only a search with no Machine at all needs the person.
    return <SearchNotice testID={props.testID}
        kind={props.machineId === null ? 'warning' : 'unavailable'} iconName={props.machineId === null ? undefined : 'laptop'}
        title={props.machineId === null
            ? t('memoryContext.memory.searchUnavailable')
            : t('memoryContext.memory.searchUnavailableOn', { machine: getMachineSentenceName(machine) })}
        action={{ label: t('memoryContext.memory.turnOnSearch'), onPress: props.onTurnOn }} />;
}

/**
 * A search the selected Machine could not answer: name that Machine and the cause when the Machine
 * said it. A search turned off after selection leads to the same setting as an unavailable Machine
 * (Retry cannot repair it); a missing index and an unknown failure keep Retry.
 */
function SearchFailedNotice(props: Readonly<{
    testID: string; serverId: string; machineId: string; cause: MemorySearchErrorCode | null; onRetry: () => void; onTurnOn: () => void;
}>) {
    const machine = useServerScopedMachine(props.serverId, props.machineId);
    if (props.cause === 'memory_disabled') {
        return <SearchUnavailableNotice testID={`${props.testID}.unavailable`} serverId={props.serverId} machineId={props.machineId} onTurnOn={props.onTurnOn} />;
    }
    const indexMissing = props.cause === 'memory_index_missing';
    return <SearchNotice testID={`${props.testID}.${indexMissing ? 'indexMissing' : 'failed'}`}
        kind={indexMissing ? 'warning' : 'error'}
        title={t(indexMissing ? 'memoryContext.memory.searchIndexMissingOn' : 'memoryContext.memory.searchFailedOn',
            { machine: getMachineSentenceName(machine) })}
        onRetry={props.onRetry} />;
}

/** Remembered facts are still indexing, or the selected Machine cannot search them: say which Machine. */
function DocumentsCoverageNotice(props: Readonly<{ testID: string; pending: boolean; serverId: string; machineId: string }>) {
    const machine = useServerScopedMachine(props.serverId, props.machineId);
    return <SearchNotice testID={props.testID} kind={props.pending ? 'loading' : 'unavailable'} iconName={props.pending ? undefined : 'laptop'}
        title={props.pending
            ? `${t('memoryContext.memory.remembered')} · ${t('common.loading')}`
            : t('memoryContext.memory.documentSearchUnavailableOn', { machine: getMachineSentenceName(machine) })} />;
}

/**
 * The selected machine cannot search by Project yet: say which machine, and offer the wider search
 * as the person's own choice (lab K2 `Q`, C6 §5).
 */
function ProjectScopeUnsupportedNotice(props: Readonly<{
    testID: string; serverId: string; machineId: string; onSearchEverything: () => void;
}>) {
    const machine = useServerScopedMachine(props.serverId, props.machineId);
    const name = getMachineDisplayName(machine) ?? t('memoryContext.memory.thisMachine');
    return <SearchNotice testID={props.testID} kind="warning"
        title={t('memoryContext.memory.projectSearchUnsupported', { machine: name })}
        action={{ label: t('memoryContext.memory.searchEverything'), onPress: props.onSearchEverything }} />;
}

/**
 * A past-session hit (lab `c-mem S`): the Session's own mark, its title and the date, then one line of
 * its text with the match marked. The excerpt is plain text; indexed transcript chunks carry markdown.
 */
const SessionHitRow = React.memo(function SessionHitRow(props: Readonly<{
    testID: string;
    hit: MemorySearchHitV1;
    query: string;
    serverId: string;
    onOpen: (hit: MemorySearchHitV1) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { hit, onOpen } = props;
    const session = useSession(hit.sessionId, props.serverId);
    const identityDisplay = useSessionListIdentityDisplay();
    const name = session ? getSessionName(session, props.serverId) : null;
    const excerpt = React.useMemo(() => stripMarkdown(hit.summary), [hit.summary]);
    const excerptText = (
        <Text numberOfLines={1} style={name ? styles.hitExcerpt : styles.hitTitle}>
            <FindHighlightedText text={excerpt} ranges={queryRanges(excerpt, props.query)} />
        </Text>
    );
    return (
        <Item
            testID={props.testID}
            leftElement={session && identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={session}
                    display={identityDisplay}
                    serverId={props.serverId}
                    color={theme.colors.text.secondary}
                    avatarSize={16}
                    agentLogoSize={14}
                    connected
                />
            ) : undefined}
            icon={session && identityDisplay !== 'none' ? undefined : <Icon name="chat-circle" />}
            // A Session this client has not loaded has no name to show: its excerpt is the title.
            title={name ?? excerptText}
            accessibilityLabel={name ?? excerpt}
            subtitle={name ? excerptText : undefined}
            subtitleLines={1}
            detail={formatMemoryDate(hit.createdAtToMs)}
            showChevron={false}
            onPress={() => onOpen(hit)}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingBottom: theme.space.s6,
    },
    count: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    hitTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    hitExcerpt: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    notice: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
    },
    hint: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingTop: theme.space.s8,
    },
    retired: {
        color: theme.colors.text.tertiary,
    },
}));
