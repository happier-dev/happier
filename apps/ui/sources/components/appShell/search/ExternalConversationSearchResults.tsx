import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { useConversationSearch } from '@/sync/domains/search/useConversationSearch';
import type { ConversationSearchSource } from '@/sync/domains/search/searchConversations';
import { projectConversationSearchCandidates } from '@/components/sessions/external/browse/projectConversationSearchCandidates';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { ExternalSessionsBrowseScreen, type ExternalSessionsBrowseScopeLock } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ConversationHitSummary } from '@/components/sessions/external/browse/ConversationHitSummary';
import { ExternalSessionSearchProgress } from '@/components/sessions/external/browse/ExternalSessionSearchProgress';
import { openExternalSessionCandidate, type ExternalSessionCandidateFindSeed, type ExternalSessionCandidateOpenState } from '@/components/sessions/external/browse/openExternalSessionCandidate';
import { readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import { resolveExternalSessionBrowseCandidateIdentityPresentation } from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { describeConversationSearchCoverage } from './conversationSearchCoverage';
import { readExternalSessionExchange } from '@/components/sessions/external/browse/readExternalSessionExchange';
import { projectTranscriptFindText } from '@/components/sessions/transcript/find/transcriptFindText';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';

export type ExternalConversationSearchResultsProps = Readonly<{
    target: Readonly<{ machineId: string; serverId: string; accountId: string }>;
    machineIds?: readonly string[];
    query: string;
    machineLabel: string;
    accountLifetime: ServerAccountScopeLifetime;
    onBack(): void;
    onRequestClose(): void;
    onOpenSession(sessionId: string, target: Readonly<{ machineId: string; serverId: string | null }>, find?: ExternalSessionCandidateFindSeed): void | Promise<void>;
}>;

export function ExternalConversationSearchResults(props: ExternalConversationSearchResultsProps): React.ReactElement | null {
    const [retiredLifetime, setRetiredLifetime] = React.useState<ServerAccountScopeLifetime | null>(null);
    React.useEffect(() => {
        const subscription = props.accountLifetime.onRetire(() => setRetiredLifetime(props.accountLifetime));
        return () => subscription.dispose();
    }, [props.accountLifetime]);
    if (retiredLifetime === props.accountLifetime || !props.accountLifetime.isCurrent()
        || !areServerAccountScopesEqual(props.target, props.accountLifetime.scope)) return null;
    return <ActivatedResults key={JSON.stringify([props.target, props.machineIds, props.query])} {...props} />;
}

type Source = ConversationSearchSource & Readonly<{ machineId: string; key: string; label: string; supported: boolean; capability: boolean | undefined }>;

/** The hit the preview shows: what the search already returned for it, and its two ways out. */
export type ConversationHighlight = Readonly<{
    key: string;
    candidate: ExternalSessionBrowseCandidate;
    title: string;
    meta: string;
    agentLabel?: string;
    agentId?: string;
    open: () => void;
    show: () => void;
}>;

type SelectedConversationHighlight = ConversationHighlight & Readonly<{
    exchange: Omit<Parameters<typeof readExternalSessionExchange>[0], 'signal'>;
    isCurrent(): boolean;
}>;

/** Wide enough for the list and the preview side by side (the palette card); narrower, rows open directly (lab H1rp). */
const PREVIEW_MIN_WIDTH = 720;
const PREVIEW_WIDTH = 372;

function ActivatedResults(props: ExternalConversationSearchResultsProps) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const provider = useMemorySearchProvider({ kind: 'exact', serverId: props.target.serverId, machineId: props.target.machineId },
        { conversationSearch: true, corpora: ['external_transcripts'] });
    const search = useConversationSearch({ accountLifetime: props.accountLifetime,
        query: { v: 1, query: props.query, scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
        machineIds: props.machineIds ?? [props.target.machineId], mode: 'auto',
        providers: provider.conversation ?? { homeSessions: false, daemonEnabled: false },
    });
    const machineList = useMachineListForServer(props.target.serverId);
    const machineName = React.useCallback((machineId: string) => machineId === props.target.machineId ? props.machineLabel
        : getMachineDisplayName(machineList?.find(machine => machine.id === machineId)) ?? machineId,
    [machineList, props.machineLabel, props.target.machineId]);
    // Several machines: each source says whose it is, and the header names the scope, not one machine.
    const allMachines = (props.machineIds?.length ?? 0) > 1;
    // One line for every machine that was not fully covered (the palette's line, same words).
    const coverage = search.result ? describeConversationSearchCoverage({ machines: search.result.machines, machineName }) : '';
    const noneFound = !search.loading && !search.error && !search.cancelled && search.result && !coverage
        && search.result.sources.some(source => source.contentSearch) && search.result.hits.length === 0
        && !search.result.continuations?.length
        ? allMachines ? t('conversationSearch.noneFoundAllMachines', { query: props.query })
            : t('conversationSearch.noneFound', { machine: props.machineLabel, query: props.query }) : '';
    const announcement = search.loading ? t('conversationSearch.searching')
        : search.cancelled ? t('externalSessions.browseContentStopped')
            : search.error ? t('externalSessions.browseFailedToLoad') : noneFound || coverage;
    const sources = React.useMemo((): Source[] => (search.result?.sources ?? []).map(source => ({
        ...source, key: source.key ?? JSON.stringify([source.machineId, source.sourceKey]),
        label: source.label ?? source.agentId, supported: source.contentSearch, capability: source.contentSearch,
    })), [search.result?.sources]);
    const openState = React.useRef<ExternalSessionCandidateOpenState>({ requestToken: 0, linkingCandidateKey: null });
    const [linkingKey, setLinkingKey] = React.useState<string | null>(null);
    const [browseScope, setBrowseScope] = React.useState<ExternalSessionsBrowseScopeLock | null>(null);
    const [width, setWidth] = React.useState(0);
    const [highlight, setHighlight] = React.useState<SelectedConversationHighlight | null>(null);
    const wide = width >= PREVIEW_MIN_WIDTH;
    React.useEffect(() => () => { openState.current.requestToken++; }, []);
    if (browseScope) return <ExternalSessionsBrowseScreen lockScope={browseScope} accountLifetime={props.accountLifetime} initialSearchTarget="content" initialSearchQuery={props.query} onRequestClose={props.onRequestClose} closeButton />;
    return <View testID="external-conversation-results" style={[styles.root, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <View style={styles.list}>
        <ItemList>
            <PoliteAccessibilityStatus announcement={announcement} transitionKey={`${search.loading}:${search.cancelled}:${search.result?.hits.length}`} statusTestID="external-conversation-status" />
            {search.loading ? <ExternalSessionSearchProgress label={t('conversationSearch.searching')} onStop={search.cancel} testID="external-conversation-progress" stopTestID="external-conversation-stop" /> : null}
            <ItemGroup title={allMachines ? t('conversationSearch.scanAllMachines') : t('externalSessions.browseContentOnMachine', { machine: props.machineLabel })} description={t('conversationSearch.queryDescription', { query: props.query })}
                action={<RoundButton title={t('externalSessions.browseContentBack')} size="small" display="inverted" onPress={props.onBack} />}>
                {noneFound ? <SectionContentRow><Text testID="external-conversation-none" style={styles.status}>{noneFound}</Text></SectionContentRow> : null}
                {search.cancelled ? <SectionContentRow><Text style={styles.status}>{t('externalSessions.browseContentStopped')}</Text></SectionContentRow> : null}
                {coverage ? <SectionContentRow><Text testID="external-conversation-coverage" style={styles.status}>{coverage}</Text></SectionContentRow> : null}
                {search.error ? <SectionContentRow><Text style={styles.status}>{t('externalSessions.browseFailedToLoad')}</Text><RoundButton title={t('common.retry')} size="small" display="secondary" onPress={search.reload} /></SectionContentRow> : null}
            </ItemGroup>
            {sources.map((source) => source.supported
                ? <ContentSource key={source.key} {...props} target={{ ...props.target, machineId: source.machineId }} source={source} search={search} offline={search.result?.machines.find(machine => machine.machineId === source.machineId)?.status === 'offline'} openState={openState.current} linkingKey={linkingKey} onLinkingChange={setLinkingKey} onShow={() => setBrowseScope({ ...props.target, machineId: source.machineId, providerId: source.agentId, source: source.source })}
                    machineLabel={machineName(source.machineId)} showMachine={allMachines} wide={wide}
                    highlightedKey={wide ? highlight?.key ?? null : null} wantsFirstHighlight={wide && highlight === null} onHighlight={setHighlight} />
                : <ItemGroup key={source.key} title={source.label} description={source.detail}><SectionContentRow><Text testID={`external-conversation-unsupported:${source.key}`} style={styles.status}>{source.capability === false ? t('externalSessions.browseContentNotSearchable') : t('externalSessions.browseContentUpdateRequired', { machine: props.machineLabel })}</Text></SectionContentRow></ItemGroup>)}
        </ItemList>
        </View>
        {wide ? <SelectedConversationPreview highlight={highlight} query={props.query} disabled={linkingKey !== null} /> : null}
    </View>;
}

/** H1r: only the wide selected preview reads the matching exchange. */
function SelectedConversationPreview(props: Readonly<{ highlight: SelectedConversationHighlight | null; query: string; disabled: boolean }>) {
    const { highlight } = props;
    const selectionCurrent = highlight?.isCurrent() === true;
    const [exchange, setExchange] = React.useState<Readonly<{
        key: string; messages: Awaited<ReturnType<typeof readExternalSessionExchange>>; failed: boolean;
    }> | null>(null);
    const [revision, retry] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!highlight || !selectionCurrent) return;
        const controller = new AbortController();
        const lifetime = highlight.exchange.accountLifetime;
        const retirement = lifetime.onRetire(() => { controller.abort(); setExchange(null); });
        const current = () => !controller.signal.aborted && lifetime.isCurrent() && highlight.isCurrent();
        setExchange(null);
        void readExternalSessionExchange({ ...highlight.exchange, signal: controller.signal })
            .then(messages => { if (current()) setExchange({ key: highlight.key, messages, failed: messages.length === 0 }); })
            .catch(() => { if (current()) setExchange({ key: highlight.key, messages: [], failed: true }); });
        return () => { controller.abort(); retirement.dispose(); };
    }, [highlight, selectionCurrent, revision]);
    const selectedExchange = selectionCurrent && exchange?.key === highlight?.key ? exchange : null;
    return <ConversationPreview {...props} highlight={selectionCurrent ? highlight : null} exchange={selectedExchange} onRetry={retry} disabled={props.disabled || !selectionCurrent} />;
}

