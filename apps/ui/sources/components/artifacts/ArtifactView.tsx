import * as React from 'react';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Redirect, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import {
    artifactViewRoute,
    classifyArtifactBrowserKind,
    classifyArtifactViewKind,
    isArtifactTextDocument,
    readArtifactCodeLanguage,
    readArtifactProvenance,
    opensInArtifactView,
    resolveArtifactOpenRoute,
} from './artifactBrowserModel';
import { artifactKindFact } from './artifactKindPresentation';
import { ArtifactProvenanceLabel, readArtifactProvenanceFallback } from './ArtifactProvenance';
import { useArtifactOperations } from './useArtifactOperations';
import { useArtifactNetworkEditor } from './useArtifactNetworkEditor';
import { useArtifactBody } from './useArtifactBody';
import { ArtifactBodyActionsProvider, useArtifactBodyActionsHost, type ArtifactBodyActions } from './artifactBodyActions';
import { ArtifactBody } from './ArtifactBody';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useDocCollaboration, type DocCollaboration } from './useDocCollaboration';
import { isReviewArtifact, ReviewDetailHost } from '@/components/reviews/detail/ReviewDetailHost';
import type { PluginReviewPageSelection } from '@/components/plugins/pages/pluginPageRoute';
import { ArtifactPassageThreadCardPlaceholder } from './ArtifactPassageThreadCard';
import { clearDocReturn, peekDocReturn, trackDocScroll } from './docThreadReturn';
import { HomeReachabilityGate, useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import type { ScrollView, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * One artifact, read: in the browser's details pane (`pane`: the pane band carries the title) or as
 * its own page (`page`: the entity header). Edit, History, Share and ⋯ Delete act on it; Share is the
 * one document share sheet for every ordinary kind.
 */
export function ArtifactView(props: Readonly<{
    artifactId: string;
    /** The store's artifact for `artifactId` (`null` when it is not, or no longer, there). */
    artifact: DecryptedArtifact | null;
    presentation: 'pane' | 'page';
    onDeleted?: () => void;
    /** Opened at this passage thread (`artifactViewRoute(…, { thread })`): its passage is marked and its card brought beside it. */
    focusThreadId?: string;
    pluginPageSelection?: PluginReviewPageSelection | null;
}>): React.ReactElement {
    // Retained browser selections can bypass the click-time destination check.
    // Delegate before mounting any Document reader, including for a cached body.
    if (props.artifact && !opensInArtifactView(props.artifact)) {
        return <Redirect href={resolveArtifactOpenRoute(props.artifact) as Href} />;
    }
    return <ArtifactKindView {...props} />;
}

/**
 * One opened body read for every kind, then the kind's reader: a Review is its own page (plan 04 U4);
 * every other kind reads as a Document.
 */
function ArtifactKindView(props: React.ComponentProps<typeof ArtifactView>): React.ReactElement {
    const body = useArtifactBody(props.artifactId, props.artifact);
    const artifact = body.result?.artifact ?? props.artifact;
    if (artifact && artifact.isDecrypted !== false && isReviewArtifact(artifact)) {
        return <ReviewDetailHost artifact={artifact} bodyState={body.state} onRetry={body.retry}
            focusThreadId={props.focusThreadId} pluginPageSelection={props.pluginPageSelection} onDeleted={props.onDeleted} />;
    }
    return <ArtifactDocumentView {...props} body={body} />;
}

function ArtifactDocumentView(props: React.ComponentProps<typeof ArtifactView> & Readonly<{
    body: ReturnType<typeof useArtifactBody>;
}>): React.ReactElement {
    const { body } = props;
    const artifact = body.result?.artifact ?? props.artifact;
    const router = useRouter();
    const [bodyActions, publishBodyActions] = useArtifactBodyActionsHost();
    // Deleting the row retires its toolbar, not this destination's pending operation.
    const operations = useArtifactOperations(artifact, props.onDeleted);
    // Membership is an independent authenticated read: the known Artifact identity starts it
    // beside the body read, while prose-dependent thread placement waits for opened content.
    const collaboration = useDocCollaboration(artifact, operations.canEdit);
    const scope = useActiveServerAccountScope();
    const menuKey = collaboration && scope ? JSON.stringify([scope.serverId, scope.accountId, props.artifactId]) : null;
    const [threadMenu, setThreadMenu] = React.useState<Readonly<{ key: string | null; open: boolean }>>({ key: null, open: false });
    const onThreadMenuOpenChange = React.useCallback((open: boolean) => setThreadMenu({ key: menuKey, open }), [menuKey]);
    const openThreadList = React.useCallback(() => onThreadMenuOpenChange(true), [onThreadMenuOpenChange]);
    const threadMenuOpen = menuKey !== null && threadMenu.key === menuKey && threadMenu.open;
    // Preserve the former conditional menu's unmount lifetime after lifting its
    // single open state to the Doc owner; a later Doc must not inherit it.
    React.useEffect(() => {
        setThreadMenu(current => current.key === menuKey ? current : { key: menuKey, open: false });
    }, [menuKey]);
    // Opened at a passage (a Discussion's quote): the Doc's own thread focus marks it once its thread is placed.
    const focusThreadId = props.focusThreadId;
    const onFocusThread = collaboration?.margin.onFocus;
    const focusPlaced = Boolean(focusThreadId && collaboration?.margin.passages.some(passage => passage.id === focusThreadId));
    const focusedOnOpen = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!focusThreadId || !focusPlaced || !onFocusThread || focusedOnOpen.current === focusThreadId) return;
        focusedOnOpen.current = focusThreadId;
        onFocusThread(focusThreadId);
    }, [focusPlaced, focusThreadId, onFocusThread]);
    // Without thread cards the comments column says where its threads are: coming, none yet, or unavailable.
    const columnStatus = collaboration && collaboration.margin.passages.length === 0 ? collaboration.commentCountStatus : null;
    const margin = React.useMemo(() => collaboration ? {
        ...collaboration.margin,
        onOpenThreadList: openThreadList,
        idle: columnStatus === null ? null : <DocCommentsColumnState status={columnStatus} />,
    } : undefined, [collaboration?.margin, columnStatus, openThreadList]);
    const styles = stylesheet;
    // Back from a passage's thread lands where the reader was (lab K1-Ap/Rp).
    const scroller = React.useRef<ScrollView>(null);
    const [restoreTo] = React.useState(() => peekDocReturn(props.artifactId));
    const restored = React.useRef(restoreTo === null);
    React.useEffect(() => clearDocReturn(props.artifactId), [props.artifactId]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        trackDocScroll(props.artifactId, event.nativeEvent.contentOffset.y);
    }, [props.artifactId]);
    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (restored.current || restoreTo === null || height < restoreTo) return;
        restored.current = true;
        scroller.current?.scrollTo({ y: restoreTo, animated: false });
    }, [restoreTo]);
    // A Doc's page always takes the wide column: the body keeps its reading measure on the left and its
    // comments column stands beside it from the first frame, so nothing moves when threads arrive (lab K1-A/R).
    const docColumn = collaboration !== null;

    const failure = body.state === 'failed' ? (
        <SurfaceStateCard
            testID="artifact:bodyFailed"
            kind="error"
            title={t('artifacts.error')}
            reason={resolveActionExecutionErrorMessage(body.failure, t('artifacts.browser.loadFailedBody'), { safeToRetry: true })}
            action={{ label: t('common.retry'), onPress: body.retry }}
            accessibilitySemantics="alert"
        />
    ) : null;
    if (artifact === null || body.state === 'missing') {
        if (body.state === 'loading') return <View style={styles.bodyPlaceholder} testID="artifact:bodyLoading" />;
        if (failure) return failure;
        return (
            <SurfaceStateCard
                testID="artifact:notFound"
                kind="empty"
                title={t('artifacts.notFound')}
                // Not found and not shared read alike (the refusal never tells them apart); neither claims a history.
                reason={t('artifacts.notFoundReason')}
                // Its own page leads back to the list; in the browser's pane the list already stands beside it.
                action={props.presentation === 'page'
                    ? { label: t('artifacts.backToArtifacts'), onPress: () => router.push('/artifacts' as never) }
                    : undefined}
            />
        );
    }
    if (artifact.isDecrypted === false) {
        return (
            <SurfaceStateCard
                testID="artifact:locked"
                kind="warning"
                title={t('settingsAccount.restoreRequiredTitle')}
                reason={artifact.availability.reason === 'encryption_material_unavailable' ? t('settingsAccount.secretKeyMissing') : t('artifacts.error')}
            />
        );
    }

    const content = failure ?? (body.state === 'loading' ? (
        <View style={styles.bodyPlaceholder} testID="artifact:bodyLoading" />
    ) : (
        <ArtifactBodyActionsProvider value={publishBodyActions}>
            <ArtifactBody artifact={body.result?.artifact ?? artifact} prepared={body.result} onRetry={body.retry} margin={margin} />
        </ArtifactBodyActionsProvider>
    ));

    const unreachable = <DocHomeUnreachable />;
    if (props.presentation === 'pane') {
        return (
            <ItemList testID="artifact:pane">
                <View style={styles.paneColumn}>
                    <ArtifactFacts artifact={artifact} collaboration={collaboration} />
                    <ArtifactActions artifact={artifact} presentation="pane" operations={operations} collaboration={collaboration}
                        threadMenuOpen={threadMenuOpen} onThreadMenuOpenChange={onThreadMenuOpenChange} bodyActions={bodyActions} />
                    <View style={styles.paneRule} />
                    {unreachable}
                    {content}
                </View>
            </ItemList>
        );
    }
    return (
        <ItemList testID="artifact:page" ref={scroller} pageColumn={docColumn ? 'wide' : 'reading'}
            onScroll={onScroll} scrollEventThrottle={64} onContentSizeChange={onContentSizeChange}>
            <ArtifactPageHeader artifact={artifact} collaboration={collaboration} openThreadList={openThreadList} />
            <ItemGroup surface="none">
                {/* The title keeps the whole column; the artifact's operations sit under its facts, as in the pane. */}
                <ArtifactActions artifact={artifact} presentation="page" operations={operations} collaboration={collaboration}
                    threadMenuOpen={threadMenuOpen} onThreadMenuOpenChange={onThreadMenuOpenChange} bodyActions={bodyActions} />
                <View style={styles.paneRule} />
                {unreachable}
                {content}
            </ItemGroup>
        </ItemList>
    );
}

