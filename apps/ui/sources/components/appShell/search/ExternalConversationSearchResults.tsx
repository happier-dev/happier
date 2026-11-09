import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBodyEdgeContext, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { useConversationSearch } from '@/sync/domains/search/useConversationSearch';
import type { ConversationSearchResult, ConversationSearchSource } from '@/sync/domains/search/searchConversations';
import { resolveExternalSessionBrowseRpcErrorMessage } from '@/components/sessions/external/browse/externalSessionBrowseErrorPresentation';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { ExternalSessionsBrowseScreen, type ExternalSessionsBrowseScopeLock } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ConversationHitStatus, ConversationHitSummary, isConversationHitStatusInMeta, resolveConversationHitSnippet, resolveConversationHitStatusLabel } from '@/components/sessions/external/browse/ConversationHitSummary';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { excerptAroundFirstMatch } from './conversationPreviewExcerpt';
import { ExternalSessionSearchProgress } from '@/components/sessions/external/browse/ExternalSessionSearchProgress';
import { cancelExternalSessionCandidateOpen, openExternalSessionCandidate, type ExternalSessionCandidateFindSeed, type ExternalSessionCandidateOpenState } from '@/components/sessions/external/browse/openExternalSessionCandidate';
import { readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import { resolveExternalSessionBrowseCandidateIdentityPresentation } from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { SelectionListSearchHeader } from '@/components/ui/selectionList/SelectionListSearchHeader';
import { SelectionListSectionHeader } from '@/components/ui/selectionList/SelectionListSectionHeader';
import { SelectionListFooter } from '@/components/ui/selectionList/SelectionListFooter';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { describeConversationSearchCoverage } from './conversationSearchCoverage';
import { conversationSourceHasGroup, orderConversationSourceGroups, readConversationSourceGroup } from './conversationSourceGroup';
import { COMMAND_SURFACE_DETAIL_PANE } from '@/modal/components/card/commandSurfaceCard';
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
    /** The Agent that holds the conversation; its catalog name labels its turns in the preview. */
    agentId?: string;
    open: () => void;
    show: () => void;
}>;

type SelectedConversationHighlight = ConversationHighlight & Readonly<{
    exchange: Omit<Parameters<typeof readExternalSessionExchange>[0], 'signal'>;
    isCurrent(): boolean;
}>;

/** Wide enough for the list and the preview side by side (the palette card); narrower, rows open directly (lab H1rp). */
const PREVIEW_MIN_WIDTH = COMMAND_SURFACE_DETAIL_PANE.minListWidthPx;
const PREVIEW_WIDTH = COMMAND_SURFACE_DETAIL_PANE.widthPx;
/** The prompt that opens a preview shows its first lines; the matched message is the thing being read. */
const PREVIEW_PROMPT_LINES = 3;

