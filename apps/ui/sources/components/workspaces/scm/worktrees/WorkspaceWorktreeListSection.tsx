import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { RepoWorktreeRow } from '../branches/buildWorkspaceScmBranchPopoverItems';
import { filterVisibleRepoWorktreeRows } from './filterVisibleRepoWorktreeRows';
import { sortRepoWorktreeRows } from './sortRepoWorktreeRows';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    searchContainer: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 6,
    },
    searchInput: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    helperText: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        color: theme.colors.text.secondary,
        fontSize: 13,
        ...Typography.default(),
    },
}));

function matchesWorktreeQuery(worktree: RepoWorktreeRow, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    const haystack = `${worktree.branch ?? ''}\n${worktree.path}`.toLowerCase();
    return haystack.includes(normalizedQuery);
}

export const WorkspaceWorktreeListSection = React.memo((props: Readonly<{
    worktrees: ReadonlyArray<RepoWorktreeRow>;
    selectedRootPath: string;
    onSelectRootPath: (path: string) => void;
}>) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [searchQuery, setSearchQuery] = React.useState('');

    const sortedWorktrees = React.useMemo(
        () => sortRepoWorktreeRows(filterVisibleRepoWorktreeRows(props.worktrees)),
        [props.worktrees],
    );
    const filteredWorktrees = React.useMemo(
        () => sortedWorktrees.filter((worktree) => matchesWorktreeQuery(worktree, searchQuery)),
        [searchQuery, sortedWorktrees],
    );

    return (
        <ItemGroup title={t('files.branchMenu.category.worktrees')}>
            <View style={styles.searchContainer}>
                <TextInput
                    testID="workspace-worktrees-search-input"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t('files.branchMenu.searchPlaceholder')}
                    placeholderTextColor={theme.colors.text.secondary}
                    style={styles.searchInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>
            {sortedWorktrees.length === 0 ? (
                <View>
                    <Text style={styles.helperText}>
                        {t('newSession.checkout.existingWorktreeEmptyTitle')}
                    </Text>
                </View>
            ) : filteredWorktrees.length === 0 ? (
                <View>
                    <Text style={styles.helperText}>
                        {t('externalSessions.browseNoSearchResults')}
                    </Text>
                </View>
            ) : (
                filteredWorktrees.map((worktree) => (
                    <Item
                        key={worktree.path}
                        testID={`workspace-worktree-row:${worktree.path}`}
                        title={worktree.branch ?? worktree.path}
                        subtitle={worktree.path}
                        selected={props.selectedRootPath === worktree.path}
                        onPress={() => props.onSelectRootPath(worktree.path)}
                        rightElement={worktree.isCurrent ? (
                            <Icon name="check" size={14} color={theme.colors.text.secondary} />
                        ) : null}
                    />
                ))
            )}
        </ItemGroup>
    );
});