function readFacts(artifact: DecryptedArtifact, collaboration: DocCollaboration | null,
    openThreadList?: () => void): readonly PageHeaderMetaFact[] {
    const kind = artifactKindFact(classifyArtifactViewKind(artifact), readArtifactCodeLanguage(artifact));
    const audience = collaboration?.audience ?? null;
    // A Doc with collaboration leads with the version being read and ends with who it reaches (K1-R);
    // a fact that is not known yet is left out rather than guessed.
    const lead: PageHeaderMetaFact = collaboration && collaboration.version !== null
        ? { key: 'version', text: t('artifacts.browser.facts.version', { n: collaboration.version }), icon: kind.icon }
        : { key: 'kind', text: kind.label, icon: kind.icon };
    // Open suggestions on the version being read, beside it (lab K1-A "Revision 14 · 1 suggestion"). Pressing it
    // shows the suggestion with Accept and Decline: beside its passage, or on a phone, its thread.
    const suggestions = collaboration?.suggestionCount ?? 0;
    const suggestionsText = t('artifacts.browser.facts.suggestions', { count: suggestions });
    return [
        lead,
        ...(suggestions > 0 && collaboration ? [{ key: 'suggestions', text: suggestionsText, testID: 'artifact:facts.suggestions',
            accessibilityLabel: suggestionsText,
            ...(openThreadList ? { onPress: () => collaboration.openSuggestions(openThreadList) } : {}) }] : []),
        // Who accepted the edit that made this version is said once, on its thread's receipt (with Undo) and in History.
        { key: 'edited', text: t('artifacts.browser.facts.edited', { age: formatRelativeTimeShort(artifact.updatedAt, Date.now()) }) },
        ...(audience === null ? [] : [audience.shared
            ? { key: 'audience', icon: 'users' as const, text: audience.team
                ? t('artifacts.browser.facts.sharedWithTeam', { team: audience.team })
                : t('artifacts.browser.facts.shared') }
            : { key: 'audience', icon: 'lock' as const, text: t('artifacts.browser.facts.onlyYou') }]),
    ];
}