function ActivatedResults(props: ExternalConversationSearchResultsProps) {
    const presentationActive = useLayoutPresentationActive();
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const hardwareKeyboard = useHardwareKeyboard();
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
    const failures = search.result?.failures ?? [];
    const coverage = search.result ? describeConversationSearchCoverage({ machines: search.result.machines.filter(machine =>
        !failures.some(failure => failure.machineId === machine.machineId)), machineName }) : '';
    const noneFound = !search.loading && !search.error && !search.cancelled && search.result && !coverage
        && search.result.sources?.some(source => source.contentSearch) && search.result.hits.length === 0
        && !search.result.continuations?.length && failures.length === 0
        ? allMachines ? t('conversationSearch.noneFoundAllMachines', { query: props.query })
            : t('conversationSearch.noneFound', { machine: props.machineLabel, query: props.query }) : '';
    const announcement = search.loading ? t('conversationSearch.searching')
        : search.cancelled ? t('externalSessions.browseContentStopped')
            : search.error ? t('externalSessions.browseFailedToLoad') : failures.length
                ? describeConversationSearchCoverage({ machines: [], failures, machineName }) : noneFound || coverage;
    const sources = React.useMemo((): Source[] => (search.result?.sources ?? []).map(source => ({
        ...source, key: source.key ?? JSON.stringify([source.machineId, source.sourceKey]),
        label: source.label ?? source.agentId, supported: source.contentSearch, capability: source.contentSearch,
    })), [search.result?.sources]);
    const openState = React.useRef<ExternalSessionCandidateOpenState>({ requestToken: 0, linkingCandidateKey: null });
    const [linkingKey, setLinkingKey] = React.useState<string | null>(null);
    const [browseScope, setBrowseScope] = React.useState<ExternalSessionsBrowseScopeLock | null>(null);
    const [width, setWidth] = React.useState(0);
    const [highlight, setHighlight] = React.useState<SelectedConversationHighlight | null>(null);
    const [askedAtRows, setAskedAtRows] = React.useState<ReadonlyMap<string, number>>(new Map());
    const wide = width >= PREVIEW_MIN_WIDTH;
    const listRef = React.useRef<VirtualizedListRef>(null);
    const current = React.useRef(true);
    React.useEffect(() => {
        current.current = true;
        return () => { current.current = false; };
    }, []);
    const sourceModelsRef = React.useRef<readonly ContentSourceModel[]>([]);
    const listRowsRef = React.useRef<readonly ConversationResultRow[]>([]);
    const showingResults = React.useRef(true);
    showingResults.current = browseScope === null;
    React.useEffect(() => {
        setLinkingKey(null);
        return () => { cancelExternalSessionCandidateOpen(openState.current); };
    }, [presentationActive, props.query, props.accountLifetime, props.target.machineId, props.target.serverId]);
    // ↑↓ move the highlight over every source's hits in drawn order and ↵ opens it (the footer's promise).
    const highlightRef = React.useRef(highlight);
    highlightRef.current = highlight;
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (!showingResults.current) return;
            if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
            // A focused control (a row, a link, a button, an editable field) keeps its own keys; the sheet's
            // read-only query field is display, not an editor.
            if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('button, a, textarea, input:not([readonly]), [role="button"], [role="link"]')) return;
            const rows = listRowsRef.current.flatMap((row, listIndex) => row.kind === 'candidate' && row.candidate.match ? [{ row, listIndex }] : []);
            const index = rows.findIndex(({ row }) => readExternalSessionBrowseCandidateKey(row.candidate) === highlightRef.current?.key);
            if (event.key === 'Enter') {
                const target = rows[index];
                if (!target) return;
                event.preventDefault();
                target.row.source.openCandidate(target.row.candidate);
                return;
            }
            if (rows.length === 0) return;
            event.preventDefault();
            const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
            if (next) {
                setHighlight(next.row.source.describe(next.row.candidate));
                void listRef.current?.scrollToIndex({ index: next.listIndex, animated: false });
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);
    const hitCount = search.result?.hits.length ?? 0;
    // Groups with rows come first; a source with only a next page closes the list as one line naming its source.
    const orderedSources = orderConversationSourceGroups(search.result, sources, props.query);
    // With several groups on screen each one names its source, so their link rows do not read as repeated controls.
    const namesSources = sources.filter(source => source.supported && conversationSourceHasGroup(search.result, source, props.query)).length > 1;
    const sourceModels = orderedSources.filter(source => source.supported).map(source => buildContentSourceModel({
        ...props, target: { ...props.target, machineId: source.machineId }, source, search,
        offline: search.result?.machines.find(machine => machine.machineId === source.machineId)?.status === 'offline',
        openState: openState.current, linkingKey, onLinkingChange: setLinkingKey,
        onShow: () => setBrowseScope({ ...props.target, machineId: source.machineId, providerId: source.agentId, source: source.source }),
        machineLabel: machineName(source.machineId), namesSource: namesSources,
        homeDir: machineList?.find(machine => machine.id === source.machineId)?.metadata?.homeDir ?? null,
        showMachine: allMachines, wide, statusInMeta: isConversationHitStatusInMeta(width),
        highlightedKey: highlight?.key ?? null, onHighlight: setHighlight,
        isCurrent: () => current.current && showingResults.current && props.accountLifetime.isCurrent()
            && sourceModelsRef.current.some(model => model.props.source.key === source.key),
        openCurrent: candidate => sourceModelsRef.current.find(model => model.props.source.key === source.key)?.openCandidate(candidate),
        candidateCurrent: candidate => sourceModelsRef.current.find(model => model.props.source.key === source.key)?.results.candidates.some(row =>
            readExternalSessionBrowseCandidateKey(row) === readExternalSessionBrowseCandidateKey(candidate)
            && row.match?.sourceItemId === candidate.match?.sourceItemId) === true,
        askedAtRows: askedAtRows.get(source.key),
        onAsk: count => setAskedAtRows(previous => new Map(previous).set(source.key, count)),
    }));
    sourceModelsRef.current = sourceModels;
    const listRows: ConversationResultRow[] = orderedSources.flatMap<ConversationResultRow>(source => {
        if (!source.supported) return [{ kind: 'unsupported', key: source.key, source }];
        const model = sourceModels.find(model => model.props.source.key === source.key)!;
        return [
            ...model.results.candidates.map(candidate => ({ kind: 'candidate' as const, key: JSON.stringify([source.key, readExternalSessionBrowseCandidateKey(candidate)]), candidate, source: model })),
            ...(model.results.candidates.length > 0 || model.results.nextCursor ? [{ kind: 'source-footer' as const, key: `${source.key}:footer`, source: model }] : []),
        ];
    });
    listRowsRef.current = listRows;
    const firstMatchedRow = listRows.find((row): row is Extract<ConversationResultRow, { kind: 'candidate' }> => row.kind === 'candidate' && Boolean(row.candidate.match));
    React.useEffect(() => {
        if (wide && highlight === null && firstMatchedRow) setHighlight(firstMatchedRow.source.describe(firstMatchedRow.candidate));
    }, [wide, highlight, firstMatchedRow]);
    if (browseScope) return <ExternalSessionsBrowseScreen lockScope={browseScope} accountLifetime={props.accountLifetime} initialSearchTarget="content" initialSearchQuery={props.query} onRequestClose={props.onRequestClose} closeButton />;
    // Lab H1r: the palette keeps its band (the query, and the way back to Search), one group named for where
    // the scan ran, the hits as palette rows, and the preview beside them when the card is wide enough.
    return <View testID="external-conversation-results" style={[styles.root, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <SelectionListSearchHeader testID="external-conversation-band" value={props.query.trim()} onChangeText={() => {}} placeholder=""
            inputReadOnly inputAccessibilityLabel={t('conversationSearch.queryDescription', { query: props.query.trim() })}
            canPop backLabel={t('tools.names.search')} onPopStep={props.onBack} />
        <PoliteAccessibilityStatus announcement={announcement} transitionKey={`${search.loading}:${search.cancelled}:${search.result?.hits.length}`} statusTestID="external-conversation-status" />
        {search.loading ? <ExternalSessionSearchProgress label={t('conversationSearch.searching')} onStop={search.cancel} testID="external-conversation-progress" stopTestID="external-conversation-stop" /> : null}
        <View style={styles.body}>
            <VirtualizedList ref={listRef} testID="external-conversation-list" style={styles.list} contentContainerStyle={styles.listContent}
                data={listRows} keyExtractor={row => row.key} getItemType={row => row.kind} keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => item.kind === 'candidate' ? <ConversationResultCandidate candidate={item.candidate} source={item.source} />
                    : item.kind === 'source-footer' ? <ContentSourceFooter source={item.source} />
                        : <Text testID={`external-conversation-unsupported:${item.source.key}`} style={styles.status}>{[item.source.label, item.source.capability === false ? t('externalSessions.browseContentNotSearchable') : t('externalSessions.browseContentUpdateRequired', { machine: props.machineLabel })].join(' · ')}</Text>}
                ListHeaderComponent={<>
                <SelectionListSectionHeader title={allMachines ? t('conversationSearch.scopeAllMachinesSubtitle') : t('externalSessions.browseContentOnMachine', { machine: props.machineLabel })}
                    count={hitCount > 0 ? hitCount : undefined} />
                {noneFound ? <Text testID="external-conversation-none" style={styles.status}>{noneFound}</Text> : null}
                {search.cancelled ? <Text style={styles.status}>{t('externalSessions.browseContentStopped')}</Text> : null}
                {search.error ? <View style={styles.statusRow}><Text style={styles.statusInline}>{t('externalSessions.browseFailedToLoad')}</Text><TextLinkButton size="meta" tone="strong" label={t('common.retry')} onPress={search.reload} /></View> : null}
                </>}
                ListFooterComponent={<>
                {/* How much was covered closes the list (lab H1r "Searched 3,102 conversations"): hits first. */}
                {coverage ? <Text testID="external-conversation-coverage" style={styles.status}>{coverage}</Text> : null}
                {failures.length > 0 ? <CoverageFailures failures={failures} sources={sources} machineName={machineName} showMachine={allMachines} defaultExpanded={hitCount === 0}
                    disabled={search.loading} onRetry={failure => { void search.loadMore(failure); }} /> : null}
                </>} />
            {/* The preview column opens with the first hit; an empty half-card would only say nothing is there yet. */}
            {wide && hitCount > 0 ? <SelectedConversationPreview highlight={highlight} query={props.query} disabled={linkingKey !== null} /> : null}
        </View>
        {/* The same quiet key hints as Search / ⌘K (a hardware keyboard only). */}
        <SelectionListFooter testID="external-conversation-footer" hardwareKeyboardAvailable={hardwareKeyboard} hints={[
            { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
            { id: 'open', label: '↵', description: t('commandPalette.hints.open') },
            { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
        ]} />
    </View>;
}

/** Sources that could not be searched: one quiet summary, each source named beneath it with its own Retry. */
function CoverageFailures(props: Readonly<{
    failures: NonNullable<ConversationSearchResult['failures']>; sources: readonly Source[];
    machineName(machineId: string): string; defaultExpanded: boolean; disabled: boolean;
    /** Several machines in scope: each source says whose it is; with one, the group header already names it. */
    showMachine: boolean;
    onRetry(failure: NonNullable<ConversationSearchResult['failures']>[number]): void;
}>) {
    // With no hits on screen the failures are the whole answer, so they start open; the person's choice wins.
    const [chosen, setChosen] = React.useState<boolean | null>(null);
    return <ExpandableItem testID="external-conversation-failures" expanded={chosen ?? props.defaultExpanded} onExpandedChange={setChosen} showDivider={false}
        header={state => <View style={styles.menuRow}><Item {...state.headerProps} rowRole="menu" testID="external-conversation-failures-header"
            title={t('conversationSearch.coverageSourcesFailed')} titleStyle={styles.failureTitle} /></View>}>
        {props.failures.map(failure => {
            const source = props.sources.find(value => value.machineId === failure.machineId && value.agentId === failure.agentId && value.sourceKey === failure.sourceKey);
            return <View key={JSON.stringify([failure.machineId, failure.agentId, failure.sourceKey])} style={styles.menuRow}
                testID={`external-conversation-failure:${failure.machineId}:${failure.sourceKey}`}>
                <Item rowRole="menu" title={[props.showMachine ? props.machineName(failure.machineId) : null, source?.label, source?.detail].filter(Boolean).join(' · ')}
                    // The source detail is what tells two accounts apart, and the reason is the advice:
                    // both wrap rather than cut off on a phone.
                    titleLines={0}
                    subtitleLines={0}
                    subtitle={resolveExternalSessionBrowseRpcErrorMessage(failure.errorCode, 'list', { retryable: failure.retryable })}
                    rightElement={failure.retryable ? <TextLinkButton testID={`external-conversation-retry:${failure.machineId}:${failure.sourceKey}`} size="meta" tone="strong"
                        label={t('common.retry')} disabled={props.disabled} onPress={() => props.onRetry(failure)} /> : undefined} />
            </View>;
        })}
    </ExpandableItem>;
}

/** H1r: only the wide selected preview reads the matching exchange. */
function SelectedConversationPreview(props: Readonly<{ highlight: SelectedConversationHighlight | null; query: string; disabled: boolean }>) {
    const presentationActive = useLayoutPresentationActive();
    const { highlight } = props;
    const selectionCurrent = highlight?.isCurrent() === true;
    const [exchange, setExchange] = React.useState<Readonly<{
        key: string; messages: Awaited<ReturnType<typeof readExternalSessionExchange>>['messages'];
        matchedMessageId: string | null; elidedMessageCount: number; failed: boolean;
    }> | null>(null);
    const [revision, retry] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!presentationActive || !highlight || !selectionCurrent) return;
        const controller = new AbortController();
        const lifetime = highlight.exchange.accountLifetime;
        const retirement = lifetime.onRetire(() => { controller.abort(); setExchange(null); });
        const current = () => !controller.signal.aborted && lifetime.isCurrent() && highlight.isCurrent();
        setExchange(null);
        void readExternalSessionExchange({ ...highlight.exchange, signal: controller.signal })
            .then(exchange => { if (current()) setExchange({ key: highlight.key, ...exchange, failed: exchange.matchedMessageId === null }); })
            .catch(() => { if (current()) setExchange({ key: highlight.key, messages: [], matchedMessageId: null, elidedMessageCount: 0, failed: true }); });
        return () => { controller.abort(); retirement.dispose(); };
    }, [highlight, presentationActive, selectionCurrent, revision]);
    const selectedExchange = selectionCurrent && exchange?.key === highlight?.key ? exchange : null;
    return <ConversationPreview {...props} highlight={selectionCurrent ? highlight : null} exchange={selectedExchange} onRetry={retry} disabled={props.disabled || !selectionCurrent} />;
}

