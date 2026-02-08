import * as React from 'react';
import { Platform, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/StyledText';
import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/sync/git/gitAttribution';
import type { GitFileStatus } from '@/sync/git/gitStatusFiles';
import { t } from '@/text';
import { formatFileSubtitle } from '../../utils';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: GitFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: GitFileStatus[];
    suppressedInferredCount: number;
    onFilePress: (file: GitFileStatus) => void;
};

function renderFileIcon(file: GitFileStatus) {
    return <FileIcon fileName={file.fileName} size={32} />;
}

function renderStatusIcon(file: GitFileStatus, darkTheme: boolean) {
    let statusColor: string;
    let statusIcon: string;

    switch (file.status) {
        case 'modified':
            statusColor = '#FF9500';
            statusIcon = 'diff-modified';
            break;
        case 'added':
            statusColor = '#34C759';
            statusIcon = 'diff-added';
            break;
        case 'deleted':
            statusColor = '#FF3B30';
            statusIcon = 'diff-removed';
            break;
        case 'renamed':
            statusColor = '#007AFF';
            statusIcon = 'arrow-right';
            break;
        case 'copied':
            statusColor = '#007AFF';
            statusIcon = 'copy';
            break;
        case 'conflicted':
            statusColor = '#FF3B30';
            statusIcon = 'alert';
            break;
        case 'untracked':
            statusColor = darkTheme ? '#b0b0b0' : '#8E8E93';
            statusIcon = 'file';
            break;
        default:
            return null;
    }

    return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
}

function renderFileSubtitle(file: GitFileStatus) {
    return formatFileSubtitle(file, t('files.projectRoot'));
}

function renderSessionAttributionSubtitle(file: GitFileStatus, confidence: 'high' | 'inferred') {
    const base = renderFileSubtitle(file);
    const confidenceLabel = confidence === 'high' ? 'direct' : 'inferred';
    return `${base} • ${confidenceLabel}`;
}

function SectionHeader({ theme, color, children }: { theme: any; color: string; children: React.ReactNode }) {
    return (
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
                    fontWeight: '600',
                    color,
                    ...Typography.default(),
                }}
            >
                {children}
            </Text>
        </View>
    );
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
                <SectionHeader theme={theme} color={theme.colors.textSecondary}>
                    {t('files.repositoryChangedFiles', { count: allRepositoryChangedFiles.length })}
                </SectionHeader>
                {allRepositoryChangedFiles.map((file, index) => (
                    <Item
                        key={`repo-all-${file.fullPath}-${index}`}
                        title={file.fileName}
                        subtitle={renderFileSubtitle(file)}
                        icon={renderFileIcon(file)}
                        rightElement={renderStatusIcon(file, isDarkTheme)}
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
                        fontWeight: '600',
                        color: theme.colors.textLink,
                        ...Typography.default(),
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
                        icon={renderFileIcon(entry.file)}
                        rightElement={renderStatusIcon(entry.file, isDarkTheme)}
                        onPress={() => onFilePress(entry.file)}
                        showDivider={index < sessionAttributedFiles.length - 1}
                    />
                ))
            )}

            {repositoryOnlyFiles.length > 0 && (
                <>
                    <SectionHeader theme={theme} color={theme.colors.textSecondary}>
                        {t('files.otherRepositoryChanges', { count: repositoryOnlyFiles.length })}
                    </SectionHeader>
                    {repositoryOnlyFiles.map((file, index) => (
                        <Item
                            key={`repo-${file.fullPath}-${index}`}
                            title={file.fileName}
                            subtitle={renderFileSubtitle(file)}
                            icon={renderFileIcon(file)}
                            rightElement={renderStatusIcon(file, isDarkTheme)}
                            onPress={() => onFilePress(file)}
                            showDivider={index < repositoryOnlyFiles.length - 1}
                        />
                    ))}
                </>
            )}
        </>
    );
}
