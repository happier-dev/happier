import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ChangedFilesSectionHeader } from '@/components/workspaces/scm/review/ChangedFilesSectionHeader';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import type { RepositoryCheckpointTurnMetadata } from '@happier-dev/protocol';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: RepositoryCheckpointTurnMetadata | null;
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned?: (file: ScmFileStatus) => void;
    onToggleSelectionForFile?: (file: ScmFileStatus) => void;
    renderFileActions?: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions?: (file: ScmFileStatus) => React.ReactNode;
    rowDensity?: 'comfortable' | 'compact';
    showSectionHeader?: boolean;
};

function resolveCheckpointAttributionCopy(metadata: RepositoryCheckpointTurnMetadata | null | undefined): string | null {
    if (!metadata) return null;
    if (metadata.contentConfidence === 'unavailable') return t('files.checkpointUnavailable');
    if (metadata.attributionScope === 'shared_worktree') return t('files.checkpointAttributionShared');
    return t('files.checkpointAttributionUnknown');
}

export function ChangedFilesList({
    theme,
    changedFilesViewMode,
    attributionReliability,
    allRepositoryChangedFiles,
    turnAttributedFiles = [],
    turnAgentReportedFiles = [],
    turnCheckpointFiles = [],
    turnCheckpointMetadata = null,
    sessionAttributedFiles,
    suppressedInferredCount,
    onFilePress,
    onFilePressPinned,
    onToggleSelectionForFile,
    renderFileActions,
    renderFileTrailingActions,
    rowDensity = 'comfortable',
    showSectionHeader = true,
}: ChangedFilesListProps) {
    const repositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(allRepositoryChangedFiles);
    }, [allRepositoryChangedFiles]);

    const filteredSessionAttributedFiles = React.useMemo(() => {
        return sessionAttributedFiles.filter((entry) => {
            if (!entry?.file) return false;
            return !isDirectoryLikeScmFileStatus(entry.file);
        });
    }, [sessionAttributedFiles]);

    const filteredTurnAttributedFiles = React.useMemo(() => {
        return turnAttributedFiles.filter((entry) => {
            if (!entry?.file) return false;
            return !isDirectoryLikeScmFileStatus(entry.file);
        });
    }, [turnAttributedFiles]);
    const filteredTurnAgentReportedFiles = React.useMemo(() => {
        return turnAgentReportedFiles.filter((entry) => {
            if (!entry?.file) return false;
            return !isDirectoryLikeScmFileStatus(entry.file);
        });
    }, [turnAgentReportedFiles]);
    const filteredTurnCheckpointFiles = React.useMemo(() => {
        return turnCheckpointFiles.filter((entry) => {
            if (!entry?.file) return false;
            return !isDirectoryLikeScmFileStatus(entry.file);
        });
    }, [turnCheckpointFiles]);
    const repositoryStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(repositoryChangedFiles),
        [repositoryChangedFiles],
    );
    const turnStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(filteredTurnAttributedFiles.map((entry) => entry.file)),
        [filteredTurnAttributedFiles],
    );
    const agentReportedTurnStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(filteredTurnAgentReportedFiles.map((entry) => entry.file)),
        [filteredTurnAgentReportedFiles],
    );
    const checkpointTurnStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(filteredTurnCheckpointFiles.map((entry) => entry.file)),
        [filteredTurnCheckpointFiles],
    );
    const sessionStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(filteredSessionAttributedFiles.map((entry) => entry.file)),
        [filteredSessionAttributedFiles],
    );

    if (changedFilesViewMode === 'repository') {
        return (
            <>
                {showSectionHeader ? (
                    <ChangedFilesSectionHeader theme={theme} color={theme.colors.text.secondary}>
                        {t('files.repositoryChangedFiles', { count: repositoryChangedFiles.length })}
                    </ChangedFilesSectionHeader>
                ) : null}
                {repositoryChangedFiles.map((file, index) => (
                    <ScmChangeRow
                        key={`repo-all-${file.fullPath}-${index}`}
                        theme={theme}
                        file={file}
                        density={rowDensity}
                        leadingElement={renderFileActions ? renderFileActions(file) : null}
                        trailingElement={renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                        onPress={() => onFilePress(file)}
                        onPressPinned={onFilePressPinned ? () => onFilePressPinned(file) : undefined}
                        onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(file) : undefined}
                        statsColumnWidth={repositoryStatsColumnWidth}
                        showDivider={index < repositoryChangedFiles.length - 1}
                    />
                ))}
            </>
        );
    }

    if (changedFilesViewMode === 'turn') {
        return (
            <>
                {showSectionHeader ? (
                    <View
                        style={{
                            backgroundColor: theme.colors.surface.inset,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text
                            style={{
                                fontSize: 14,
                                color: theme.colors.text.primary,
                                ...Typography.default('semiBold'),
                            }}
                        >
                            {t('files.latestTurnChanges', { count: filteredTurnAttributedFiles.length })}
                        </Text>
                        <Text
                            style={{
                                marginTop: 4,
                                fontSize: 12,
                                color: theme.colors.text.secondary,
                                ...Typography.default(),
                            }}
                        >
                            {resolveCheckpointAttributionCopy(turnCheckpointMetadata) ?? t('files.latestTurnDescription')}
                        </Text>
                    </View>
                ) : null}

                {filteredTurnAttributedFiles.length === 0 ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                            {t('files.noLatestTurnChanges')}
                        </Text>
                    </View>
                ) : (
                    filteredTurnAttributedFiles.map((entry, index) => (
                        <ScmChangeRow
                            key={`turn-${entry.file.fullPath}-${index}`}
                            theme={theme}
                            file={entry.file}
                            density={rowDensity}
                            leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                            trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                            onPress={() => onFilePress(entry.file)}
                            onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                            onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                            statsColumnWidth={turnStatsColumnWidth}
                            showDivider={index < filteredTurnAttributedFiles.length - 1}
                        />
                    ))
                )}

            </>
        );
    }

    if (changedFilesViewMode === 'turn_agent_reported' || changedFilesViewMode === 'turn_checkpoint') {
        const isCheckpointMode = changedFilesViewMode === 'turn_checkpoint';
        const files = isCheckpointMode ? filteredTurnCheckpointFiles : filteredTurnAgentReportedFiles;
        const statsColumnWidth = isCheckpointMode ? checkpointTurnStatsColumnWidth : agentReportedTurnStatsColumnWidth;
        const checkpointUnavailable = isCheckpointMode && turnCheckpointMetadata?.contentConfidence === 'unavailable';
        return (
            <>
                {showSectionHeader ? (
                    <View
                        style={{
                            backgroundColor: theme.colors.surface.inset,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text
                            style={{
                                fontSize: 14,
                                color: theme.colors.text.primary,
                                ...Typography.default('semiBold'),
                            }}
                        >
                            {isCheckpointMode
                                ? t('files.checkpointTurnChanges', { count: files.length })
                                : t('files.agentReportedTurnChanges', { count: files.length })}
                        </Text>
                        <Text
                            style={{
                                marginTop: 4,
                                fontSize: 12,
                                color: theme.colors.text.secondary,
                                ...Typography.default(),
                            }}
                        >
                            {isCheckpointMode
                                ? resolveCheckpointAttributionCopy(turnCheckpointMetadata)
                                : t('files.agentReportedTurnDescription')}
                        </Text>
                    </View>
                ) : null}

                {files.length === 0 && !checkpointUnavailable ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                            {isCheckpointMode ? t('files.noCheckpointTurnChanges') : t('files.noAgentReportedTurnChanges')}
                        </Text>
                    </View>
                ) : files.length > 0 ? (
                    files.map((entry, index) => (
                        <ScmChangeRow
                            key={`${isCheckpointMode ? 'turn-checkpoint' : 'turn-agent'}-${entry.file.fullPath}-${index}`}
                            theme={theme}
                            file={entry.file}
                            density={rowDensity}
                            leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                            trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                            onPress={() => onFilePress(entry.file)}
                            onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                            onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                            statsColumnWidth={statsColumnWidth}
                            showDivider={index < files.length - 1}
                        />
                    ))
                ) : null}
            </>
        );
    }

    return (
        <>
            {showSectionHeader ? (
                <View
                    style={{
                        backgroundColor: theme.colors.surface.inset,
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: theme.colors.border.default,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 14,
                            color: theme.colors.text.primary,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        {t('files.sessionAttributedChanges', { count: sessionAttributedFiles.length })}
                    </Text>
                    <Text
                        style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: theme.colors.text.secondary,
                            ...Typography.default(),
                        }}
                    >
                        {attributionReliability === 'high'
                            ? t('files.attributionReliabilityHigh')
                            : t('files.attributionReliabilityLimited')}
                    </Text>
                    <Text
                        style={{
                            marginTop: 2,
                            fontSize: 11,
                            color: theme.colors.text.secondary,
                            ...Typography.default(),
                        }}
                    >
                        {attributionReliability === 'high'
                            ? t('files.attributionLegendFull')
                            : t('files.attributionLegendDirectOnly')}
                    </Text>
                    {suppressedInferredCount > 0 && (
                        <Text
                            style={{
                                marginTop: 2,
                                fontSize: 11,
                                color: theme.colors.text.secondary,
                                ...Typography.default(),
                            }}
                        >
                            {t('files.inferredSuppressed', { count: suppressedInferredCount })}
                        </Text>
                    )}
                </View>
            ) : null}

            {filteredSessionAttributedFiles.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                        {t('files.noSessionAttributedChanges')}
                    </Text>
                </View>
            ) : (
                filteredSessionAttributedFiles.map((entry, index) => (
                    <ScmChangeRow
                        key={`session-${entry.file.fullPath}-${index}`}
                        theme={theme}
                        file={entry.file}
                        density={rowDensity}
                        leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                        trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                        onPress={() => onFilePress(entry.file)}
                        onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                        onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                        statsColumnWidth={sessionStatsColumnWidth}
                        showDivider={index < filteredSessionAttributedFiles.length - 1}
                    />
                ))
            )}
        </>
    );
}
