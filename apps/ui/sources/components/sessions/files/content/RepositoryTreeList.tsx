import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { useRepositoryTreeBrowser } from '@/hooks/session/files/useRepositoryTreeBrowser';
import { SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { t } from '@/text';

type RepositoryTreeListProps = {
    theme: any;
    sessionId: string;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onOpenFile: (fullPath: string) => void;
};

function isDirectoryNode(node: { type: 'file' | 'directory' | 'error' }): boolean {
    return node.type === 'directory';
}

function renderEntryIcon(node: { type: 'file' | 'directory' | 'error'; name: string }, theme: any) {
    if (node.type === 'directory') {
        return <Octicons name="file-directory" size={29} color={theme.colors.textLink} />;
    }
    if (node.type === 'error') {
        return <Octicons name="alert" size={18} color={theme.colors.textSecondary} />;
    }
    return <FileIcon fileName={node.name} size={29} />;
}

export function RepositoryTreeList(props: RepositoryTreeListProps): React.ReactElement {
    const { theme, sessionId, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const { rootLoading, rootError, nodes, toggleDirectory, collapseAll, expandedCount, retryRoot, retryDirectory } = useRepositoryTreeBrowser({
        sessionId,
        enabled: true,
        expandedPaths,
        onExpandedPathsChange,
    });

    if (rootLoading) {
        return (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                }}
            >
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (rootError) {
        return (
            <View testID="repository-tree-error" style={{ flex: 1 }}>
                <SourceControlUnavailableState
                    details={rootError}
                    onRetry={() => {
                        void retryRoot();
                    }}
                />
            </View>
        );
    }

    if (nodes.length === 0) {
        return (
            <View
                testID="repository-tree-empty"
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                    paddingHorizontal: 20,
                }}
            >
                <Octicons name="file-directory" size={48} color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.noFilesInProject')}
                </Text>
            </View>
        );
    }

    return (
        <>
            {expandedCount > 0 && (
                <View
                    style={{
                        flexDirection: 'row',
                        justifyContent: 'flex-end',
                        paddingHorizontal: 16,
                        paddingTop: 8,
                        paddingBottom: 4,
                    }}
                >
                    <Pressable
                        onPress={collapseAll}
                        style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            {t('files.repositoryCollapseAll')}
                        </Text>
                    </Pressable>
                </View>
            )}
            {nodes.map((node, index) => {
                const indent = Math.min(6, Math.max(0, node.depth));
                const paddingLeft = 16 + indent * 14;
                const showDivider = index < nodes.length - 1;

                if (node.type === 'error') {
                    return (
                        <Item
                            key={`error:${node.parentDirectoryPath ?? node.path}`}
                            title={t('files.repositoryFolderLoadFailed')}
                            subtitle={t('errors.tryAgain')}
                            icon={<Octicons name="alert" size={18} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            onPress={() => {
                                if (node.parentDirectoryPath) {
                                    void retryDirectory(node.parentDirectoryPath);
                                }
                            }}
                            showDivider={showDivider}
                            style={{
                                paddingLeft,
                                paddingRight: 12,
                            }}
                        />
                    );
                }

                const right = isDirectoryNode(node) ? (
                    <Pressable
                        onPress={() => {
                            void toggleDirectory(node.path);
                        }}
                        style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                    >
                        {node.isLoadingChildren ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : (
                            <Octicons
                                name={node.isExpanded ? 'chevron-down' : 'chevron-right'}
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                        )}
                    </Pressable>
                ) : null;

                const title = node.type === 'directory' ? `${node.name}/` : node.name;

                return (
                    <Item
                        key={`${node.type}:${node.path}`}
                        title={title}
                        icon={renderEntryIcon(node, theme)}
                        rightElement={right ?? undefined}
                        showChevron={node.type === 'file'}
                        onPress={
                            node.type === 'file'
                                ? () => onOpenFile(node.path)
                                : () => {
                                    void toggleDirectory(node.path);
                                }
                        }
                        showDivider={showDivider}
                        style={{
                            paddingLeft,
                            paddingRight: 12,
                        }}
                    />
                );
            })}
        </>
    );
}