/** Pure preview presentation, also used by the design specimen. */
export function ConversationPreview(props: Readonly<{
    highlight: ConversationHighlight | null; query: string; disabled: boolean;
    exchange?: Readonly<{
        messages: Awaited<ReturnType<typeof readExternalSessionExchange>>['messages']; failed: boolean;
        matchedMessageId?: string | null; elidedMessageCount?: number;
    }> | null;
    onRetry?: () => void;
}>) {
    const { highlight, exchange: selectedExchange } = props;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const speaker = highlight?.agentId ? resolveAgentCatalogProjection(highlight.agentId, { enabledAgentIds: [] }).title : t('voiceActivity.format.assistant');
    // The exchange is the prompt (clamped), what lies between it and the hit (one quiet count), then the matched
    // message, windowed on its hit when it is long, so the hit is on screen when the preview opens.
    const matchedMessageId = selectedExchange?.matchedMessageId ?? null;
    const elidedCount = selectedExchange?.elidedMessageCount ?? 0;
    return <View testID="external-conversation-preview" style={styles.preview}>
        {highlight ? <>
            <View style={styles.previewHeading}>{highlight.agentId ? <AgentIcon agentId={highlight.agentId} size={ICON_SIZE.md} /> : null}<Text style={styles.previewTitle} numberOfLines={2}>{highlight.title}</Text></View>
            {highlight.meta ? <Text style={styles.meta} numberOfLines={1}>{highlight.meta}</Text> : null}
            <ScrollView style={styles.previewGrow} contentContainerStyle={styles.previewMessages}>
                <HappierBodyEdgeContext.Provider value>
                {!selectedExchange ? <ActivitySpinner size={ICON_SIZE.sm} /> : selectedExchange.failed
                    // The shared failure line on the preview's own edge, said once; the ways out below still work.
                    ? <SurfaceStateCard testID="external-conversation-preview-failed" size="line" kind="error" accessibilitySemantics="alert"
                        title={t('externalSessions.browseContentPreviewFailed')}
                        action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry, testID: 'external-conversation-preview-retry' } : undefined} />
                    : selectedExchange.messages.map((message, index) => {
                        const isMatch = message.id === matchedMessageId;
                        const isPrompt = !isMatch && index === 0 && message.kind === 'user-text';
                        return <React.Fragment key={message.id}>
                        {index === 1 && isMatch && elidedCount > 0 ? <Text testID="external-conversation-preview-elided" style={styles.previewElided}>{t('externalSessions.browseContentPreviewElided', { count: elidedCount })}</Text> : null}
                        <View>
                        <Text style={styles.meta}>{message.kind === 'user-text' ? t('voiceActivity.format.you') : speaker}</Text>
                        <View style={[styles.previewMessage, { backgroundColor: materialColor(message.kind === 'user-text' ? theme.colors.state.active.background : theme.colors.surface.inset) }]}>
                            {projectTranscriptFindText(message).map(block => {
                                const shown = isMatch ? excerptAroundFirstMatch(block.text, props.query) : block.text;
                                return <Text key={block.id} style={styles.previewText} numberOfLines={isPrompt ? PREVIEW_PROMPT_LINES : undefined} testID={`external-conversation-preview-message:${message.realID ?? message.id}`}>
                                    <FindHighlightedText text={shown} ranges={queryRanges(shown, props.query, message.realID === highlight.candidate.match?.sourceItemId || message.id === highlight.candidate.match?.sourceItemId)} />
                                </Text>;
                            })}
                        </View>
                    </View>
                        </React.Fragment>;
                    })}
                </HappierBodyEdgeContext.Provider>
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

