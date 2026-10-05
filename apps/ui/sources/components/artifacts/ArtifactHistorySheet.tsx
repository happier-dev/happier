import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierArtifactRevisionList, type HappierArtifactRevisionListProps } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { storage, useArtifact } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

import { useArtifactActionsClient } from './artifactActionsClient';
import type { ArtifactBodyV1 } from '@happier-dev/protocol';
import { ArtifactBinaryBody } from './ArtifactBinaryBody';

type Revision = Readonly<{ bodyVersion: number; body: ArtifactBodyV1 | null; createdAt: number; sizeBytes: number }>;

type HistoryState =
    | Readonly<{ phase: 'loading' }>
    | Readonly<{ phase: 'ready'; revisions: readonly Revision[]; retentionCount: number }>
    | Readonly<{ phase: 'failed' }>;

/** Two columns (versions beside the preview) from this width; narrower, the preview replaces the list. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 640;

function ArtifactHistoryItemGroup(props: React.ComponentProps<HappierArtifactRevisionListProps['host']['ItemGroup']>) {
    return <ItemGroup title={props.title} children={props.children} />;
}

/**
 * An artifact's History (lab A6): earlier versions newest first → preview → Restore. Restore is the one
 * primary action and adds the chosen body as a new version; history is never rewritten (ART-A1).
 */
