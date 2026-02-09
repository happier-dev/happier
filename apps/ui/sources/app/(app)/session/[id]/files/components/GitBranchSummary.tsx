import * as React from 'react';
import { Platform, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { GitStatusFiles } from '@/sync/git/gitStatusFiles';

type GitBranchSummaryProps = {
    theme: any;
    gitStatusFiles: GitStatusFiles;
};

export function GitBranchSummary({ theme, gitStatusFiles }: GitBranchSummaryProps) {
    const ahead = Number(gitStatusFiles.ahead ?? 0);
    const behind = Number(gitStatusFiles.behind ?? 0);
    const showTracking = Boolean(gitStatusFiles.upstream) || ahead > 0 || behind > 0;

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 8,
                }}
            >
                <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                <Text
                    style={{
                        fontSize: 16,
                        fontWeight: '600',
                        color: theme.colors.text,
                        ...Typography.default(),
                    }}
                >
                    {gitStatusFiles.branch || t('files.detachedHead')}
                </Text>
            </View>
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {t('files.summary', {
                    staged: gitStatusFiles.totalStaged,
                    unstaged: gitStatusFiles.totalUnstaged,
                })}
            </Text>

            {showTracking && (
                <Text
                    style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {gitStatusFiles.upstream ? `Upstream ${gitStatusFiles.upstream}` : 'No upstream'}
                    {(ahead > 0 || behind > 0)
                        ? ` · Ahead ${ahead} · Behind ${behind}`
                        : ''}
                </Text>
            )}
        </View>
    );
}
