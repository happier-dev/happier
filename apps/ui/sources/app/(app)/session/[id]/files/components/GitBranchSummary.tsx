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
    const staged = Number(gitStatusFiles.totalStaged ?? 0);
    const unstaged = Number(gitStatusFiles.totalUnstaged ?? 0);

    const StatPill = ({ label, value, iconName }: { label: string; value: number; iconName: string }) => {
        return (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                }}
            >
                <Octicons name={iconName as any} size={14} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                    {label}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.mono('semiBold') }}>
                    {String(value)}
                </Text>
            </View>
        );
    };

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
                        color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {gitStatusFiles.branch || t('files.detachedHead')}
                </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <StatPill label="Staged" value={staged} iconName="diff-added" />
                <StatPill label="Unstaged" value={unstaged} iconName="diff-modified" />
                {showTracking && (
                    <StatPill label="Ahead" value={ahead} iconName="arrow-up" />
                )}
                {showTracking && (
                    <StatPill label="Behind" value={behind} iconName="arrow-down" />
                )}
            </View>

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
                </Text>
            )}
        </View>
    );
}