function ArtifactHistoryContent(props: Readonly<{ artifactId: string; canRestore: boolean; onClose: () => void }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const client = useArtifactActionsClient();
    const artifact = useArtifact(props.artifactId);
    const { width } = useWindowDimensions();
    const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const [state, setState] = React.useState<HistoryState>({ phase: 'loading' });
    const [selected, setSelected] = React.useState<number | null>(null);
    const [restoring, setRestoring] = React.useState(false);
    const [restoreFailed, setRestoreFailed] = React.useState(false);

    const load = React.useCallback(async () => {
        if (!client) return;
        setState({ phase: 'loading' });
        const outcome = await client.listRevisions(props.artifactId);
        if (!outcome.ok) { setState({ phase: 'failed' }); return; }
        const revisions = [...outcome.value.revisions].sort((a, b) => b.bodyVersion - a.bodyVersion);
        setState({ phase: 'ready', revisions, retentionCount: outcome.value.retentionCount });
        if (sideBySide && revisions[0]) setSelected(revisions[0].bodyVersion);
    }, [client, props.artifactId, sideBySide]);
    React.useEffect(() => { void load(); }, [load]);

    const restore = React.useCallback(async (bodyVersion: number) => {
        if (!client || !artifact || artifact.bodyVersion === undefined) return;
        setRestoring(true);
        setRestoreFailed(false);
        const outcome = await client.restoreRevision({
            artifactId: props.artifactId,
            bodyVersion,
            expectedRevision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
        });
        if (outcome.ok) {
            const full = await sync.fetchArtifactWithBody(props.artifactId).catch(() => null);
            if (full) storage.getState().updateArtifact(full);
            props.onClose();
            return;
        }
        setRestoring(false);
        setRestoreFailed(true);
    }, [artifact, client, props]);

    if (state.phase === 'loading' || client === null) {
        return <View style={styles.placeholder} testID="artifact-history:loading" />;
    }
    if (state.phase === 'failed') {
        return (
            <SurfaceStateCard
                testID="artifact-history:failed"
                kind="error"
                title={t('artifacts.browser.history.loadFailed')}
                action={{ label: t('common.retry'), onPress: load }}
                accessibilitySemantics="alert"
            />
        );
    }

    const current = artifact?.bodyVersion;
    const earlier = state.revisions.filter((revision) => revision.bodyVersion !== current);
    const chosen = earlier.find((revision) => revision.bodyVersion === selected) ?? null;
    const versionNumber = (revision: Revision) => revision.bodyVersion;

    const list = (
        <HappierArtifactRevisionList
            sideBySide={sideBySide}
            title={t('artifacts.browser.history.versionsLabel')}
            currentTitle={t('artifacts.browser.history.current')}
            currentSubtitle={artifact ? formatRelativeTimeShort(artifact.updatedAt, Date.now()) : undefined}
            currentLabel={t('artifacts.browser.history.now')}
            retentionLabel={earlier.length === 0 ? t('artifacts.browser.history.empty') : t('artifacts.browser.history.keeps', { count: state.retentionCount })}
            revisions={earlier.map(revision => ({
                bodyVersion: revision.bodyVersion,
                title: t('artifacts.browser.history.version', { n: versionNumber(revision) }),
                subtitle: formatRelativeTimeShort(revision.createdAt, Date.now()),
                detail: formatByteSize(revision.sizeBytes),
            }))}
            selectedVersion={selected}
            onSelectVersion={setSelected}
            colors={{ secondary: theme.colors.text.secondary, tertiary: theme.colors.text.tertiary }}
            host={{ Item, ItemGroup: ArtifactHistoryItemGroup, Text }}
        />
    );

    const preview = chosen ? (
        <View style={sideBySide ? styles.previewColumn : styles.previewStacked} testID="artifact-history:preview">
            {!sideBySide ? (
                <RoundButton
                    size="small"
                    display="inverted"
                    title={t('artifacts.browser.history.versionsLabel')}
                    leading={<Icon name="caret-left" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    onPress={() => setSelected(null)}
                />
            ) : null}
            <Text style={styles.caption}>
                {`${t('artifacts.browser.history.version', { n: versionNumber(chosen) })} · ${formatRelativeTimeShort(chosen.createdAt, Date.now())}`}
            </Text>
            <ScrollView style={styles.previewScroll}>
                {typeof chosen.body === 'string' ? <MarkdownView markdown={chosen.body} />
                    : chosen.body ? <ArtifactBinaryBody artifactId={props.artifactId} reference={chosen.body} name={artifact?.title || t('artifacts.untitled')} readBytes={sync.fetchArtifactBinary} />
                        : <Text style={styles.caption}>{t('artifacts.noContent')}</Text>}
            </ScrollView>
        </View>
    ) : null;

    return (
        <View style={styles.root} testID="artifact-history">
            <View style={sideBySide ? styles.columns : styles.stack}>
                {sideBySide || chosen === null ? list : null}
                {preview}
            </View>
            {chosen && props.canRestore ? (
                <View style={styles.footer}>
                    <Text style={[styles.note, restoreFailed ? styles.noteFailed : null]}>
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

type HistoryModalProps = CustomModalInjectedProps & Readonly<{ artifactId: string; canRestore: boolean }>;

function ArtifactHistoryModal(props: HistoryModalProps): React.ReactElement {
    return <ArtifactHistoryContent artifactId={props.artifactId} canRestore={props.canRestore} onClose={props.onClose} />;
}

export function showArtifactHistorySheet(params: Readonly<{ artifactId: string; name: string; canRestore: boolean }>): void {
    Modal.show({
        component: ArtifactHistoryModal,
        props: { artifactId: params.artifactId, canRestore: params.canRestore },
        chrome: {
            kind: 'card',
            testID: 'artifact-history-modal',
            title: t('artifacts.browser.history.title'),
            subtitle: params.name,
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 860, maxHeightRatio: 0.86, size: 'lg' },
        },
        closeOnBackdrop: true,
    });
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 360,
    },
    columns: {
        flex: 1,
        flexDirection: 'row',
        gap: 24,
    },
    stack: {
        flex: 1,
    },
    previewColumn: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    previewStacked: {
        flex: 1,
        gap: 10,
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
        alignItems: 'center',
        gap: 12,
        paddingTop: 14,
        marginTop: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.subtle,
    },
    note: {
        flex: 1,
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    noteFailed: {
        color: theme.colors.state.danger.foreground,
    },
    placeholder: {
        minHeight: 360,
    },
}));