/** Where it came from: a real source, or who shared it; nothing when it is simply the viewer's own. */
function showsProvenanceChip(artifact: DecryptedArtifact, collaboration: DocCollaboration | null): boolean {
    // A Doc's audience line already says whose it is and who has it; the fallback chip would repeat it.
    return readArtifactProvenance(artifact) !== null || (collaboration === null && readArtifactProvenanceFallback(artifact) !== null);
}

function ArtifactProvenanceChip(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null }>) {
    if (!showsProvenanceChip(props.artifact, props.collaboration)) return null;
    return (
        <ArtifactProvenanceLabel
            provenance={readArtifactProvenance(props.artifact)}
            fallback={readArtifactProvenanceFallback(props.artifact) ?? ''}
            presentation="chip"
            testID="artifact:provenance"
        />
    );
}

/** The pane's identity line: where it came from, then its kind and age (the pane band holds the title). */
function ArtifactFacts(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null }>) {
    const styles = stylesheet;
    const facts = readFacts(props.artifact, props.collaboration);
    return (
        <View style={styles.facts}>
            <ArtifactProvenanceChip artifact={props.artifact} collaboration={props.collaboration} />
            <Text style={styles.factLine}>{facts.map((fact) => fact.text).join(' · ')}</Text>
        </View>
    );
}

