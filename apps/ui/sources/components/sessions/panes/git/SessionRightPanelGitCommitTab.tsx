import * as React from 'react';
import { FlatList, Platform, Pressable, ScrollView, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { SourceControlBranchSummary } from '@/components/sessions/files/SourceControlBranchSummary';
import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { ScmCommitComposerCard } from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';
import { ScmChangeRow } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { Text } from '@/components/ui/text/Text';
import type { ScmFileStatus, ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ChangedFilesViewMode, SessionAttributedFile, SessionAttributionReliability } from '@/scm/scmAttribution';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { filterDirectoryLikeScmFileStatuses } from '@/scm/isDirectoryLikeScmFileStatus';

export type SessionRightPanelGitCommitTabProps = Readonly<{
    theme: any;
    sessionId: string;
    sessionPath: string | null;
    backendLabel: string;
    commitActionLabel: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    hasConflicts: boolean;
    scmOperationBusy: boolean;
    scmOperationStatus: string | null;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;

    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;

    commitDraftMessage: string;
    onCommitDraftMessageChange: (value: string) => void;
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    onClearSelection?: () => void;

    scmStatusFiles: ScmStatusFiles | null;
    showCommitComposer?: boolean;
    onOpenReviewAllChanges?: () => void;
}>;

export const SessionRightPanelGitCommitTab = React.memo((props: SessionRightPanelGitCommitTabProps) => {
    const showCommitComposer = props.showCommitComposer !== false;

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <CommitChangesSurface
                theme={props.theme}
                scmStatusFiles={props.scmStatusFiles}
                scmSnapshot={props.scmSnapshot}
                changedFilesViewMode={props.changedFilesViewMode}
                attributionReliability={props.attributionReliability}
                allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                sessionAttributedFiles={props.sessionAttributedFiles}
                repositoryOnlyFiles={props.repositoryOnlyFiles}
                suppressedInferredCount={props.suppressedInferredCount}
                repositorySelectedCount={props.repositorySelectedCount}
                onSelectAll={props.onSelectAll}
                onSelectNone={props.onSelectNone}
                disableSelectAll={props.disableSelectAll}
                disableSelectNone={props.disableSelectNone}
                onFilePress={props.onFilePress}
                onFilePressPinned={props.onFilePressPinned}
                onToggleSelectionForFile={props.onToggleSelectionForFile}
                renderFileActions={props.renderFileActions}
                renderFileTrailingActions={props.renderFileTrailingActions}
                onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            />
            {showCommitComposer ? (
                <View
                    style={{
                        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderTopColor: props.theme.colors.divider,
                        backgroundColor: props.theme.colors.surface,
                    }}
                >
                    <CommitComposerFooter
                        theme={props.theme}
                        commitActionLabel={props.commitActionLabel}
                        externalDraftMessage={props.commitDraftMessage}
                        onExternalDraftMessageChange={props.onCommitDraftMessageChange}
                        busy={props.scmOperationBusy || props.hasGlobalOperationInFlight}
                        status={props.scmOperationStatus}
                        commitAllowed={props.commitAllowed}
                        commitBlockedMessage={props.commitBlockedMessage}
                        onCommitFromMessage={props.onCommitFromMessage}
                        commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
                        onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
                        selectionCount={props.repositorySelectedCount}
                        onClearSelection={props.onClearSelection}
                        onSelectAllSelection={props.onSelectAll}
                    />
                </View>
            ) : null}
        </View>
    );
});