type ContentSourceProps = ExternalConversationSearchResultsProps & Readonly<{
    search: ReturnType<typeof useConversationSearch>;
    source: Source; offline: boolean;
    /** With several machines in scope, each source's header says whose conversations these are. */
    showMachine: boolean; wide: boolean;
    /** The machine's home, so a path reads `~/…` rather than as the full absolute path. */
    homeDir: string | null;
    /** More than one group is on screen: this group's link row names its source. */
    namesSource: boolean;
    /** Narrow cards end the meta line with the hit's status instead of setting it beside the title. */
    statusInMeta: boolean; openState: ExternalSessionCandidateOpenState; linkingKey: string | null;
    onLinkingChange(key: string | null): void; onShow(): void;
    /** Wide layouts preview one hit: which one, whether none is chosen yet, and how a row claims it. */
    highlightedKey: string | null; onHighlight(highlight: SelectedConversationHighlight): void;
    /** The surface owns lifetime and paging state; recycled cells own neither. */
    isCurrent(): boolean;
    openCurrent(candidate: ExternalSessionBrowseCandidate): void;
    candidateCurrent(candidate: ExternalSessionBrowseCandidate): boolean;
    askedAtRows: number | undefined;
    onAsk(count: number): void;
}>;

type ContentSourceModel = ReturnType<typeof buildContentSourceModel>;
type ConversationResultRow =
    | Readonly<{ kind: 'candidate'; key: string; candidate: ExternalSessionBrowseCandidate; source: ContentSourceModel }>
    | Readonly<{ kind: 'source-footer'; key: string; source: ContentSourceModel }>
    | Readonly<{ kind: 'unsupported'; key: string; source: Source }>;