/** Pure preview presentation, also used by the design specimen. */
export function ConversationPreview(props: Readonly<{
    highlight: ConversationHighlight | null; query: string; disabled: boolean;
    exchange?: Readonly<{ messages: Awaited<ReturnType<typeof readExternalSessionExchange>>; failed: boolean }> | null;
    onRetry?: () => void;
}>) {
    const { highlight, exchange: selectedExchange } = props;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    return <View testID="external-conversation-preview" style={styles.preview}>
        {highlight ? <>
            <View style={styles.previewHeading}>{highlight.agentId ? <AgentIcon agentId={highlight.agentId} size={ICON_SIZE.md} /> : null}<Text style={styles.previewTitle} numberOfLines={2}>{highlight.title}</Text></View>
            {highlight.meta ? <Text style={styles.meta} numberOfLines={1}>{highlight.meta}</Text> : null}
            <ScrollView style={styles.previewGrow} contentContainerStyle={styles.previewMessages}>
                {!selectedExchange ? <ActivitySpinner size={ICON_SIZE.sm} /> : selectedExchange.failed
                    ? <><Text style={styles.meta}>{t('externalSessions.browseFailedToLoad')}</Text>{props.onRetry ? <RoundButton title={t('common.retry')} size="small" display="secondary" onPress={props.onRetry} /> : null}</>
                    : selectedExchange.messages.map(message => <View key={message.id}>
                        <Text style={styles.meta}>{message.kind === 'user-text' ? t('voiceActivity.format.you') : highlight.agentLabel ?? t('voiceActivity.format.assistant')}</Text>
                        <View style={[styles.previewMessage, { backgroundColor: materialColor(message.kind === 'user-text' ? theme.colors.state.active.background : theme.colors.surface.inset) }]}>
                            {projectTranscriptFindText(message).map(block => {
                                return <Text key={block.id} style={styles.previewText} testID={`external-conversation-preview-message:${message.realID ?? message.id}`}>
                                    <FindHighlightedText text={block.text} ranges={queryRanges(block.text, props.query, message.realID === highlight.candidate.match?.sourceItemId || message.id === highlight.candidate.match?.sourceItemId)} />
                                </Text>;
                            })}
                        </View>
                    </View>)}
            </ScrollView>
            <View style={styles.previewActions}>
                <RoundButton testID="external-conversation-preview-open" title={t('externalSessions.browseContentOpen')} size="small"
                    disabled={props.disabled} onPress={highlight.open} />
                <RoundButton title={t('externalSessions.browseContentShow')} size="small" display="secondary" onPress={highlight.show} />
            </View>
            <Text style={styles.meta}>{t('externalSessions.browseContentPreviewOpens', { query: props.query.trim() })}</Text>
        </> : <Text style={[styles.meta, styles.previewEmpty]}>{t('externalSessions.browseContentPreviewEmpty')}</Text>}
    </View>;
}