const CommitComposerFooter = React.memo((props: Readonly<{
    theme: any;
    commitActionLabel: string;
    externalDraftMessage: string;
    onExternalDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    selectionCount: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
}>) => {
    const [localDraftMessage, setLocalDraftMessage] = React.useState(() => String(props.externalDraftMessage ?? ''));
    const dirtyRef = React.useRef(false);

    const debouncedPersist = React.useMemo(() => {
        return createAdvancedDebounce((value: string) => {
            props.onExternalDraftMessageChange(value);
        }, { delay: 350, immediateCount: 0 });
    }, [props.onExternalDraftMessageChange]);

    React.useEffect(() => {
        return () => {
            debouncedPersist.flush();
        };
    }, [debouncedPersist]);

    React.useEffect(() => {
        if (dirtyRef.current) return;
        setLocalDraftMessage(String(props.externalDraftMessage ?? ''));
    }, [props.externalDraftMessage]);

    const onDraftMessageChange = React.useCallback((value: string) => {
        dirtyRef.current = true;
        setLocalDraftMessage(value);
        debouncedPersist.debounced(value);
    }, [debouncedPersist]);

    const onCommitFromMessage = React.useCallback((message: string) => {
        // Persist any pending draft immediately before committing.
        debouncedPersist.flush();
        dirtyRef.current = false;
        props.onCommitFromMessage(message);
    }, [debouncedPersist, props]);

    return (
        <ScmCommitComposerCard
            theme={props.theme}
            commitActionLabel={props.commitActionLabel}
            draftMessage={localDraftMessage}
            onDraftMessageChange={onDraftMessageChange}
            busy={props.busy}
            status={props.status}
            commitAllowed={props.commitAllowed}
            commitBlockedMessage={props.commitBlockedMessage}
            onCommitFromMessage={onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            selectionCount={props.selectionCount}
            onClearSelection={props.onClearSelection}
            onSelectAllSelection={props.onSelectAllSelection}
            variant="railFooter"
        />
    );
});

type CommitChangesSurfaceProps = Readonly<{
    theme: any;
    scmStatusFiles: ScmStatusFiles | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;
    onOpenReviewAllChanges?: () => void;
}>;

const CommitChangesSurface = React.memo((props: CommitChangesSurfaceProps) => {
    const repositoryMode = props.changedFilesViewMode === 'repository';
    const repositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.allRepositoryChangedFiles);
    }, [props.allRepositoryChangedFiles]);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const headerContent = React.useMemo(() => {
        return (
            <>
                {props.scmStatusFiles ? (
                    <SourceControlBranchSummary theme={props.theme} scmStatusFiles={props.scmStatusFiles} variant="rail" />
                ) : null}
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 8,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: props.theme.colors.divider,
                        backgroundColor: props.theme.colors.surfaceHigh,
                        gap: 10,
                    }}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                            {t('files.toolbar.changedFiles')}
                        </Text>
                        <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.mono('semiBold') }}>
                            {String(repositoryChangedFiles.length)}
                        </Text>
                    </View>
                {props.onOpenReviewAllChanges ? (
                    <Pressable
                        testID="session-rightpanel-git-open-review"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.toolbar.review')}
                        onPress={props.onOpenReviewAllChanges}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingHorizontal: 10,
                            height: 30,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: props.theme.colors.divider,
                            backgroundColor: props.theme.colors.surface,
                            opacity: pressed ? 0.78 : 1,
                            gap: 6,
                        })}
                    >
                        <Octicons name="diff" size={14} color={props.theme.colors.textSecondary} />
                        <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            {t('files.toolbar.review')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            </>
        );
    }, [
        repositoryChangedFiles.length,
        props.onOpenReviewAllChanges,
        props.scmStatusFiles,
        props.theme,
    ]);

    const renderRepositoryRow = React.useCallback(({ item: file, index }: { item: ScmFileStatus; index: number }) => {
        return (
            <ScmChangeRow
                theme={props.theme}
                file={file}
                density="compact"
                leadingElement={props.renderFileActions ? props.renderFileActions(file) : null}
                trailingElement={props.renderFileTrailingActions ? props.renderFileTrailingActions(file) : null}
                onPress={() => props.onFilePress(file)}
                onPressPinned={() => props.onFilePressPinned(file)}
                onToggleSelection={props.onToggleSelectionForFile ? () => props.onToggleSelectionForFile(file) : undefined}
                showDivider={index < repositoryChangedFiles.length - 1}
            />
        );
    }, [
        props.onFilePress,
        props.onFilePressPinned,
        props.onToggleSelectionForFile,
        props.renderFileActions,
        props.renderFileTrailingActions,
        props.theme,
        repositoryChangedFiles.length,
    ]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            {repositoryMode ? (
                <FlatList
                    data={repositoryChangedFiles}
                    keyExtractor={(file) => `repo-all-${file.fullPath}`}
                    ListHeaderComponent={headerContent}
                    contentContainerStyle={{ paddingBottom: 12 }}
                    renderItem={renderRepositoryRow}
                    initialNumToRender={Math.min(24, repositoryChangedFiles.length)}
                    maxToRenderPerBatch={24}
                    windowSize={7}
                    removeClippedSubviews={Platform.OS !== 'web'}
                    onLayout={scrollFades.onViewportLayout}
                    onContentSizeChange={scrollFades.onContentSizeChange}
                    onScroll={scrollFades.onScroll}
                    scrollEventThrottle={16}
                    getItemLayout={
                        Platform.OS === 'web'
                            ? (_, index) => {
                                // ScmChangeRow in compact density is effectively fixed-height on web.
                                // Providing a layout hint improves RN-web VirtualizedList performance with large diffs.
                                const length = 38;
                                return { length, offset: length * index, index };
                            }
                            : undefined
                    }
                />
            ) : (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ paddingBottom: 12 }}
                    onLayout={scrollFades.onViewportLayout}
                    onContentSizeChange={scrollFades.onContentSizeChange}
                    onScroll={scrollFades.onScroll}
                    scrollEventThrottle={16}
                >
                    {headerContent}
                    <ChangedFilesList
                        theme={props.theme}
                        changedFilesViewMode={props.changedFilesViewMode}
                        attributionReliability={props.attributionReliability}
                        allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                        sessionAttributedFiles={props.sessionAttributedFiles}
                        repositoryOnlyFiles={props.repositoryOnlyFiles}
                        suppressedInferredCount={props.suppressedInferredCount}
                        onFilePress={(file) => props.onFilePress(file)}
                        onFilePressPinned={(file) => props.onFilePressPinned(file)}
                        onToggleSelectionForFile={props.onToggleSelectionForFile}
                        renderFileActions={props.renderFileActions}
                        renderFileTrailingActions={props.renderFileTrailingActions}
                        rowDensity="compact"
                    />
                </ScrollView>
            )}

            <ScrollEdgeFades
                color={props.theme.colors.surface}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.textSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
