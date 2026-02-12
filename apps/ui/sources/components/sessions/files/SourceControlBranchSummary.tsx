import * as React from 'react';
import { Platform, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';

type SourceControlBranchSummaryProps = {
    theme: any;
    scmStatusFiles: ScmStatusFiles;
};

export function SourceControlBranchSummary({ theme, scmStatusFiles }: SourceControlBranchSummaryProps) {
    const ahead = Number(scmStatusFiles.ahead ?? 0);
    const behind = Number(scmStatusFiles.behind ?? 0);
    const showTracking = Boolean(scmStatusFiles.upstream) || ahead > 0 || behind > 0;
    const staged = Number(scmStatusFiles.totalIncluded ?? 0);
    const unstaged = Number(scmStatusFiles.totalPending ?? 0);
    const usesWorkingCopyModel = scmStatusFiles.changeSetModel === 'working-copy';
    const includedLabel = usesWorkingCopyModel ? 'Included' : 'Staged';
    const pendingLabel = usesWorkingCopyModel ? 'Pending' : 'Unstaged';

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
                    {scmStatusFiles.branch || t('files.detachedHead')}
                </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <StatPill label={includedLabel} value={staged} iconName="diff-added" />
                <StatPill label={pendingLabel} value={unstaged} iconName="diff-modified" />
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
                    {scmStatusFiles.upstream ? `Upstream ${scmStatusFiles.upstream}` : 'No upstream'}
                </Text>
            )}
        </View>
    );
}
