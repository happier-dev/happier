import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import { useSaveWorkspaceFileAsArtifact } from './useSaveWorkspaceFileAsArtifact';

export type SaveFileAsArtifactDialogProps = CustomModalInjectedProps & Readonly<{
    source: Parameters<typeof useSaveWorkspaceFileAsArtifact>[0];
    /** Where the copy comes from, in one quiet line ("docs › specs · 1.8 MB · from MacBook Pro"). */
    sourceFacts: string;
    /** Opens the created Artifact. */
    onOpenArtifact?: (artifactId: string) => void;
}>;

/**
 * Save as Artifact… (lab AD1s): the crossing from a file to an Artifact is an explicit copy, so the
 * consequence is said first, the title is the file's name until changed, and Only you is the default.
 */
/** The one way Save as Artifact… opens, for a file page and for a folder row alike. */
export function openSaveFileAsArtifactDialog(props: Omit<SaveFileAsArtifactDialogProps, keyof CustomModalInjectedProps>): void {
    Modal.show({ component: SaveFileAsArtifactDialog, props });
}

export function SaveFileAsArtifactDialog(props: SaveFileAsArtifactDialogProps) {
    const { theme } = useUnistyles();
    const model = useSaveWorkspaceFileAsArtifact(props.source);
    // Mounting the dialog is opening it: the model's mounted Action execution binds while it is open.
    const opened = React.useRef(false);
    React.useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        model.open();
    });
    const fileName = props.source.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? props.source.filePath;
    const status = model.status;
    // Once the copy exists it can be opened, even when sharing it with the Team then failed or waits for approval.
    const savedId = model.receipt?.artifactId ?? null;
    const close = () => { model.dismiss(); props.onClose(); };
    const submit = async () => {
        const artifactId = await model.submit();
        if (artifactId && props.onOpenArtifact) {
            props.onClose();
            props.onOpenArtifact(artifactId);
        }
    };
    // Who can see it: the source's Team when it has one. While that is read the choice keeps its place with
    // Only you; when it can't be read the copy stays private and the line says why (never a guessed Team).
    const audience = model.team ? [
        { id: 'private' as const, label: t('files.pane.page.artifactOnlyYou') },
        { id: 'team' as const, label: model.team.name },
    ] : model.audienceLoading || model.audienceUnavailable ? [
        { id: 'private' as const, label: t('files.pane.page.artifactOnlyYou') },
    ] : null;
    const shareFailed = status.kind === 'failed' && status.receipt !== undefined && model.team !== null;
    const statusLine = shareFailed && model.team ? t('files.pane.page.artifactShareFailed', { team: model.team.name })
        : status.kind === 'failed' ? t('files.pane.page.artifactFailed')
        : status.kind === 'approval' ? t('files.pane.page.artifactApproval') : null;
    return (
        <ModalCardFrame
            testID="save-as-artifact-dialog"
            title={t('files.pane.page.artifactTitle')}
            subtitle={model.folder ? t('files.pane.page.artifactFolderDescription') : t('files.pane.page.artifactDescription')}
            onClose={close}
            dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, size: 'dialog' }}
            footer={(
                <View style={styles.footer}>
                    {statusLine ? <Text testID="save-as-artifact-status" style={[styles.status, status.kind === 'failed' ? { color: theme.colors.state.danger.foreground } : null]}>{statusLine}</Text> : null}
                    <RoundButton testID="save-as-artifact-cancel" display="inverted" title={t('common.cancel')} onPress={close} />
                    {savedId && props.onOpenArtifact ? (
                        // The copy exists: Open it; when only sharing failed, sharing again is the one primary.
                        <RoundButton testID="save-as-artifact-open" title={t('files.pane.page.artifactOpen')}
                            display={shareFailed ? 'inverted' : undefined}
                            onPress={() => { props.onClose(); props.onOpenArtifact?.(savedId); }} />
                    ) : null}
                    {shareFailed ? (
                        <RoundButton testID="save-as-artifact-retry-share" title={t('common.retry')}
                            disabled={!model.canSubmit} loading={model.busy} onPress={() => { void submit(); }} />
                    ) : savedId && props.onOpenArtifact ? null : (
                        <RoundButton testID="save-as-artifact-save" title={t('files.pane.page.artifactSave')}
                            disabled={!model.canSubmit} loading={model.busy} onPress={() => { void submit(); }} />
                    )}
                </View>
            )}
        >
            <View style={styles.body}>
                <View testID="save-as-artifact-source" style={[styles.source, { backgroundColor: theme.colors.surface.inset }]}>
                    {model.folder ? <Icon name="folder" size={20} color={theme.colors.text.secondary} />
                        : <FileIcon fileName={fileName} size={20} appearance="line" />}
                    <View style={styles.sourceText}>
                        <Text style={styles.sourceName} numberOfLines={1}>{fileName}</Text>
                        {props.sourceFacts ? <Text style={styles.sourceFacts} numberOfLines={1}>{props.sourceFacts}</Text> : null}
                    </View>
                </View>
                <View style={styles.field}>
                    <Text nativeID="save-as-artifact-title-label" style={styles.label}>{t('files.pane.page.artifactTitleLabel')}</Text>
                    <FieldTextInput testID="save-as-artifact-title" value={model.title} onChangeText={model.setTitle}
                        accessibilityLabel={t('files.pane.page.artifactTitleLabel')}
                        accessibilityLabelledBy="save-as-artifact-title-label" editable={model.canEditFields}
                        returnKeyType="done" onSubmitEditing={() => { void submit(); }} />
                </View>
                {model.folder ? (
                    // A folder publishes the page it opens with and every file beside it, as one HTML Artifact.
                    <View style={styles.field}>
                        <Text nativeID="save-as-artifact-entrypoint-label" style={styles.label}>{t('files.pane.page.artifactEntrypointLabel')}</Text>
                        <FieldTextInput testID="save-as-artifact-entrypoint" value={model.entrypoint} onChangeText={model.setEntrypoint}
                            accessibilityLabel={t('files.pane.page.artifactEntrypointLabel')}
                            accessibilityLabelledBy="save-as-artifact-entrypoint-label" editable={model.canEditFields}
                            returnKeyType="done" onSubmitEditing={() => { void submit(); }} />
                    </View>
                ) : null}
                {audience ? (
                    <View style={styles.field}>
                        <Text style={styles.label}>{t('files.pane.page.artifactAudience')}</Text>
                        <SegmentedTabBar
                            testIDPrefix="save-as-artifact-audience"
                            role="radiogroup"
                            accessibilityLabel={t('files.pane.page.artifactAudience')}
                            tabs={audience}
                            activeTabId={model.visibility}
                            onSelectTab={model.setVisibility}
                            segmentSizing="content"
                        />
                        {model.audienceUnavailable && !model.team ? (
                            <Text testID="save-as-artifact-audience-unavailable" style={styles.hint}>{t('files.pane.page.artifactAudienceUnavailable')}</Text>
                        ) : null}
                    </View>
                ) : null}
            </View>
        </ModalCardFrame>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s4,
        gap: theme.space.s16,
    },
    source: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    },
    sourceText: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    sourceName: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.primary,
    },
    sourceFacts: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    field: {
        gap: theme.space.s6,
    },
    label: {
        ...Typography.variant('label'),
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
    hint: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    status: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
    },
}));
