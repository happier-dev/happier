import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ExternalSessionsAgentId } from '@happier-dev/protocol';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { ExternalSessionBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { ExternalSessionsBrowseScreen, type ExternalSessionsBrowseScopeLock } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ExternalSessionCandidateMatch } from '@/components/sessions/external/browse/ExternalSessionBrowseCandidatesList';
import { listExternalSessionBrowseProviderIds, resolveExternalSessionBrowseSourceOptions, resolveExternalSessionBrowseContentSearchCapability, resolveExternalSessionBrowseContentSearchSupported } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import { openExternalSessionCandidate, type ExternalSessionCandidateFindSeed, type ExternalSessionCandidateOpenState } from '@/components/sessions/external/browse/openExternalSessionCandidate';
import { useExternalSessionBrowseCandidates, readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
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
import { useActiveServerAccountScope, useMachineListForServer, useProfile, useSetting } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

export type ExternalConversationSearchResultsProps = Readonly<{
    target: Readonly<{ machineId: string; serverId: string; accountId: string }>;
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
    return <ActivatedResults key={JSON.stringify([props.target, props.query])} {...props} />;
}

type Source = ExternalSessionBrowseSourceOption & Readonly<{ agentId: ExternalSessionsAgentId; supported: boolean; capability: boolean | undefined }>;

/** The hit the preview shows: what the search already returned for it, and its two ways out. */
export type ConversationHighlight = Readonly<{
    key: string;
    candidate: ExternalSessionBrowseCandidate;
    title: string;
    meta: string;
    open: () => void;
    show: () => void;
}>;

/** Wide enough for the list and the preview side by side (the palette card); narrower, rows open directly (lab H1rp). */
const PREVIEW_MIN_WIDTH = 720;
const PREVIEW_WIDTH = 372;

function ActivatedResults(props: ExternalConversationSearchResultsProps) {
    const machines = useMachineListForServer(props.target.serverId);
    const machine = machines?.find((candidate) => candidate.id === props.target.machineId);
    const offline = !machine || !isMachineOnline(machine);
    const profile = useProfile();
    const profileScope = useActiveServerAccountScope();
    const settingsScope = useAccountSettingsScope();
    const labels = useSetting('connectedServicesProfileLabelByKey');
    const [refreshKey, setRefreshKey] = React.useState(0);
    const projection = useDaemonMergedProjectionInputs({ machineId: props.target.machineId, serverId: props.target.serverId, load: !offline, refreshKey });
    const sources = React.useMemo((): Source[] => {
        if (projection.phase !== 'ready' || !projection.inputs) return [];
        const advertised = projection.inputs.pluginProjectionV2;
        return listExternalSessionBrowseProviderIds({ accountScope: props.target, machineId: props.target.machineId, projection: advertised }).flatMap((agentId) =>
            resolveExternalSessionBrowseSourceOptions({
                accountScope: props.target, providerId: agentId, machineId: props.target.machineId,
                profile: areServerAccountScopesEqual(profileScope, props.target) ? profile : null,
                settings: { connectedServicesProfileLabelByKey: areServerAccountScopesEqual(settingsScope, props.target) ? labels : {} },
                projection: advertised, activeServerId: props.target.serverId,
            }).map((option) => {
                const search = { providerId: agentId, source: option.source, projection: advertised };
                return { ...option, agentId, supported: resolveExternalSessionBrowseContentSearchSupported(search), capability: resolveExternalSessionBrowseContentSearchCapability(search) };
            }));
    }, [projection.phase, projection.inputs, props.target, profile, profileScope, settingsScope, labels]);
    const openState = React.useRef<ExternalSessionCandidateOpenState>({ requestToken: 0, linkingCandidateKey: null });
    const [linkingKey, setLinkingKey] = React.useState<string | null>(null);
    const [browseScope, setBrowseScope] = React.useState<ExternalSessionsBrowseScopeLock | null>(null);
    const [width, setWidth] = React.useState(0);
    const [highlight, setHighlight] = React.useState<ConversationHighlight | null>(null);
    const wide = width >= PREVIEW_MIN_WIDTH;
    React.useEffect(() => () => { openState.current.requestToken++; }, []);
    if (browseScope) return <ExternalSessionsBrowseScreen lockScope={browseScope} accountLifetime={props.accountLifetime} initialSearchTarget="content" initialSearchQuery={props.query} onRequestClose={props.onRequestClose} closeButton />;
    return <View testID="external-conversation-results" style={styles.root} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <View style={styles.list}>
        {/* Page anatomy: each section's title, description and one action (Back, Show in External sessions). */}
        <ItemList>
            <ItemGroup title={t('externalSessions.browseContentOnMachine', { machine: props.machineLabel })} description={props.query}
                action={<RoundButton title={t('externalSessions.browseContentBack')} size="small" display="inverted" onPress={props.onBack} />}>
                {offline ? <SectionContentRow><Text>{t('session.machineOfflineNoticeTitle')}</Text></SectionContentRow> : null}
                {projection.phase === 'loading' && !offline ? <SectionContentRow><Text>{t('common.loading')}</Text></SectionContentRow> : null}
                {projection.phase === 'error' ? <SectionContentRow><Text>{t('externalSessions.browseFailedToLoad')}</Text><RoundButton title={t('common.retry')} size="small" display="secondary" onPress={() => setRefreshKey((value) => value + 1)} /></SectionContentRow> : null}
                {projection.phase === 'unsupported' || (projection.phase === 'ready' && sources.length === 0) ? <SectionContentRow><Text>{t('externalSessions.browseContentUpdateRequired', { machine: props.machineLabel })}</Text></SectionContentRow> : null}
            </ItemGroup>
            {sources.map((source) => source.supported
                ? <ContentSource key={source.key} {...props} source={source} offline={offline} openState={openState.current} linkingKey={linkingKey} onLinkingChange={setLinkingKey} onShow={() => setBrowseScope({ ...props.target, providerId: source.agentId, source: source.source })}
                    highlightedKey={wide ? highlight?.key ?? null : null} wantsFirstHighlight={wide && highlight === null} onHighlight={setHighlight} />
                : <ItemGroup key={source.key} title={source.label} description={source.detail}><SectionContentRow><Text testID={`external-conversation-unsupported:${source.key}`}>{source.capability === false ? t('externalSessions.browseContentNotSearchable') : t('externalSessions.browseContentUpdateRequired', { machine: props.machineLabel })}</Text></SectionContentRow></ItemGroup>)}
        </ItemList>
        </View>
        {wide ? <ConversationPreview highlight={highlight} query={props.query} disabled={linkingKey !== null} /> : null}
    </View>;
}

/** The highlighted hit's matched message, with where it opens (Find lab H1r); built only from the returned match. */
export function ConversationPreview(props: Readonly<{ highlight: ConversationHighlight | null; query: string; disabled: boolean }>) {
    const { highlight } = props;
    return <View testID="external-conversation-preview" style={styles.preview}>
        {highlight ? <>
            <Text style={styles.previewTitle} numberOfLines={2}>{highlight.title}</Text>
            {highlight.meta ? <Text style={styles.meta} numberOfLines={1}>{highlight.meta}</Text> : null}
            <View style={styles.previewMessage}>
                <ExternalSessionCandidateMatch candidate={highlight.candidate} query={props.query} presentation="preview"
                    testID={`external-conversation-preview-match:${highlight.candidate.remoteSessionId}`} />
            </View>
            <View style={styles.previewGrow} />
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
    source: Source; offline: boolean; openState: ExternalSessionCandidateOpenState; linkingKey: string | null;
    onLinkingChange(key: string | null): void; onShow(): void;
    /** Wide layouts preview one hit: which one, whether none is chosen yet, and how a row claims it. */
    highlightedKey: string | null; wantsFirstHighlight: boolean; onHighlight(highlight: ConversationHighlight): void;
}>) {
    const { source } = props;
    const results = useExternalSessionBrowseCandidates({
        machineId: props.target.machineId, serverId: props.target.serverId, providerId: source.agentId,
        source: source.source, searchTerm: props.query, searchTarget: 'content', contentSearchSupported: true,
        enabled: !props.offline, accountLifetime: props.accountLifetime,
    });
    const current = React.useRef(true);
    React.useEffect(() => {
        current.current = true;
        return () => { current.current = false; };
    }, []);
    const selectionCurrent = () => current.current && props.accountLifetime.isCurrent()
        && results.candidatesAuthoritative && results.publishedSearchTerm === props.query;
    const openCandidate = (candidate: ExternalSessionBrowseCandidate) => {
        const match = candidate.match;
        if (!match) return;
        void openExternalSessionCandidate({
            candidate, agentId: source.agentId, source: source.source, actionsAllowed: selectionCurrent(), offline: props.offline,
            isSelectionCurrent: selectionCurrent, accountCurrentness: props.accountLifetime,
            resolveCurrentTarget: () => selectionCurrent() ? { machineId: props.target.machineId, serverId: props.target.serverId } : null,
            state: props.openState, onLinkingChange: props.onLinkingChange,
            find: { query: props.query, sourceItemId: match.sourceItemId },
            openSession: async (sessionId, target, find) => { props.onRequestClose(); await props.onOpenSession(sessionId, target, find); },
        });
    };
    // The preview opens through the latest render's guards, never a closure from when it was highlighted.
    const openRef = React.useRef(openCandidate);
    openRef.current = openCandidate;
    const describe = (candidate: ExternalSessionBrowseCandidate): ConversationHighlight => {
        const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
            path: readExternalSessionBrowseCandidatePath(candidate.details), agentLabel: source.label, machineLabel: props.machineLabel, thread: candidate.thread });
        const relativeTime = candidate.updatedAtMs > 0 ? formatShortRelativeTime(candidate.updatedAtMs) : '';
        return { key: readExternalSessionBrowseCandidateKey(candidate), candidate, title: identity.title,
            meta: [source.label, identity.secondaryLabel, props.machineLabel, relativeTime].filter(Boolean).join(' · '),
            open: () => openRef.current(candidate), show: props.onShow };
    };
    const firstMatched = results.candidates.find((candidate) => candidate.match);
    const { wantsFirstHighlight, onHighlight } = props;
    React.useEffect(() => {
        if (wantsFirstHighlight && firstMatched) onHighlight(describe(firstMatched));
        // `describe` reads this render's labels; the first matched hit is what changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantsFirstHighlight, firstMatched, onHighlight]);
    const busy = results.loading || results.loadingMore || Boolean(results.preparation);
    const status = results.cancelled || results.preparationStopped ? t('externalSessions.browseContentStopped')
        : results.contentCoverage === 'unsupported' ? t('externalSessions.browseContentNotSearchable')
            : results.error ? results.error
                : busy ? t('common.loading')
                    : results.contentCoverage === 'partial' ? t('externalSessions.browseContentPartial')
                        : results.candidates.length === 0 ? t('externalSessions.browseNoSearchResults') : '';
    // "Show in External sessions" opens this whole source in the browser (Titles | Conversations), so it
    // is the group's one action; each hit's row press is Open in Happier (Find lab H1r, ↵).
    return <ItemGroup title={source.label} description={source.detail}
        action={<RoundButton title={t('externalSessions.browseContentShow')} size="small" display="inverted" titleNumberOfLines="complete" onPress={props.onShow} />}>
        <PoliteAccessibilityStatus announcement={status} transitionKey={`${busy}:${results.cancelled}:${results.nextCursor}:${results.candidates.length}`} statusTestID={`external-conversation-status:${source.key}`} />
        {status ? <SectionContentRow><Text>{status}</Text></SectionContentRow> : null}
        {busy ? <SectionContentRow><RoundButton testID={`external-conversation-stop:${source.key}`} title={t('externalSessions.browseIndexingStop')} size="small" display="secondary" onPress={results.cancelPreparation} /></SectionContentRow> : null}
        {results.candidates.map((candidate) => {
            const identity = resolveExternalSessionBrowseCandidateIdentityPresentation({ remoteSessionId: candidate.remoteSessionId, title: candidate.title,
                path: readExternalSessionBrowseCandidatePath(candidate.details), agentLabel: source.label, machineLabel: props.machineLabel, thread: candidate.thread });
            const key = readExternalSessionBrowseCandidateKey(candidate);
            const match = candidate.match;
            const relativeTime = candidate.updatedAtMs > 0 ? formatShortRelativeTime(candidate.updatedAtMs) : '';
            const meta = [identity.secondaryLabel, relativeTime].filter(Boolean).join(' · ');
            const linking = props.linkingKey === key;
            const open = match ? () => openCandidate(candidate) : undefined;
            const highlightThis = match && props.highlightedKey !== null ? () => props.onHighlight(describe(candidate)) : undefined;
            return <Item key={key}
                testID={match ? `external-conversation-open:${candidate.remoteSessionId}` : undefined}
                title={identity.title}
                accessibilityLabel={match ? `${t('externalSessions.browseContentOpen')}: ${identity.title}` : identity.title}
                showChevron={false}
                onPress={open}
                onHoverIn={highlightThis}
                onFocus={highlightThis}
                selected={props.highlightedKey === key}
                disabled={!match || !selectionCurrent() || props.linkingKey !== null || (props.offline && !candidate.linkedSessionId)}
                rightElement={linking ? <ActivitySpinner size={ICON_SIZE.sm} />
                    : candidate.linkedSessionId ? <StatusPill variant="neutral" label={t('externalSessions.browseLinked')} hideDot labelVariant="phrase" /> : undefined}
                bottomElement={<View style={styles.result}>
                    <ExternalSessionCandidateMatch candidate={candidate} query={props.query} />
                    {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
                </View>} />;
        })}
        {results.nextCursor && !busy && !results.cancelled ? <SectionContentRow><RoundButton testID={`external-conversation-more:${source.key}`} title={t('externalSessions.browseContentMore')} size="small" display="secondary" disabled={props.offline} onPress={results.loadMore} /></SectionContentRow> : null}
        {results.error && !busy && !results.cancelled ? <SectionContentRow><RoundButton title={t('common.retry')} size="small" display="secondary" disabled={props.offline} onPress={results.reload} /></SectionContentRow> : null}
    </ItemGroup>;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, flexDirection: 'row', backgroundColor: theme.colors.surface.base },
    list: { flex: 1, minWidth: 0, minHeight: 0 },
    // The preview column (lab H1r `.fd-preview`): title, where it lives, the matched message, then the
    // two ways out and what opening does.
    preview: { width: PREVIEW_WIDTH, flexShrink: 0, minHeight: 0, gap: 8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 16,
        borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
    previewTitle: { ...Typography.default('semiBold'), fontSize: 15, lineHeight: 20, color: theme.colors.text.primary },
    previewMessage: { marginTop: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.surface.inset },
    previewGrow: { flex: 1, minHeight: 12 },
    previewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    previewEmpty: { marginTop: 'auto', marginBottom: 'auto', textAlign: 'center' },
    result: { gap: 2 },
    meta: { fontSize: 12.5, color: theme.colors.text.tertiary },
}));
