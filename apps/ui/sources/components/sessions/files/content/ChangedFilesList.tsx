import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { formatFileSubtitle } from '@/components/sessions/files/filesUtils';
import { ChangedFileIcon, ChangedFileStatusIcon } from '@/components/sessions/files/changedFiles/ChangedFileRowIcons';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    onFilePress: (file: ScmFileStatus) => void;
};

function renderFileSubtitle(file: ScmFileStatus) {
    return formatFileSubtitle(file, t('files.projectRoot'));
}

function renderSessionAttributionSubtitle(file: ScmFileStatus, confidence: 'high' | 'inferred') {
    const base = renderFileSubtitle(file);
    const confidenceLabel = confidence === 'high' ? 'direct' : 'inferred';
    return `${base} • ${confidenceLabel}`;
}

export function ChangedFilesList({
    theme,
    changedFilesViewMode,
    attributionReliability,
    allRepositoryChangedFiles,
    sessionAttributedFiles,
    repositoryOnlyFiles,
    suppressedInferredCount,
    onFilePress,
}: ChangedFilesListProps) {
    const isDarkTheme = theme.dark === true;

    if (changedFilesViewMode === 'repository') {
        return (
            <>
                <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                    {t('files.repositoryChangedFiles', { count: allRepositoryChangedFiles.length })}
                </ChangedFilesSectionHeader>
                {allRepositoryChangedFiles.map((file, index) => (
                    <Item
                        key={`repo-all-${file.fullPath}-${index}`}
                        title={file.fileName}
                        subtitle={renderFileSubtitle(file)}
                        icon={<ChangedFileIcon file={file} />}
                        rightElement={<ChangedFileStatusIcon file={file} theme={theme} isDarkTheme={isDarkTheme} />}
                        onPress={() => onFilePress(file)}
                        showDivider={index < allRepositoryChangedFiles.length - 1}
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

            {sessionAttributedFiles.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        {t('files.noSessionAttributedChanges')}
                    </Text>
                </View>
            ) : (
                sessionAttributedFiles.map((entry, index) => (
                    <Item
                        key={`session-${entry.file.fullPath}-${index}`}
                        title={entry.file.fileName}
                        subtitle={renderSessionAttributionSubtitle(entry.file, entry.confidence)}
                        icon={<ChangedFileIcon file={entry.file} />}
                        rightElement={<ChangedFileStatusIcon file={entry.file} theme={theme} isDarkTheme={isDarkTheme} />}
                        onPress={() => onFilePress(entry.file)}
                        showDivider={index < sessionAttributedFiles.length - 1}
                    />
                ))
            )}

            {repositoryOnlyFiles.length > 0 && (
                <>
                    <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                        {t('files.otherRepositoryChanges', { count: repositoryOnlyFiles.length })}
                    </ChangedFilesSectionHeader>
                    {repositoryOnlyFiles.map((file, index) => (
                        <Item
                            key={`repo-${file.fullPath}-${index}`}
                            title={file.fileName}
                            subtitle={renderFileSubtitle(file)}
                            icon={<ChangedFileIcon file={file} />}
                            rightElement={<ChangedFileStatusIcon file={file} theme={theme} isDarkTheme={isDarkTheme} />}
                            onPress={() => onFilePress(file)}
                            showDivider={index < repositoryOnlyFiles.length - 1}
                        />
                    ))}
                </>
            )}
        </>
    );
}