function ArtifactPageHeader(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null; openThreadList: () => void }>) {
    return (
        <PageHeader
            testID="artifact:header"
            title={props.artifact.title || t('artifacts.untitled')}
            alwaysShowTitle
            meta={readFacts(props.artifact, props.collaboration, props.openThreadList)}
            details={!showsProvenanceChip(props.artifact, props.collaboration) ? undefined : (
                <View style={stylesheet.headerDetails}>
                    <ArtifactProvenanceChip artifact={props.artifact} collaboration={props.collaboration} />
                </View>
            )}
        />
    );
}

/** Edit and History quiet, Share bordered, rare operations (Delete) behind ⋯ — in the pane and on the page. */
function ArtifactActions(props: Readonly<{ artifact: DecryptedArtifact; presentation: 'pane' | 'page'; operations: ReturnType<typeof useArtifactOperations>; collaboration: DocCollaboration | null;
    threadMenuOpen: boolean; onThreadMenuOpenChange: (open: boolean) => void;
    /** A file body's View full screen and Download, quiet beside History. */
    bodyActions: ArtifactBodyActions | null }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const { artifact } = props;
    const { canEdit, canManage, canShare, deleting, remove, history, share } = props.operations;
    const anchorRef = React.useRef<View>(null);
    const network = useArtifactNetworkEditor(artifact, canEdit, anchorRef);
    const menu: PageHeaderMenuAction[] = [
        // What a saved HTML page may reach is changed here, as on its Board card (UD1028-03).
        ...(network.available ? [{ id: 'network', title: t('sessionBoard.item.actions.network'), loading: network.opening,
            testID: 'artifact:networkAction', onSelect: network.open }] : []),
        ...(canManage ? [{ id: 'delete', title: t('artifacts.delete'), destructive: true, loading: deleting, testID: 'artifact:delete', onSelect: remove }] : []),
    ];
    return (
        <View ref={anchorRef} collapsable={false} style={[styles.actions, props.presentation === 'pane' ? styles.paneActions : null]} testID="artifact:actions">
            {/* Only a text document opens the text editor; a saved widget or a dashboard is edited where it lives. */}
            {canEdit && classifyArtifactBrowserKind(artifact) !== 'widget' && isArtifactTextDocument(artifact) && (artifact.body === undefined || artifact.body === null || typeof artifact.body === 'string') ? (
                <RoundButton
                    testID="artifact:edit"
                    size="small"
                    display="inverted"
                    title={t('artifacts.browser.actions.edit')}
                    leading={<Icon name="pencil-simple" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    onPress={() => router.push(`/artifacts/edit/${encodeURIComponent(artifact.id)}` as never)}
                />
            ) : null}
            {props.collaboration ? <ArtifactThreadsMenu collaboration={props.collaboration} open={props.threadMenuOpen} onOpenChange={props.onThreadMenuOpenChange} /> : null}
            <RoundButton
                testID="artifact:history"
                size="small"
                display="inverted"
                title={t('artifacts.browser.actions.history')}
                leading={<Icon name="clock-counter-clockwise" size={14} color={theme.colors.text.secondary} />}
                textStyle={{ color: theme.colors.text.secondary }}
                onPress={() => history(props.collaboration?.acceptedVersions)}
            />
            {props.bodyActions?.openFullScreen ? (
                <RoundButton
                    testID="artifact:fullScreen"
                    size="small"
                    display="inverted"
                    title={t('files.viewer.viewFullScreen')}
                    leading={<Icon name="arrows-out" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    onPress={props.bodyActions.openFullScreen}
                />
            ) : null}
            {props.bodyActions ? (
                <RoundButton
                    testID="artifact:download"
                    size="small"
                    display="inverted"
                    title={t('files.repositoryTree.actions.download')}
                    leading={<Icon name="download" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    loading={props.bodyActions.downloading}
                    onPress={props.bodyActions.download}
                />
            ) : null}
            {canShare ? (
                <RoundButton
                    testID="artifact:share"
                    size="small"
                    display="secondary"
                    title={t('artifacts.browser.actions.share')}
                    leading={<Icon name="share" size={14} color={theme.colors.text.primary} />}
                    onPress={(event) => share(resolvePressTriggerAnchor(event))}
                />
            ) : null}
            {menu.length > 0 ? <PageHeaderMenu testID="artifact:more" actions={menu} /> : null}
            {network.panel}
        </View>
    );
}

/**
 * The comment count, and the Doc's threads behind it: each names its passage and who started it; a
 * thread whose passage changed says so. Choosing one shows it beside its passage, or opens it.
 */
function ArtifactThreadsMenu(props: Readonly<{ collaboration: DocCollaboration; open: boolean; onOpenChange: (open: boolean) => void }>) {
    const { theme } = useUnistyles();
    const { collaboration, open, onOpenChange: setOpen } = props;
    const items = React.useMemo(() => collaboration.threads.map((thread) => ({
        id: thread.id,
        testID: `artifact:comments.thread:${thread.id}`,
        title: thread.quote,
        subtitle: t('artifacts.browser.passage.threadDetail', { who: thread.author, n: thread.replies }),
        ...(thread.changed ? { rightElement: (
            <Text variant="meta" emphasis="medium" style={{ color: theme.colors.state.warning.textForeground }}>
                {t('artifacts.browser.passage.changed')}
            </Text>
        ) } : {}),
    })), [collaboration.threads, theme.colors.state.warning.textForeground]);
    const count = collaboration.openCommentCount;
    const countStatus = collaboration.commentCountStatus;
    const anchorRef = React.useRef<View>(null);
    const sheetThreadId = collaboration.sheetThreadId;
    return (
        <>
        <View ref={anchorRef} collapsable={false}>
        <DropdownMenu
            testID="artifact:comments.menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            allowEmptySelection
            // Beside the body the comments column already says there are none; the list only says it where no column shows.
            emptyLabel={countStatus === 'ready' && count === 0 && !collaboration.marginShown ? <NoCommentsYet /> : null}
            onSelect={(id) => {
                setOpen(false);
                collaboration.selectThread(id);
            }}
            placement="bottom"
            // A body tap far down the Doc opens this list too: a phone's anchored panel flips above the tap when below is short.
            popoverAccessibilityLabel={t('artifacts.browser.passage.threadsTitle')}
            // A phone lists the Doc's threads in the shared bottom sheet over the Doc (lab L8-STp).
            popoverPhonePresentation="sheet"
            popoverAnchorAlign="start"
            matchTriggerWidth={false}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <RoundButton
                    testID="artifact:comments"
                    size="small"
                    display="inverted"
                    // Unknown stays unknown (an em dash with its cause), never a fabricated zero.
                    title={count === null ? '—' : String(count)}
                    accessibilityLabel={countStatus === 'loading'
                        ? t('artifacts.browser.passage.threadsTitle')
                        : countStatus === 'unavailable'
                            ? t('artifacts.browser.passage.countUnavailable')
                            : t('artifacts.browser.passage.count', { count: count ?? 0 })}
                    leading={<Icon name="chat-circle" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] }}
                    disabled={countStatus !== 'ready' || (items.length === 0 && (count !== 0 || collaboration.marginShown))}
                    onPress={toggle}
                />
            )}
        />
        </View>
        {/* Without a margin, a chosen thread's card comes up over the Doc: the same card as beside the passage. */}
        {sheetThreadId ? (
            <Popover
                open
                anchorRef={anchorRef}
                placement="bottom"
                maxWidthCap={420}
                phonePresentation="sheet"
                accessibilityLabel={t('artifacts.browser.passage.threadsTitle')}
                onRequestClose={collaboration.closeThreadSheet}
                backdrop={{ enabled: false }}
                portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
            >
                {() => <View style={stylesheet.threadSheet}>{collaboration.margin.renderCard(sheetThreadId)}</View>}
            </Popover>
        ) : null}
        </>
    );
}

