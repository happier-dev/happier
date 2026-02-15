import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { formatFileSubtitle } from '@/components/sessions/files/filesUtils';
import { ChangedFileIcon, ChangedFileStatusIcon } from '@/components/sessions/files/changedFiles/ChangedFileRowIcons';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';
import { ChangedFilesReviewOutline } from '@/components/sessions/files/content/review/ChangedFilesReviewOutline';
import { changedFilesListAnchorId } from '@/components/sessions/files/content/list/changedFilesListAnchorId';

type ChangedFilesListProps = {
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    onFilePress: (file: ScmFileStatus) => void;
    renderFileActions?: (file: ScmFileStatus) => React.ReactNode;
    rowDensity?: 'comfortable' | 'compact';
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
    renderFileActions,
    rowDensity = 'comfortable',
}: ChangedFilesListProps) {
    const isDarkTheme = theme.dark === true;
    const iconSize = rowDensity === 'compact' ? 20 : 32;
    const { width: viewportWidth } = useWindowDimensions();
    const showOutline =
        Platform.OS === 'web'
        && viewportWidth >= 900
        && (changedFilesViewMode === 'repository'
            ? allRepositoryChangedFiles.length > 0
            : sessionAttributedFiles.length > 0 || repositoryOnlyFiles.length > 0);

    const [highlightedPath, setHighlightedPath] = React.useState<string | null>(null);
    const jumpToPath = React.useCallback((path: string) => {
        if (typeof document === 'undefined') return;
        const elementId = changedFilesListAnchorId(path);
        const el = document.getElementById(elementId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    const outlineFiles = React.useMemo(() => {
        if (changedFilesViewMode === 'repository') {
            return allRepositoryChangedFiles;
        }
        const out: ScmFileStatus[] = [];
        const seen = new Set<string>();
        for (const entry of sessionAttributedFiles) {
            if (seen.has(entry.file.fullPath)) continue;
            seen.add(entry.file.fullPath);
            out.push(entry.file);
        }
        for (const file of repositoryOnlyFiles) {
            if (seen.has(file.fullPath)) continue;
            seen.add(file.fullPath);
            out.push(file);
        }
        return out;
    }, [allRepositoryChangedFiles, changedFilesViewMode, repositoryOnlyFiles, sessionAttributedFiles]);

    const leftContent = changedFilesViewMode === 'repository' ? (
        <>
                <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                    {t('files.repositoryChangedFiles', { count: allRepositoryChangedFiles.length })}
                </ChangedFilesSectionHeader>
                {allRepositoryChangedFiles.map((file, index) => (
                    <View key={`repo-all-${file.fullPath}-${index}`} nativeID={changedFilesListAnchorId(file.fullPath)}>
                        <Item
                            title={file.fileName}
                            subtitle={renderFileSubtitle(file)}
                            icon={<ChangedFileIcon file={file} size={iconSize} />}
                            density={rowDensity}
                            rightElement={
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                    {renderFileActions ? renderFileActions(file) : null}
                                    <ChangedFileStatusIcon file={file} theme={theme} isDarkTheme={isDarkTheme} />
                                </View>
                            }
                            onPress={() => onFilePress(file)}
                            showDivider={index < allRepositoryChangedFiles.length - 1}
                            style={highlightedPath === file.fullPath ? { backgroundColor: theme.colors.surfaceHigh } : undefined}
                        />
                    </View>
                ))}
        </>
    ) : (
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
                    <View key={`session-${entry.file.fullPath}-${index}`} nativeID={changedFilesListAnchorId(entry.file.fullPath)}>
                        <Item
                            title={entry.file.fileName}
                            subtitle={renderSessionAttributionSubtitle(entry.file, entry.confidence)}
                            icon={<ChangedFileIcon file={entry.file} size={iconSize} />}
                            density={rowDensity}
                            rightElement={
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                    {renderFileActions ? renderFileActions(entry.file) : null}
                                    <ChangedFileStatusIcon file={entry.file} theme={theme} isDarkTheme={isDarkTheme} />
                                </View>
                            }
                            onPress={() => onFilePress(entry.file)}
                            showDivider={index < sessionAttributedFiles.length - 1}
                            style={highlightedPath === entry.file.fullPath ? { backgroundColor: theme.colors.surfaceHigh } : undefined}
                        />
                    </View>
                ))
            )}

            {repositoryOnlyFiles.length > 0 && (
                <>
                    <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                        {t('files.otherRepositoryChanges', { count: repositoryOnlyFiles.length })}
                    </ChangedFilesSectionHeader>
                    {repositoryOnlyFiles.map((file, index) => (
                        <View key={`repo-${file.fullPath}-${index}`} nativeID={changedFilesListAnchorId(file.fullPath)}>
                            <Item
                                title={file.fileName}
                                subtitle={renderFileSubtitle(file)}
                                icon={<ChangedFileIcon file={file} size={iconSize} />}
                                density={rowDensity}
                                rightElement={
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                        {renderFileActions ? renderFileActions(file) : null}
                                        <ChangedFileStatusIcon file={file} theme={theme} isDarkTheme={isDarkTheme} />
                                    </View>
                                }
                                onPress={() => onFilePress(file)}
                                showDivider={index < repositoryOnlyFiles.length - 1}
                                style={highlightedPath === file.fullPath ? { backgroundColor: theme.colors.surfaceHigh } : undefined}
                            />
                        </View>
                    ))}
                </>
            )}
        </>
    );

    if (!showOutline) {
        return leftContent;
    }

    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, minWidth: 0 }}>{leftContent}</View>
            <View
                testID="scm-list-outline"
                style={{
                    width: 300,
                    marginTop: 8,
                    marginRight: 16,
                    marginLeft: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 12,
                    backgroundColor: theme.colors.surface,
                    overflow: 'hidden',
                }}
            >
                <ChangedFilesReviewOutline
                    theme={theme}
                    files={outlineFiles}
                    selectedPath={highlightedPath}
                    onSelectFile={(file) => {
                        setHighlightedPath(file.fullPath);
                        jumpToPath(file.fullPath);
                    }}
                />
            </View>
        </View>
    );
}
