import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierArtifactRevisionList, useHappierTextPresentation, type HappierArtifactRevisionListProps } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX } from '@/components/ui/lists/itemGroupSpacing';
import { ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX } from '@/components/ui/lists/itemDensityMetrics';
import { useItemDensityInputs } from '@/components/ui/lists/useResolvedItemDensity';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { getStorage, useLocalSetting } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { createArtifactActionsClient, type ArtifactActionsClient } from './artifactActionsClient';
import type { ArtifactBodyV1, ArtifactRevisionProvenanceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactBinaryBody } from './ArtifactBinaryBody';

type Revision = Readonly<{ bodyVersion: number; body: ArtifactBodyV1 | null; createdAt: number; sizeBytes: number; provenance?: ArtifactRevisionProvenanceV1 }>;

function revisionSubtitle(createdAt: number, provenance: ArtifactRevisionProvenanceV1 | undefined, ownAccountId: string | null): string {
    const labels = [formatRelativeTimeShort(createdAt, Date.now())];
    if (provenance) {
        labels.push(provenance.savedBy.kind === 'agent' ? t('artifacts.browser.history.savedByAgentSession')
            // The reader's own saves say so; another person's save stays the neutral fact.
            : provenance.savedBy.accountId === ownAccountId ? t('artifacts.browser.provenance.savedByYou')
                : t('artifacts.browser.history.savedByUser'));
        if (provenance.restoredFromBodyVersion !== undefined)
            labels.push(t('artifacts.browser.history.restoredVersion', { n: provenance.restoredFromBodyVersion }));
    }
    return labels.join(' · ');
}

type HistoryData = Readonly<{ revisions: readonly Revision[]; retentionCount: number }>;
type HistoryState = Readonly<{
    client: ArtifactActionsClient;
    artifactId: string;
    data: HistoryData | null;
    loading: boolean;
    failed: boolean;
}>;
type HistorySelection = Readonly<{ client: ArtifactActionsClient; artifactId: string; bodyVersion: number }>;
type HistoryArtifact = Pick<DecryptedArtifact, 'id' | 'title' | 'headerVersion' | 'bodyVersion' | 'body' | 'updatedAt' | 'provenance' | 'seq' | 'access'>;
type CurrentDoc = Extract<Awaited<ReturnType<ArtifactActionsClient['readDoc']>>, { ok: true }>['value']['artifact'];
type HistorySubject = Readonly<{
    artifactId: string;
    client: ArtifactActionsClient;
    currentArtifact: HistoryArtifact | undefined;
    canRestore: boolean;
    compareFromBodyVersion?: number;
}>;

/** Two columns (versions beside the preview) from this width; narrower, the preview replaces the list. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 640;
// The caption starts level with the first version's title beside it: the untitled group's own top inset,
// then that row's padding at the user's density.
const CAPTION_TOP_PX = Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX);

function ArtifactHistoryItemGroup(props: React.ComponentProps<HappierArtifactRevisionListProps['host']['ItemGroup']>) {
    // The sheet is already titled "History": a second "Versions" heading over its only list is the same word twice.
    return <ItemGroup children={props.children} />;
}

/** Beside the preview the versions are the dialog's list pane: flat rows on the plane, no card in the card. */
function ArtifactHistoryPaneItemGroup(props: React.ComponentProps<HappierArtifactRevisionListProps['host']['ItemGroup']>) {
    return <ItemGroup surface="none" children={props.children} />;
}

function ArtifactHistoryItem(props: React.ComponentProps<HappierArtifactRevisionListProps['host']['Item']>) {
    const { leading, ...item } = props;
    return <Item {...item} leftElement={leading} />;
}

/** The current version's "Now" is the app's neutral status pill (lab A6 `.ar-tag`). */
function ArtifactHistoryNowBadge(props: Readonly<{ label: string }>) {
    return <StatusPill variant="neutral" label={props.label} hideDot />;
}