/** Source projection and selection stay mounted with the surface, independent of its visible cells. */
function buildContentSourceModel(props: ContentSourceProps) {
    const { source, openCurrent, candidateCurrent, onShow } = props;
    const group = readConversationSourceGroup(props.search.result, source, props.query);
    const continuation = group.continuation;
    // Rows the index answered, as opposed to ones this scan read from the Agent's files.
    const results = {
        candidates: group.candidates,
        loading: props.search.loading, cancelled: props.search.cancelled === true,
        nextCursor: continuation?.cursor,
        loadMore: () => continuation && props.search.loadMore(continuation),
    };
    // Found hits stay at full strength and openable while another page loads; only a surface that went away or
    // a retired Account makes a selection stale.
    const selectionCurrent = props.isCurrent;
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
    const describe = (candidate: ExternalSessionBrowseCandidate): SelectedConversationHighlight => {
        const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
            path: readExternalSessionBrowseCandidatePath(candidate), homeDir: props.homeDir, agentLabel: source.label, machineLabel: props.machineLabel, thread: candidate.thread });
        const relativeTime = candidate.updatedAtMs > 0 ? formatShortRelativeTime(candidate.updatedAtMs) : '';
        return { key: readExternalSessionBrowseCandidateKey(candidate), candidate, title: stripMarkdown(identity.title),
            meta: [identity.secondaryLabel, relativeTime].filter(Boolean).join(' · '),
            open: () => openCurrent(candidate), show: onShow, agentId: source.agentId,
            isCurrent: () => selectionCurrent() && candidateCurrent(candidate),
            exchange: { request: { machineId: props.target.machineId, agentId: source.agentId, source: source.source, remoteSessionId: candidate.remoteSessionId },
                accountLifetime: props.accountLifetime, sourceItemId: candidate.match!.sourceItemId } };
    };
    return { props, results, selectionCurrent, openCandidate, describe };
}

