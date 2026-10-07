import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemList } from '@/components/ui/lists/ItemList';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';
import type { ArtifactViewRead } from '@/sync/engine/artifacts/syncArtifacts';
import { t } from '@/text';

import {
    artifactViewRoute,
    classifyArtifactBrowserKind,
    readArtifactCodeLanguage,
    readArtifactProvenance,
} from './artifactBrowserModel';
import { ARTIFACT_KIND_ICONS, artifactKindLabel } from './artifactKindPresentation';
import { ArtifactProvenanceLabel } from './ArtifactProvenance';
import { useArtifactOperations } from './useArtifactOperations';
import { useArtifactBody } from './useArtifactBody';
import { ArtifactBinaryBody } from './ArtifactBinaryBody';
import { ArtifactHtmlBody } from './ArtifactHtmlBody';

function bodyMarkdown(artifact: DecryptedArtifact): string | null {
    const body = artifact.body;
    if (typeof body !== 'string' || body.length === 0) return null;
    const language = readArtifactCodeLanguage(artifact);
    // A code document renders through the one Markdown code-block owner, never a second highlighter.
    return language ? `\`\`\`${language.toLowerCase()}\n${body}\n\`\`\`` : body;
}

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
}>): React.ReactElement {
    const { artifact } = props;
    const body = useArtifactBody(props.artifactId, artifact);
    const styles = stylesheet;

    if (artifact === null) {
        return (
            <SurfaceStateCard
                testID="artifact:notFound"
                kind="empty"
                title={t('artifacts.notFound')}
                reason={t('shareSheet.documents.errors.notFound')}
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

    const content = body.state === 'failed' ? (
        <SurfaceStateCard
            testID="artifact:bodyFailed"
            kind="error"
            title={t('artifacts.error')}
            reason={t('artifacts.browser.loadFailedBody')}
            action={{ label: t('common.retry'), onPress: body.retry }}
            accessibilitySemantics="alert"
        />
    ) : body.state === 'loading' ? (
        <View style={styles.bodyPlaceholder} testID="artifact:bodyLoading" />
    ) : (
        <ArtifactBody artifact={body.result?.artifact ?? artifact} prepared={body.result} onRetry={body.retry} />
    );

    if (props.presentation === 'pane') {
        return (
            <ItemList testID="artifact:pane">
                <View style={styles.paneColumn}>
                    <ArtifactFacts artifact={artifact} />
                    <ArtifactActions artifact={artifact} presentation="pane" onDeleted={props.onDeleted} />
                    <View style={styles.paneRule} />
                    {content}
                </View>
            </ItemList>
        );
    }
    return (
        <ItemList testID="artifact:page">
            <ArtifactPageHeader artifact={artifact} onDeleted={props.onDeleted} />
            <View style={styles.pageBody}>{content}</View>
        </ItemList>
    );
}

function ArtifactBody(props: Readonly<{ artifact: DecryptedArtifact; prepared: ArtifactViewRead | null; onRetry: () => void }>) {
    if (isArtifactHtmlHeaderV1(props.artifact.rawHeader ?? props.artifact.header)) return <ArtifactHtmlBody
        artifactId={props.artifact.id} headerVersion={props.artifact.headerVersion} bodyVersion={props.artifact.bodyVersion}
        body={props.artifact.body} name={props.artifact.title || t('artifacts.untitled')} readPreviewUrl={sync.fetchArtifactHtmlPreview}
        previewUrl={props.prepared?.htmlPreviewUrl} onRetry={props.onRetry} />;
    if (props.artifact.body !== null && typeof props.artifact.body === 'object') return <ArtifactBinaryBody
        artifactId={props.artifact.id} reference={props.artifact.body} name={props.artifact.title || t('artifacts.untitled')} readBytes={sync.fetchArtifactBinary}
        initialBytes={props.prepared?.binaryBytes} onRetry={props.onRetry} />;
    const markdown = bodyMarkdown(props.artifact);
    if (markdown === null) return <Text style={stylesheet.noContent}>{t('artifacts.noContent')}</Text>;
    return <MarkdownView testID="artifact:body" markdown={markdown} />;
}

function readFacts(artifact: DecryptedArtifact): readonly PageHeaderMetaFact[] {
    const kind = classifyArtifactBrowserKind(artifact) ?? 'document';
    const language = readArtifactCodeLanguage(artifact);
    return [
        { key: 'kind', text: language ?? artifactKindLabel(kind), icon: ARTIFACT_KIND_ICONS[kind] },
        { key: 'edited', text: t('artifacts.browser.facts.edited', { age: formatRelativeTimeShort(artifact.updatedAt, Date.now()) }) },
    ];
}

/** The pane's identity line: where it came from, then its kind and age (the pane band holds the title). */
function ArtifactFacts(props: Readonly<{ artifact: DecryptedArtifact }>) {
    const styles = stylesheet;
    const facts = readFacts(props.artifact);
    return (
        <View style={styles.facts}>
            <ArtifactProvenanceLabel
                provenance={readArtifactProvenance(props.artifact)}
                fallback={props.artifact.access && props.artifact.access !== 'owner' ? t('artifacts.browser.provenance.sharedWithYou') : t('artifacts.browser.provenance.savedByYou')}
                presentation="chip"
                testID="artifact:provenance"
            />
            <Text style={styles.factLine}>{facts.map((fact) => fact.text).join(' · ')}</Text>
        </View>
    );
}

function ArtifactPageHeader(props: Readonly<{ artifact: DecryptedArtifact; onDeleted?: () => void }>) {
    const { theme } = useUnistyles();
    const kind = classifyArtifactBrowserKind(props.artifact) ?? 'document';
    return (
        <PageHeader
            testID="artifact:header"
            title={props.artifact.title || t('artifacts.untitled')}
            alwaysShowTitle
            leading={(
                <PageHeaderMarkSlot>
                    <Icon name={ARTIFACT_KIND_ICONS[kind]} size={24} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
            meta={readFacts(props.artifact)}
            details={(
                <View style={stylesheet.headerDetails}>
                    <ArtifactProvenanceLabel
                        provenance={readArtifactProvenance(props.artifact)}
                        fallback={props.artifact.access && props.artifact.access !== 'owner' ? t('artifacts.browser.provenance.sharedWithYou') : t('artifacts.browser.provenance.savedByYou')}
                        presentation="chip"
                        testID="artifact:provenance"
                    />
                </View>
            )}
            actions={<ArtifactActions artifact={props.artifact} presentation="page" onDeleted={props.onDeleted} />}
        />
    );
}

/** Edit and History quiet, Share bordered, rare operations (Delete) behind ⋯ — in the pane and on the page. */
function ArtifactActions(props: Readonly<{ artifact: DecryptedArtifact; presentation: 'pane' | 'page'; onDeleted?: () => void }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const { artifact } = props;
    const { canEdit, canManage, canShare, deleting, remove, history, share } = useArtifactOperations(artifact, props.onDeleted ?? router.back);
    const menu: PageHeaderMenuAction[] = canManage ? [
        { id: 'delete', title: t('artifacts.delete'), destructive: true, loading: deleting, testID: 'artifact:delete', onSelect: remove },
    ] : [];
    return (
        <View style={[styles.actions, props.presentation === 'pane' ? styles.paneActions : null]} testID="artifact:actions">
            {canEdit && (artifact.body === undefined || artifact.body === null || typeof artifact.body === 'string') ? (
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
            <RoundButton
                testID="artifact:history"
                size="small"
                display="inverted"
                title={t('artifacts.browser.actions.history')}
                leading={<Icon name="clock-counter-clockwise" size={14} color={theme.colors.text.secondary} />}
                textStyle={{ color: theme.colors.text.secondary }}
                onPress={history}
            />
            {canShare ? (
                <RoundButton
                    testID="artifact:share"
                    size="small"
                    display="secondary"
                    title={t('artifacts.browser.actions.share')}
                    leading={<Icon name="share" size={14} color={theme.colors.text.primary} />}
                    onPress={share}
                />
            ) : null}
            {menu.length > 0 ? <PageHeaderMenu testID="artifact:more" actions={menu} /> : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    paneColumn: {
        paddingHorizontal: 24,
        paddingTop: 4,
        paddingBottom: 32,
    },
    facts: {
        gap: 8,
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
        gap: 6,
    },
    paneActions: {
        marginTop: 14,
    },
    paneRule: {
        height: 1,
        backgroundColor: theme.colors.border.subtle,
        marginTop: 14,
        marginBottom: 16,
    },
    headerDetails: {
        marginTop: 10,
    },
    pageBody: {
        marginTop: 8,
    },
    bodyPlaceholder: {
        minHeight: 160,
    },
    noContent: {
        fontSize: 14,
        color: theme.colors.text.tertiary,
    },
}));