/** The Doc stays readable from what the app already holds; one quiet line says why nothing new arrives. */
function DocHomeUnreachable() {
    const unavailable = useActiveHomeUnavailable();
    if (!unavailable) return null;
    return <View style={stylesheet.unreachable}><HomeReachabilityGate variant="line">{null}</HomeReachabilityGate></View>;
}

/** The comments column without thread cards (lab L8 ST loading / none): coming, none yet, or unavailable. */
function DocCommentsColumnState(props: Readonly<{ status: DocCollaboration['commentCountStatus'] }>) {
    const { theme } = useUnistyles();
    if (props.status === 'loading') return <ArtifactPassageThreadCardPlaceholder />;
    if (props.status === 'ready') return <NoCommentsYet />;
    return (
        <View style={stylesheet.noComments} testID="artifact:comments.unavailable">
            <Icon name="chat-circle" size={20} color={theme.colors.text.tertiary} />
            <Text variant="meta" style={stylesheet.noCommentsHint}>{t('artifacts.browser.passage.commentsUnavailable')}</Text>
        </View>
    );
}

/** No comments yet: how to start, in the Doc's own words (lab L8 ST none), in its column or the Comments list. */
function NoCommentsYet() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View style={styles.noComments} testID="artifact:comments.empty">
            <Icon name="chat-circle" size={20} color={theme.colors.text.tertiary} />
            <Text variant="label" emphasis="semiBold" style={styles.noCommentsTitle}>{t('artifacts.browser.passage.noComments')}</Text>
            <Text variant="meta" style={styles.noCommentsHint}>{t('artifacts.browser.passage.noCommentsHint')}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // The thread card over the Doc keeps the page's gutters, as the margin keeps the column's.
    threadSheet: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
    unreachable: {
        marginBottom: theme.space.s12,
    },
    noComments: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s20,
        paddingVertical: theme.space.s20,
    },
    noCommentsTitle: {
        color: theme.colors.text.primary,
    },
    noCommentsHint: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    // The pane's one text edge, the inset its header title uses, so facts, actions and body start under the title (F8).
    paneColumn: {
        paddingHorizontal: PANE_TEXT_INSET_PX,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s32,
    },
    facts: {
        gap: theme.space.s8,
    },
    factLine: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    paneActions: {
        marginTop: 14,
    },
    paneRule: {
        height: 1,
        backgroundColor: theme.colors.border.subtle,
        marginTop: 14,
        marginBottom: theme.space.s16,
    },
    headerDetails: {
        marginTop: theme.space.s10,
    },
    bodyPlaceholder: {
        minHeight: 160,
    },
}));
