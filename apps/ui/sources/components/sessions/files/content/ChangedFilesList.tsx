import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';
import { ScmChangeRow } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned?: (file: ScmFileStatus) => void;
    onToggleSelectionForFile?: (file: ScmFileStatus) => void;
    renderFileActions?: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions?: (file: ScmFileStatus) => React.ReactNode;
    rowDensity?: 'comfortable' | 'compact';
};

export function ChangedFilesList({
    theme,
    changedFilesViewMode,
    attributionReliability,
    allRepositoryChangedFiles,
    sessionAttributedFiles,
    repositoryOnlyFiles,
    suppressedInferredCount,
    onFilePress,
    onFilePressPinned,
    onToggleSelectionForFile,
    renderFileActions,
    renderFileTrailingActions,
    rowDensity = 'comfortable',
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

    const filteredRepositoryOnlyFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(repositoryOnlyFiles);
    }, [repositoryOnlyFiles]);

    if (changedFilesViewMode === 'repository') {
        return (
            <>
                <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                    {t('files.repositoryChangedFiles', { count: repositoryChangedFiles.length })}
                </ChangedFilesSectionHeader>
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
                        showDivider={index < repositoryChangedFiles.length - 1}
                    />
                ))}
            </>
        );
    }

    return (
        <>
            <View
                style={{
                    backgroundColor: theme.colors.surfaceHigh,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                }}
            >
                <Text
                    style={{
                        fontSize: 14,
                        color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {t('files.sessionAttributedChanges', { count: sessionAttributedFiles.length })}
                </Text>
                <Text
                    style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: theme.colors.textSecondary,
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
                        color: theme.colors.textSecondary,
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
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.inferredSuppressed', { count: suppressedInferredCount })}
                    </Text>
                )}
            </View>

            {filteredSessionAttributedFiles.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
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
                        showDivider={index < filteredSessionAttributedFiles.length - 1}
                    />
                ))
            )}

            {filteredRepositoryOnlyFiles.length > 0 && (
                <>
                    <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                        {t('files.otherRepositoryChanges', { count: filteredRepositoryOnlyFiles.length })}
                    </ChangedFilesSectionHeader>
                    {filteredRepositoryOnlyFiles.map((file, index) => (
                        <ScmChangeRow
                            key={`repo-${file.fullPath}-${index}`}
                            theme={theme}
                            file={file}
                            density={rowDensity}
                            leadingElement={renderFileActions ? renderFileActions(file) : null}
                            trailingElement={renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                            onPress={() => onFilePress(file)}
                            onPressPinned={onFilePressPinned ? () => onFilePressPinned(file) : undefined}
                            onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(file) : undefined}
                            showDivider={index < filteredRepositoryOnlyFiles.length - 1}
                        />
                    ))}
                </>
            )}
        </>
    );
}