function ConversationResultCandidate({ candidate, source: model }: Readonly<{ candidate: ExternalSessionBrowseCandidate; source: ContentSourceModel }>) {
    const { props, selectionCurrent, openCandidate, describe } = model;
    const { source } = props;
    // The row's mark names the Agent and the group names the machine; the line keeps the project.
    const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
        path: readExternalSessionBrowseCandidatePath(candidate), homeDir: props.homeDir, machineLabel: props.showMachine ? props.machineLabel : null, thread: candidate.thread });
    const key = readExternalSessionBrowseCandidateKey(candidate);
    const match = candidate.match;
    const linking = props.linkingKey === key;
    const open = match ? () => openCandidate(candidate) : undefined;
    const highlightThis = match && props.highlightedKey !== null ? () => props.onHighlight(describe(candidate)) : undefined;
    return <View style={styles.menuRow}><Item rowRole="menu"
        testID={match ? `external-conversation-open:${candidate.remoteSessionId}` : undefined}
        title={stripMarkdown(identity.title)}
        titleHighlightQuery={props.query.trim() || undefined}
        contentAlign="start"
        icon={<AgentIcon agentId={source.agentId} size={ICON_SIZE.md} />}
        accessibilityLabel={match ? `${t('externalSessions.browseContentOpen')}: ${stripMarkdown(identity.title)}` : stripMarkdown(identity.title)}
        showChevron={false}
        onPress={open}
        onHoverIn={highlightThis}
        onFocus={highlightThis}
        selected={props.highlightedKey === key}
        disabled={!match || !selectionCurrent() || props.linkingKey !== null || (props.offline && !candidate.linkedSessionId)}
        rightElement={linking ? <ActivitySpinner size={ICON_SIZE.sm} />
            : props.statusInMeta ? undefined : <ConversationHitStatus candidate={candidate} />}
        bottomElementInset="text"
        bottomElement={<ConversationHitSummary
            snippet={resolveConversationHitSnippet({ title: identity.title, snippet: candidate.match?.snippet ?? t('externalSessions.browseContentNotSearchable'), query: props.query })}
            query={props.query} where={identity.secondaryLabel} atMs={candidate.updatedAtMs} messageCount={candidate.messageCount}
            status={props.statusInMeta ? resolveConversationHitStatusLabel(candidate) : null} testID={`external-session-candidate-match:${candidate.remoteSessionId}`} />} /></View>;
}