function ContentSource(props: ExternalConversationSearchResultsProps & Readonly<{
    search: ReturnType<typeof useConversationSearch>;
    source: Source; offline: boolean;
    /** With several machines in scope, each source's header says whose conversations these are. */
    showMachine: boolean; wide: boolean; openState: ExternalSessionCandidateOpenState; linkingKey: string | null;
    onLinkingChange(key: string | null): void; onShow(): void;
    /** Wide layouts preview one hit: which one, whether none is chosen yet, and how a row claims it. */
    highlightedKey: string | null; wantsFirstHighlight: boolean; onHighlight(highlight: SelectedConversationHighlight): void;
}>) {
    const { source } = props;
    const continuation = props.search.result?.continuations?.find(value => value.machineId === source.machineId
        && (value.sourceKey === undefined || value.sourceKey === source.sourceKey));
    // Rows the index answered, as opposed to ones this scan read from the Agent's files.
    const results = {
        candidates: projectConversationSearchCandidates(props.search.result?.hits ?? [], source),
        candidatesAuthoritative: props.accountLifetime.isCurrent() && props.search.result !== null && !props.search.loading,
        publishedSearchTerm: props.query, loading: props.search.loading, loadingMore: false, preparation: null,
        cancelled: props.search.cancelled === true, preparationStopped: false, error: props.search.error ? t('externalSessions.browseFailedToLoad') : null,
        contentCoverage: props.search.result?.machines.find(machine => machine.machineId === source.machineId)?.status === 'partial' ? 'partial' : 'complete',
        nextCursor: continuation?.cursor, cancelPreparation: props.search.cancel, reload: props.search.reload,
        loadMore: () => continuation && props.search.loadMore(continuation),
    };
    const current = React.useRef(true);
    React.useEffect(() => {
        current.current = true;
        return () => { current.current = false; };
    }, []);
    const selectionCurrent = () => current.current && props.accountLifetime.isCurrent()
        && results.candidatesAuthoritative && results.publishedSearchTerm === props.query;
    // Existing rows remain valid preview custody while another search page is loading.
    const previewCurrent = () => current.current && props.accountLifetime.isCurrent() && results.publishedSearchTerm === props.query;
    const latestSelection = React.useRef({ current: previewCurrent, candidates: results.candidates });
    latestSelection.current = { current: previewCurrent, candidates: results.candidates };
    const openCandidate = (candidate: ExternalSessionBrowseCandidate) => {
        const match = candidate.match;
        if (!match) return;
        void openExternalSessionCandidate({
            candidate, agentId: source.agentId, source: source.source, actionsAllowed: selectionCurrent(), offline: props.offline,
            isSelectionCurrent: selectionCurrent, accountCurrentness: props.accountLifetime,
            resolveCurrentTarget: () => selectionCurrent() ? props.target : null,
            state: props.openState, onLinkingChange: props.onLinkingChange,
            find: { query: props.query, sourceItemId: match.sourceItemId },
            openSession: async (sessionId, target, find) => { props.onRequestClose(); await props.onOpenSession(sessionId, target, find); },
        });
    };
    // The preview opens through the latest render's guards, never a closure from when it was highlighted.
    const openRef = React.useRef(openCandidate);
    openRef.current = openCandidate;
    const describe = (candidate: ExternalSessionBrowseCandidate): SelectedConversationHighlight => {
        const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
            path: readExternalSessionBrowseCandidatePath(candidate.details), agentLabel: source.label, machineLabel: props.machineLabel, thread: candidate.thread });
        const relativeTime = candidate.updatedAtMs > 0 ? formatShortRelativeTime(candidate.updatedAtMs) : '';
        return { key: readExternalSessionBrowseCandidateKey(candidate), candidate, title: identity.title,
            meta: [identity.secondaryLabel, relativeTime].filter(Boolean).join(' · '),
            open: () => openRef.current(candidate), show: props.onShow, agentLabel: source.label, agentId: source.agentId,
            isCurrent: () => latestSelection.current.current() && latestSelection.current.candidates.some(row => readExternalSessionBrowseCandidateKey(row) === readExternalSessionBrowseCandidateKey(candidate)
                && row.match?.sourceItemId === candidate.match?.sourceItemId),
            exchange: { request: { machineId: props.target.machineId, agentId: source.agentId, source: source.source, remoteSessionId: candidate.remoteSessionId },
                accountLifetime: props.accountLifetime, sourceItemId: candidate.match!.sourceItemId } };
    };
    const firstMatched = results.candidates.find((candidate) => candidate.match);
    const { wantsFirstHighlight, onHighlight } = props;
    React.useEffect(() => {
        if (wantsFirstHighlight && firstMatched) onHighlight(describe(firstMatched));
        // `describe` reads this render's labels; the first matched hit is what changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantsFirstHighlight, firstMatched, onHighlight]);
    const busy = results.loading || results.loadingMore || Boolean(results.preparation);
    const mixed = results.candidates.some(candidate => candidate.searchMode === 'indexed')
        && results.candidates.some(candidate => candidate.searchMode === 'standard');
    return <ItemGroup title={source.label} description={[props.showMachine ? props.machineLabel : null, source.detail,
        mixed ? t('conversationSearch.mixedResults') : null].filter(Boolean).join(' · ') || undefined}
        action={props.wide ? undefined : <RoundButton title={t('externalSessions.browseContentShow')} size="small" display="inverted" titleNumberOfLines="complete" onPress={props.onShow} />}>
        {results.candidates.map((candidate) => {
            const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
                path: readExternalSessionBrowseCandidatePath(candidate.details), agentLabel: source.label, machineLabel: props.machineLabel, thread: candidate.thread });
            const key = readExternalSessionBrowseCandidateKey(candidate);
            const match = candidate.match;
            const linking = props.linkingKey === key;
            const open = match ? () => openCandidate(candidate) : undefined;
            const highlightThis = match && props.highlightedKey !== null ? () => props.onHighlight(describe(candidate)) : undefined;
            return <Item key={key}
                testID={match ? `external-conversation-open:${candidate.remoteSessionId}` : undefined}
                title={identity.title}
                icon={<AgentIcon agentId={source.agentId} size={ICON_SIZE.md} />}
                accessibilityLabel={match ? `${t('externalSessions.browseContentOpen')}: ${identity.title}` : identity.title}
                showChevron={false}
                onPress={open}
                onHoverIn={highlightThis}
                onFocus={highlightThis}
                selected={props.highlightedKey === key}
                disabled={!match || !selectionCurrent() || props.linkingKey !== null || (props.offline && !candidate.linkedSessionId)}
                rightElement={linking ? <ActivitySpinner size={ICON_SIZE.sm} />
                    : candidate.linkedSessionId ? <StatusPill variant="neutral" label={t('externalSessions.browseLinked')} hideDot labelVariant="phrase" /> : undefined}
                bottomElement={<ConversationHitSummary snippet={candidate.match?.snippet ?? t('externalSessions.browseContentNotSearchable')}
                    query={props.query} where={identity.secondaryLabel} atMs={candidate.updatedAtMs} testID={`external-session-candidate-match:${candidate.remoteSessionId}`} />} />;
        })}
        {results.nextCursor && !busy && !results.cancelled ? <SectionContentRow><RoundButton testID={`external-conversation-more:${source.key}`} title={t('externalSessions.browseContentMore')} size="small" display="secondary" disabled={props.offline} onPress={results.loadMore} /></SectionContentRow> : null}
    </ItemGroup>;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, flexDirection: 'row', backgroundColor: theme.colors.surface.base },
    list: { flex: 1, minWidth: 0, minHeight: 0 },
    // The preview column (lab H1r `.fd-preview`): title, where it lives, the matched message, then the
    // two ways out and what opening does.
    preview: { width: PREVIEW_WIDTH, flexShrink: 0, minHeight: 0, gap: 8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 16,
        borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
    previewHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    previewTitle: { ...Typography.rowTitle(), flex: 1, color: theme.colors.text.primary },
    previewMessage: { marginTop: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.surface.inset },
    previewGrow: { flex: 1, minHeight: 12 },
    // One rhythm down the exchange (lab `.fd-preview`: 8 between who and what, 13/19 message text).
    previewMessages: { gap: 12, paddingBottom: 4 },
    previewText: { ...Typography.rowMeta(), color: theme.colors.text.primary },
    previewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    previewEmpty: { marginTop: 'auto', marginBottom: 'auto', textAlign: 'center' },
    meta: { ...Typography.rowMeta(), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    // Coverage and progress are context, not content: one quiet line.
    status: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
}));