const HISTORY_LIST_HOST: HappierArtifactRevisionListProps['host'] = { Item: ArtifactHistoryItem, ItemGroup: ArtifactHistoryItemGroup, Text, Badge: ArtifactHistoryNowBadge };
const HISTORY_PANE_HOST: HappierArtifactRevisionListProps['host'] = { ...HISTORY_LIST_HOST, ItemGroup: ArtifactHistoryPaneItemGroup };

/**
 * An artifact's History (lab A6): earlier versions newest first → preview → Restore. Restore is the one
 * primary action and adds the chosen body as a new version; history is never rewritten (ART-A1).
 * Opened to compare (a suggestion or comment written against an earlier version, C5 Compare), it starts
 * on that version and each preview shows what changed from it to the current text.
 */
function ArtifactHistoryContent(props: HistorySubject & Readonly<{ onClose: () => void }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { client } = props;
    const scope = client.scope;
    const router = useRouter();
    // The sync store is active-Home-only. Its same-id row is useful only while it belongs to this
    // captured Account; direct Discussion entry may never have put this Doc in that store at all.
    const activeArtifact = getStorage()(state => areServerAccountScopesEqual(state.profileScope, scope)
        ? state.artifacts[props.artifactId] : undefined);
    const retainedArtifact = React.useRef(props.currentArtifact);
    const artifact = activeArtifact && (!retainedArtifact.current || activeArtifact.seq >= retainedArtifact.current.seq)
        ? activeArtifact : retainedArtifact.current;
    React.useEffect(() => { retainedArtifact.current = artifact; }, [artifact]);
    const readBinary = React.useCallback<typeof sync.fetchArtifactBinary>(async (artifactId, reference, signal) => {
        // This byte reader is active-Home-only. Admission here binds its existing scope guard to the
        // captured subject; Sync rechecks the same Account before/after every await, including release.
        if (!areServerAccountScopesEqual(getActiveServerAccountScope(), scope))
            throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
        return sync.fetchArtifactBinary(artifactId, reference, signal);
    }, [scope]);
    const rowDensity = useItemDensityInputs().resolved;
    const listColors = React.useMemo(() => ({ secondary: theme.colors.text.secondary, tertiary: theme.colors.text.tertiary, divider: theme.colors.border.subtle }),
        [theme.colors.border.subtle, theme.colors.text.secondary, theme.colors.text.tertiary]);
    const captionInset = React.useMemo(() => ({ paddingTop: (CAPTION_TOP_PX ?? 0) + ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX[rowDensity] }), [rowDensity]);
    const { width, fontScale } = useWindowDimensions();
    const [bodyWidth, setBodyWidth] = React.useState<number | null>(null);
    const measureBody = React.useCallback((event: LayoutChangeEvent) => {
        setBodyWidth(event.nativeEvent.layout.width);
    }, []);
    const uiFontScale = useLocalSetting('uiFontScale');
    const textPresentation = useHappierTextPresentation({ textScale: uiFontScale });
    const effectiveTextScale = textPresentation.metricScale * (Platform.OS === 'web' ? 1 : fontScale);
    const sideBySide = (bodyWidth ?? width) / effectiveTextScale >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const sideBySideRef = React.useRef(sideBySide);
    sideBySideRef.current = sideBySide;
    const [state, setState] = React.useState<HistoryState | null>(null);
    const [selection, setSelection] = React.useState<HistorySelection | null>(null);
    const [restoring, setRestoring] = React.useState(false);
    const [restoreFailed, setRestoreFailed] = React.useState(false);
    const [refreshIntent, requestRefresh] = React.useReducer((intent: number) => intent + 1, 0);
    const artifactId = props.artifactId;
    const current = artifact?.bodyVersion;
    const compareFrom = props.compareFromBodyVersion;
    const history = state?.client === client && state.artifactId === artifactId ? state : null;
    const selected = selection?.client === client && selection.artifactId === artifactId ? selection.bodyVersion : null;

    React.useEffect(() => {
        let active = true;
        setState(previous => ({ client, artifactId,
            data: previous?.client === client && previous.artifactId === artifactId ? previous.data : null,
            loading: true, failed: false }));
        void client.listRevisions(artifactId).then(outcome => {
            if (!active) return;
            if (!outcome.ok) {
                setState(previous => previous ? { ...previous, loading: false, failed: true } : previous);
                return;
            }
            const revisions = [...outcome.value.revisions].sort((a, b) => b.bodyVersion - a.bodyVersion);
            setState({ client, artifactId, data: { revisions, retentionCount: outcome.value.retentionCount }, loading: false, failed: false });
            const earlier = revisions.filter(revision => revision.bodyVersion !== current);
            setSelection(previous => {
                if (previous?.client === client && previous.artifactId === artifactId
                    && earlier.some(revision => revision.bodyVersion === previous.bodyVersion)) return previous;
                // Opened to compare: the version the reader reviewed leads, on a phone too.
                if (compareFrom !== undefined && earlier.some(revision => revision.bodyVersion === compareFrom))
                    return { client, artifactId, bodyVersion: compareFrom };
                return sideBySideRef.current && earlier[0] ? { client, artifactId, bodyVersion: earlier[0].bodyVersion } : null;
            });
        });
        return () => { active = false; };
    }, [client, artifactId, compareFrom, current, refreshIntent]);

    const restore = React.useCallback(async (bodyVersion: number) => {
        if (!artifact || artifact.bodyVersion === undefined) return;
        setRestoring(true);
        setRestoreFailed(false);
        const outcome = await client.restoreRevision({
            artifactId: props.artifactId,
            bodyVersion,
            expectedRevision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
        });
        if ('approvalId' in outcome) {
            props.onClose();
            if (scope) router.push(`/inbox/approvals/${encodeURIComponent(outcome.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` as never);
            return;
        }
        if (outcome.ok) {
            // The captured Account Action has already published its acknowledged head.
            props.onClose();
            return;
        }
        setRestoring(false);
        setRestoreFailed(true);
    }, [artifact, client, props, router, scope]);

    if (!history?.data && history?.failed) {
        return (
            <View style={styles.root} testID="artifact-history" onLayout={measureBody}>
                <SurfaceStateCard
                    testID="artifact-history:failed"
                    kind="error"
                    title={t('artifacts.browser.history.loadFailed')}
                    action={{ label: t('common.retry'), onPress: requestRefresh }}
                    accessibilitySemantics="alert"
                />
            </View>
        );
    }
    if (!history?.data) {
        // Keep the measured View mounted from loading through content. React Native Web
        // observes layout on mount; attaching onLayout only after the read misses that subscription.
        return <View style={styles.root} testID="artifact-history" onLayout={measureBody}>
            <View style={styles.placeholder}>
                <SurfaceStateCard testID="artifact-history:loading" kind="loading" title={t('common.loading')} accessibilitySemantics="status" />
            </View>
        </View>;
    }

    const currentProvenance = history.data.revisions.find(revision => revision.bodyVersion === current)?.provenance ?? artifact?.provenance;
    const earlier = history.data.revisions.filter((revision) => revision.bodyVersion !== current);
    const chosen = earlier.find((revision) => revision.bodyVersion === selected) ?? (sideBySide ? earlier[0] ?? null : null);
    const versionNumber = (revision: Revision) => revision.bodyVersion;
    const currentBody = history.data.revisions.find(revision => revision.bodyVersion === current)?.body ?? artifact?.body ?? null;
    const compareUnavailableReason = compareFrom === undefined ? null
        : currentBody === null ? 'artifacts.browser.history.compareCurrentUnavailable'
            : !history.data.revisions.some(revision => revision.bodyVersion === compareFrom)
                ? 'artifacts.browser.history.compareReviewedUnavailable' : null;

    const list = (
        <HappierArtifactRevisionList
            sideBySide={sideBySide}
            title={t('artifacts.browser.history.versionsLabel')}
            currentTitle={t('artifacts.browser.history.current')}
            currentSubtitle={artifact ? revisionSubtitle(artifact.updatedAt, currentProvenance, scope?.accountId ?? null) : undefined}
            currentLabel={t('artifacts.browser.history.now')}
            retentionLabel={earlier.length === 0 ? t('artifacts.browser.history.empty') : t('artifacts.browser.history.keeps', { count: history.data.retentionCount })}
            revisions={earlier.map(revision => ({
                bodyVersion: revision.bodyVersion,
                title: t('artifacts.browser.history.version', { n: versionNumber(revision) }),
                subtitle: revisionSubtitle(revision.createdAt, revision.provenance, scope?.accountId ?? null),
                detail: formatHappierDataBytes(revision.sizeBytes, { kind: 'storage' }),
            }))}
            selectedVersion={chosen?.bodyVersion ?? null}
            onSelectVersion={bodyVersion => setSelection({ client, artifactId, bodyVersion })}
            colors={listColors}
            host={sideBySide ? HISTORY_PANE_HOST : HISTORY_LIST_HOST}
        />
    );

    const preview = chosen ? (
        <View style={sideBySide ? [styles.previewColumn, captionInset] : styles.previewStacked} testID="artifact-history:preview">
            {!sideBySide ? (
                <RoundButton
                    testID="artifact-history:versions"
                    size="small"
                    display="inverted"
                    title={t('artifacts.browser.history.versionsLabel')}
                    leading={<Icon name="caret-left" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    // Back to the list leads the column, on the text edge, never centred over the preview.
                    style={styles.backToVersions}
                    onPress={() => setSelection(null)}
                />
            ) : null}
            <Text style={styles.caption}>
                {`${t('artifacts.browser.history.version', { n: versionNumber(chosen) })} · ${formatRelativeTimeShort(chosen.createdAt, Date.now())}`}
            </Text>
            <ScrollView style={styles.previewScroll}>
                {compareFrom !== undefined && !compareUnavailableReason && typeof chosen.body === 'string' && typeof currentBody === 'string'
                    ? <ProseDiffViewer mode="text" testID="artifact-history:changes" oldText={chosen.body} newText={currentBody}
                        prose={{ oldLabel: t('artifacts.browser.history.version', { n: versionNumber(chosen) }), newLabel: t('artifacts.browser.history.now') }} />
                    : typeof chosen.body === 'string' ? <MarkdownView markdown={chosen.body} />
                    : chosen.body ? <ArtifactBinaryBody artifactId={props.artifactId} reference={chosen.body} name={artifact?.title || t('artifacts.untitled')} readBytes={readBinary} scope={client.scope} />
                        : <Text style={styles.caption}>{t('artifacts.noContent')}</Text>}
            </ScrollView>
        </View>
    ) : null;

    return (
        <View style={styles.root} testID="artifact-history" onLayout={measureBody}>
            {history.loading || history.failed ? (
                <SurfaceFreshnessLine
                    testID={history.loading ? 'artifact-history:refreshing' : 'artifact-history:stale'}
                    reason={history.loading ? t('common.loading') : t('artifacts.browser.history.loadFailed')}
                    busy={history.loading}
                    tone={history.failed ? 'warning' : 'neutral'}
                    action={history.failed ? { label: t('common.retry'), onPress: requestRefresh } : undefined}
                />
            ) : null}
            {compareUnavailableReason ? (
                <SurfaceStateCard
                    testID="artifact-history:compare-unavailable"
                    kind="unavailable"
                    layout="inline"
                    replacesContent={false}
                    title={t('artifacts.browser.history.compareUnavailable')}
                    reason={t(compareUnavailableReason)}
                    accessibilitySemantics="status"
                />
            ) : null}
            <View style={sideBySide ? styles.columns : styles.stack}>
                {sideBySide || chosen === null ? list : null}
                {preview}
            </View>
            {chosen && props.canRestore ? (
                <View style={[styles.footer, !sideBySide ? styles.footerStacked : null]}>
                    <Text style={[styles.note, !sideBySide ? styles.noteStacked : null, restoreFailed ? styles.noteFailed : null]}>
                        {restoreFailed ? t('artifacts.browser.history.restoreFailed') : t('artifacts.browser.history.restoreNote')}
                    </Text>
                    <RoundButton
                        testID="artifact-history:restore"
                        size="small"
                        title={t('artifacts.browser.history.restore', { n: versionNumber(chosen) })}
                        leading={<Icon name="arrow-arc-left" size={14} color={theme.colors.button.primary.tint} />}
                        loading={restoring}
                        onPress={() => { void restore(chosen.bodyVersion); }}
                    />
                </View>
            ) : null}
        </View>
    );
}

type HistoryModalProps = CustomModalInjectedProps & HistorySubject;

function ArtifactHistoryModal(props: HistoryModalProps): React.ReactElement {
    return <ArtifactHistoryContent artifactId={props.artifactId} client={props.client} currentArtifact={props.currentArtifact} canRestore={props.canRestore}
        compareFromBodyVersion={props.compareFromBodyVersion} onClose={props.onClose} />;
}

/** `compareFromBodyVersion` opens History on that version, showing its changes up to the current text. */
export function showArtifactHistorySheet(params: Readonly<{
    artifactId: string;
    /** The Doc's title; when the caller has not read it, the one the app already holds. */
    name?: string; canRestore: boolean; compareFromBodyVersion?: number;
    client?: ArtifactActionsClient;
    /** Already admitted through this client's canonical Doc reader, including direct Discussion entry. */
    currentDoc?: CurrentDoc;
}>): void {
    const state = getStorage().getState();
    const client = params.client ?? (state.profileScope ? createArtifactActionsClient(state.profileScope) : null);
    if (!client) return;
    const doc = params.currentDoc?.artifactId === params.artifactId ? params.currentDoc : undefined;
    const currentArtifact: HistoryArtifact | undefined = doc ? {
        id: doc.artifactId, title: typeof doc.header.title === 'string' ? doc.header.title : null,
        headerVersion: doc.revision.headerVersion, bodyVersion: doc.revision.bodyVersion, body: doc.body,
        updatedAt: doc.updatedAt, provenance: doc.provenance, seq: doc.seq, access: doc.access,
    } : areServerAccountScopesEqual(state.profileScope, client.scope) ? state.artifacts[params.artifactId] : undefined;
    Modal.show({
        component: ArtifactHistoryModal,
        props: { artifactId: params.artifactId, client, currentArtifact, canRestore: params.canRestore && currentArtifact?.access !== 'view',
            ...(params.compareFromBodyVersion === undefined ? {} : { compareFromBodyVersion: params.compareFromBodyVersion }) },
        chrome: {
            kind: 'card',
            testID: 'artifact-history-modal',
            title: t('artifacts.browser.history.title'),
            subtitle: params.name ?? currentArtifact?.title ?? t('artifacts.untitled'),
            scrollHost: 'body',
            phonePresentation: 'fullscreen',
            bodyScroll: 'none',
            // A calm dialog in the middle of the window (lab A6), not a sheet that fills it; it keeps this size.
            dimensions: { width: 860, maxHeightRatio: 0.66, size: 'lg' },
        },
        closeOnBackdrop: true,
    });
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        paddingBottom: theme.space.s16,
    },
    columns: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
    },
    stack: {
        flex: 1,
        minHeight: 0,
    },
    previewColumn: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s24,
    },
    previewStacked: {
        flex: 1,
        minHeight: 0,
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s16,
    },
    backToVersions: {
        alignSelf: 'flex-start',
    },
    previewScroll: {
        flex: 1,
    },
    caption: {
        fontSize: 12.5,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: 14,
        marginTop: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.subtle,
    },
    footerStacked: {
        flexDirection: 'column',
        // A wrapping column sizes its line to the widest child (the note), so Restore stopped short of the edge.
        flexWrap: 'nowrap',
        alignItems: 'stretch',
    },
    note: {
        flex: 1,
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    noteStacked: {
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
    },
    noteFailed: {
        color: theme.colors.state.danger.foreground,
    },
    // Loading fills the body like the failure state does, so its state sits where the failure will.
    placeholder: {
        flex: 1,
        minHeight: 360,
    },
}));