function ContentSourceFooter({ source: model }: Readonly<{ source: ContentSourceModel }>) {
    const { props, results } = model;
    const { source } = props;
    const busy = results.loading;
    // "Search more" that adds no conversation changes nothing on screen, so the line says what happened. The row
    // count at the press is the reference: a page that failed is reported by the failures and the error line instead.
    const sourceFailed = props.search.error !== null || (props.search.result?.failures ?? []).some(failure =>
        failure.machineId === source.machineId && failure.sourceKey === source.sourceKey);
    const nothingNew = props.askedAtRows !== undefined && !busy && !results.cancelled && !sourceFailed && results.candidates.length <= props.askedAtRows;
    const searchMore = () => { props.onAsk(results.candidates.length); void results.loadMore(); };
    const mixed = results.candidates.some(candidate => candidate.searchMode === 'indexed')
        && results.candidates.some(candidate => candidate.searchMode === 'standard');
    // Rows only: the agent's mark on each row says whose conversation it is, so a source draws no heading,
    // and a source with nothing to show draws nothing.
    if (results.candidates.length === 0 && !results.nextCursor) return null;
    return <View testID={`external-conversation-source:${source.key}`}>
        {mixed ? <Text style={styles.status}>{t('conversationSearch.mixedResults')}</Text> : null}
        {(results.nextCursor && !busy && !results.cancelled) || nothingNew || !props.wide ? <View style={styles.statusRow}>
            {/* A source with no rows has no hit to explain it, so its line always says whose "Search more" this is. */}
            {props.namesSource || results.candidates.length === 0 ? <Text testID={`external-conversation-source-name:${source.key}`} style={[styles.statusInline, props.wide ? null : styles.sourceNameNarrow]}>{[props.showMachine ? props.machineLabel : null, source.label, source.detail].filter(Boolean).join(' · ')}</Text> : null}
            {nothingNew ? <Text testID={`external-conversation-more-result:${source.key}`} style={styles.statusInline}>{t(results.nextCursor ? 'conversationSearch.moreNothingNew' : 'conversationSearch.moreExhausted')}</Text> : null}
            {results.nextCursor && !busy && !results.cancelled ? <TextLinkButton testID={`external-conversation-more:${source.key}`} size="meta" tone="strong" label={t('externalSessions.browseContentMore')} disabled={props.offline} onPress={searchMore} /> : null}
            {/* Narrow cards have no preview: the source's full listing is one quiet link away. */}
            {!props.wide ? <TextLinkButton size="meta" label={t('externalSessions.browseContentShow')} onPress={props.onShow} /> : null}
        </View> : null}
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, flexDirection: 'column', backgroundColor: theme.colors.surface.base },
    body: { flex: 1, minHeight: 0, flexDirection: 'row' },
    list: { flex: 1, minWidth: 0, minHeight: 0 },
    listContent: { paddingBottom: theme.space.s8 },
    // Hits sit on the palette's menu rows, edge to edge (owner 2026-11-08).
    menuRow: { overflow: 'hidden' },
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s12, rowGap: theme.space.s4, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    // Narrow cards: the source name is its own line and the group's links sit together beneath it, so each
    // group closes the same way instead of wrapping its links wherever the width breaks them.
    sourceNameNarrow: { flexBasis: '100%' },
    statusInline: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    failureTitle: { color: theme.colors.text.secondary },
    // The preview column (lab H1r `.fd-preview`): title, where it lives, the matched message, then the
    // two ways out and what opening does.
    preview: { width: PREVIEW_WIDTH, flexShrink: 0, minHeight: 0, gap: theme.space.s8, paddingHorizontal: theme.space.s16, paddingTop: theme.space.s16, paddingBottom: theme.space.s16,
        borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
    previewHeading: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    previewTitle: { ...Typography.variant('label', 'semiBold'), flex: 1, color: theme.colors.text.primary },
    previewMessage: { marginTop: theme.space.s6, paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s10, borderRadius: 12, backgroundColor: theme.colors.surface.inset },
    previewGrow: { flex: 1, minHeight: 12 },
    // One rhythm down the exchange (lab `.fd-preview`: 8 between who and what, 13/19 message text).
    previewMessages: { gap: theme.space.s12, paddingBottom: theme.space.s4 },
    previewText: { ...Typography.variant('meta'), color: theme.colors.text.primary },
    previewElided: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], textAlign: 'center' },
    previewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
    previewEmpty: { marginTop: 'auto', marginBottom: 'auto', textAlign: 'center' },
    meta: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    // Coverage and progress are context, not content: one quiet line.
    status: { ...Typography.variant('meta'), color: theme.colors.text.secondary, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
}));
