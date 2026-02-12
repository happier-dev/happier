import { ActivityIndicator, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { Octicons } from '@expo/vector-icons';
import type { ScmLogEntry } from '@happier-dev/protocol';

type SourceControlOperationsHistorySectionProps = Readonly<{
    theme: any;
    historyLoading: boolean;
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
}>;

export function SourceControlOperationsHistorySection(props: SourceControlOperationsHistorySectionProps) {
    const { theme, historyLoading, historyEntries, historyHasMore, onLoadMoreHistory, onOpenCommit } = props;

    if (historyLoading && historyEntries.length === 0) {
        return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
    }

    if (historyEntries.length === 0) {
        return (
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                No commits available.
            </Text>
        );
    }

    return (
        <View>
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    marginBottom: 6,
                    ...Typography.default('semiBold'),
                }}
            >
                Recent commits
            </Text>
            {historyEntries.slice(0, 5).map((entry) => (
                <Pressable
                    key={entry.sha}
                    onPress={() => onOpenCommit(entry.sha)}
                    style={(p) => ({
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        borderRadius: 12,
                        backgroundColor: p.pressed
                            ? (theme.colors.surfaceHigh ?? theme.colors.input.background)
                            : 'transparent',
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View
                            style={{
                                paddingHorizontal: 8,
                                paddingVertical: 6,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                            }}
                        >
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.mono('semiBold') }}>
                                {entry.shortSha}
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text
                                style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}
                                numberOfLines={1}
                            >
                                {entry.subject}
                            </Text>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() }}>
                                {new Date(entry.timestamp).toLocaleString()}
                            </Text>
                        </View>
                        <Octicons name="chevron-right" size={14} color={theme.colors.textSecondary} />
                    </View>
                </Pressable>
            ))}
            {historyHasMore && (
                <Pressable
                    disabled={historyLoading}
                    onPress={onLoadMoreHistory}
                    style={(p) => ({
                        marginTop: 4,
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                        opacity: historyLoading ? 0.6 : p.pressed ? 0.85 : 1,
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ color: theme.colors.textLink, fontSize: 12, ...Typography.default('semiBold') }}>
                            {historyLoading ? 'Loading…' : 'Load more commits'}
                        </Text>
                        <Octicons name="chevron-down" size={14} color={theme.colors.textSecondary} />
                    </View>
                </Pressable>
            )}
        </View>
    );
}
