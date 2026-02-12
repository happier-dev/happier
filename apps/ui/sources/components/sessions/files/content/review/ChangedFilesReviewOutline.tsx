import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { buildChangedFilesOutlineTree, type ChangedFilesOutlineNode } from './buildChangedFilesOutlineTree';

type ChangedFilesReviewOutlineProps = {
    theme: any;
    files: ScmFileStatus[];
    selectedPath: string | null;
    onSelectFile: (file: ScmFileStatus) => void;
};

function OutlineRow(props: {
    theme: any;
    depth: number;
    isSelected: boolean;
    icon: React.ReactNode;
    label: string;
    onPress: () => void;
}) {
    const { theme, depth, isSelected, icon, label, onPress } = props;
    return (
        <Pressable
            onPress={onPress}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingVertical: 6,
                paddingHorizontal: 10,
                paddingLeft: 10 + depth * 12,
                borderRadius: 10,
                backgroundColor: isSelected ? theme.colors.surfaceHigh : 'transparent',
            }}
        >
            {icon}
            <Text
                numberOfLines={1}
                style={{
                    flex: 1,
                    fontSize: 12,
                    color: theme.colors.text,
                    ...Typography.default(isSelected ? 'semiBold' : undefined),
                }}
            >
                {label}
            </Text>
        </Pressable>
    );
}

function flattenFileNodes(nodes: ChangedFilesOutlineNode[]): Array<ChangedFilesOutlineNode & { kind: 'file' }> {
    const out: Array<ChangedFilesOutlineNode & { kind: 'file' }> = [];
    const visit = (node: ChangedFilesOutlineNode) => {
        if (node.kind === 'file') out.push(node);
        else for (const child of node.children) visit(child);
    };
    for (const n of nodes) visit(n);
    return out;
}

export function ChangedFilesReviewOutline(props: ChangedFilesReviewOutlineProps): React.ReactElement {
    const { theme, files, selectedPath, onSelectFile } = props;

    const [filter, setFilter] = React.useState('');
    const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set());

    const tree = React.useMemo(() => buildChangedFilesOutlineTree(files), [files]);
    const filtered = filter.trim().toLowerCase();

    const visibleNodes = React.useMemo(() => {
        if (!filtered) return null;
        const nodes = flattenFileNodes(tree);
        return nodes
            .filter((n) => n.fullPath.toLowerCase().includes(filtered))
            .sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { sensitivity: 'base' }));
    }, [filtered, tree]);

    const toggleDir = React.useCallback((fullPath: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(fullPath)) next.delete(fullPath);
            else next.add(fullPath);
            return next;
        });
    }, []);

    const renderTree = React.useCallback(
        (nodes: ChangedFilesOutlineNode[], depth: number): React.ReactNode => {
            return nodes.map((node) => {
                if (node.kind === 'file') {
                    return (
                        <OutlineRow
                            key={node.fullPath}
                            theme={theme}
                            depth={depth}
                            isSelected={Boolean(selectedPath && selectedPath === node.fullPath)}
                            icon={<Octicons name="file" size={14} color={theme.colors.textSecondary} />}
                            label={node.name}
                            onPress={() => onSelectFile(node.file)}
                        />
                    );
                }

                const isExpanded = expandedDirs.has(node.fullPath);
                return (
                    <View key={node.fullPath}>
                        <OutlineRow
                            theme={theme}
                            depth={depth}
                            isSelected={false}
                            icon={
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                    <Octicons
                                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                                        size={14}
                                        color={theme.colors.textSecondary}
                                    />
                                    <Octicons name="file-directory" size={14} color={theme.colors.textSecondary} />
                                </View>
                            }
                            label={node.name}
                            onPress={() => toggleDir(node.fullPath)}
                        />
                        {isExpanded ? <View>{renderTree(node.children, depth + 1)}</View> : null}
                    </View>
                );
            });
        },
        [expandedDirs, onSelectFile, selectedPath, theme, toggleDir]
    );

    return (
        <View style={{ padding: 10 }}>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input?.background ?? theme.colors.surfaceHigh,
                    borderRadius: 10,
                    paddingHorizontal: 10,
                    paddingVertical: Platform.select({ web: 8, default: 6 }) as number,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                }}
            >
                <Octicons name="filter" size={14} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                    value={filter}
                    onChangeText={setFilter}
                    placeholder={t('files.reviewFilterPlaceholder')}
                    style={{
                        flex: 1,
                        fontSize: 13,
                        ...Typography.default(),
                    }}
                    placeholderTextColor={theme.colors.input?.placeholder ?? theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <View style={{ marginTop: 10 }}>
                {visibleNodes ? (
                    visibleNodes.length > 0 ? (
                        visibleNodes.map((node) => (
                            <OutlineRow
                                key={node.fullPath}
                                theme={theme}
                                depth={0}
                                isSelected={Boolean(selectedPath && selectedPath === node.fullPath)}
                                icon={<Octicons name="file" size={14} color={theme.colors.textSecondary} />}
                                label={node.fullPath}
                                onPress={() => onSelectFile(node.file)}
                            />
                        ))
                    ) : (
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('files.reviewNoMatches')}
                        </Text>
                    )
                ) : (
                    renderTree(tree, 0)
                )}
            </View>
        </View>
    );
}
