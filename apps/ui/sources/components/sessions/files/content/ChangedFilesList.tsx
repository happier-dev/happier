import * as React from 'react';
import { Platform, View } from 'react-native';

import {
    ChangedFileEvidenceDisclosure,
    checkpointAttributionDescription,
    sessionAttributedFileAccessibilityQualification,
} from '@/components/workspaces/scm/changes/ChangedFileEvidenceDisclosure';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    filterPresentableSessionAttributedFiles,
    resolveChangedFilesEmptyStateTranslationKey,
    type SessionAttributedFile,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ChangedFilesSectionHeader } from '@/components/workspaces/scm/review/ChangedFilesSectionHeader';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { filterDirectoryLikeScmFileStatuses } from '@/scm/isDirectoryLikeScmFileStatus';
import type { RepositoryCheckpointTurnMetadata } from '@happier-dev/protocol/sessions/changes/types';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: RepositoryCheckpointTurnMetadata | null;
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned?: (file: ScmFileStatus) => void;
    onToggleSelectionForFile?: (file: ScmFileStatus) => void;
    renderFileActions?: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions?: (file: ScmFileStatus) => React.ReactNode;
    rowDensity?: 'comfortable' | 'compact';
    showSectionHeader?: boolean;
};


export function ChangedFilesList({
    theme,
    changedFilesViewMode,
    allRepositoryChangedFiles,
    turnAttributedFiles = [],
    turnAgentReportedFiles = [],
    turnCheckpointFiles = [],
    turnCheckpointMetadata = null,
    sessionAttributedFiles,
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
        return filterPresentableSessionAttributedFiles(sessionAttributedFiles);
    }, [sessionAttributedFiles]);

    const filteredTurnAttributedFiles = React.useMemo(() => {
        return filterPresentableSessionAttributedFiles(turnAttributedFiles);
    }, [turnAttributedFiles]);
    const filteredTurnAgentReportedFiles = React.useMemo(() => {
        return filterPresentableSessionAttributedFiles(turnAgentReportedFiles);
    }, [turnAgentReportedFiles]);
    const filteredTurnCheckpointFiles = React.useMemo(() => {
        return filterPresentableSessionAttributedFiles(turnCheckpointFiles);
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
                            paddingHorizontal: theme.space.s16,
                            paddingVertical: theme.space.s12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text
                            style={{
                                ...Typography.variant('label', 'semiBold'),
                                color: theme.colors.text.primary,
                            }}
                        >
                            {t('files.latestTurnChanges', { count: filteredTurnAttributedFiles.length })}
                        </Text>
                        <Text
                            style={{
                                marginTop: theme.space.s4,
                                ...Typography.variant('meta'),
                                color: theme.colors.text.secondary,
                            }}
                        >
                            {checkpointAttributionDescription(turnCheckpointMetadata) ?? t('files.latestTurnDescription')}
                        </Text>
                    </View>
                ) : null}

                {filteredTurnAttributedFiles.length === 0 ? (
                    <View style={{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }}>
                        <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('meta'),  }}>
                            {t(resolveChangedFilesEmptyStateTranslationKey(changedFilesViewMode))}
                        </Text>
                    </View>
                ) : (
                    filteredTurnAttributedFiles.map((entry, index) => (
                        <View key={`turn-${entry.file.fullPath}-${index}`}>
                        <ScmChangeRow
                            theme={theme}
                            file={entry.file}
                            accessibilityQualification={sessionAttributedFileAccessibilityQualification(entry)}
                            density={rowDensity}
                            leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                            trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                            onPress={() => onFilePress(entry.file)}
                            onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                            onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                            statsColumnWidth={turnStatsColumnWidth}
                            showDivider={index < filteredTurnAttributedFiles.length - 1}
                        />
                        <ChangedFileEvidenceDisclosure entry={entry} />
                        </View>
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
                            paddingHorizontal: theme.space.s16,
                            paddingVertical: theme.space.s12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text
                            style={{
                                ...Typography.variant('label', 'semiBold'),
                                color: theme.colors.text.primary,
                            }}
                        >
                            {isCheckpointMode
                                ? t('files.checkpointTurnChanges', { count: files.length })
                                : t('files.agentReportedTurnChanges', { count: files.length })}
                        </Text>
                        <Text
                            style={{
                                marginTop: theme.space.s4,
                                ...Typography.variant('meta'),
                                color: theme.colors.text.secondary,
                            }}
                        >
                            {isCheckpointMode
                                ? checkpointAttributionDescription(turnCheckpointMetadata)
                                : t('files.agentReportedTurnDescription')}
                        </Text>
                    </View>
                ) : null}

                {files.length === 0 && !checkpointUnavailable ? (
                    <View style={{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }}>
                        <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('meta'),  }}>
                            {t(resolveChangedFilesEmptyStateTranslationKey(changedFilesViewMode))}
                        </Text>
                    </View>
                ) : files.length > 0 ? (
                    files.map((entry, index) => (
                        <View key={`${isCheckpointMode ? 'turn-checkpoint' : 'turn-agent'}-${entry.file.fullPath}-${index}`}>
                        <ScmChangeRow
                            theme={theme}
                            file={entry.file}
                            accessibilityQualification={sessionAttributedFileAccessibilityQualification(entry)}
                            density={rowDensity}
                            leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                            trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                            onPress={() => onFilePress(entry.file)}
                            onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                            onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                            statsColumnWidth={statsColumnWidth}
                            showDivider={index < files.length - 1}
                        />
                        <ChangedFileEvidenceDisclosure entry={entry} />
                        </View>
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
                        paddingHorizontal: theme.space.s16,
                        paddingVertical: theme.space.s12,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: theme.colors.border.default,
                    }}
                >
                    <Text
                        style={{
                            ...Typography.variant('label', 'semiBold'),
                            color: theme.colors.text.primary,
                        }}
                    >
                        {t('files.sessionAttributedChanges', { count: sessionAttributedFiles.length })}
                    </Text>
                </View>
            ) : null}

            {filteredSessionAttributedFiles.length === 0 ? (
                <View style={{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }}>
                    <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('meta'),  }}>
                        {t('files.noSessionAttributedChanges')}
                    </Text>
                </View>
            ) : (
                filteredSessionAttributedFiles.map((entry, index) => (
                    <View key={`session-${entry.file.fullPath}-${index}`}>
                    <ScmChangeRow
                        theme={theme}
                        file={entry.file}
                        accessibilityQualification={sessionAttributedFileAccessibilityQualification(entry)}
                        density={rowDensity}
                        leadingElement={renderFileActions ? renderFileActions(entry.file) : null}
                        trailingElement={renderFileTrailingActions ? renderFileTrailingActions(entry.file) : null}
                        onPress={() => onFilePress(entry.file)}
                        onPressPinned={onFilePressPinned ? () => onFilePressPinned(entry.file) : undefined}
                        onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(entry.file) : undefined}
                        statsColumnWidth={sessionStatsColumnWidth}
                        showDivider={index < filteredSessionAttributedFiles.length - 1}
                    />
                    <ChangedFileEvidenceDisclosure entry={entry} />
                    </View>
                ))
            )}
        </>
    );
}
