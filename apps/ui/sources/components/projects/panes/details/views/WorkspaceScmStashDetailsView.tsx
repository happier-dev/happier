import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { machineScmStashList, machineScmStashShow } from '@/sync/ops/scm/machineScm';
import type { ScmStashEntry } from '@happier-dev/protocol';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { useSetting } from '@/sync/domains/state/storage';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type WorkspaceScmStashDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

type StashDiffState = Readonly<{
    stashRef: string | null;
    loading: boolean;
    diff: string;
    truncated: boolean;
    error: string | null;
}>;

function formatStashTimestamp(value: number | null | undefined): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return null;
    }
}

function resolveStashLabel(entry: ScmStashEntry): string {
    if (entry.kind === 'branch' && typeof entry.branch === 'string' && entry.branch.trim().length > 0) {
        return entry.branch;
    }
    return entry.stashRef;
}

export const WorkspaceScmStashDetailsView = React.memo((props: WorkspaceScmStashDetailsViewProps) => {
    const { theme } = useUnistyles();
    const wrapLines = useSetting('wrapLinesInDiffs') === true;
    const showLineNumbers = useSetting('showLineNumbers') === true;

    const [stashesLoading, setStashesLoading] = React.useState(true);
    const [stashesError, setStashesError] = React.useState<string | null>(null);
    const [stashes, setStashes] = React.useState<ScmStashEntry[]>([]);
    const [selectedStashRef, setSelectedStashRef] = React.useState<string | null>(null);
    const [diffState, setDiffState] = React.useState<StashDiffState>(() => ({
        stashRef: null,
        loading: false,
        diff: '',
        truncated: false,
        error: null,
    }));

    const loadStashes = React.useCallback(async () => {
        setStashesLoading(true);
        setStashesError(null);
        try {
            const response = await machineScmStashList(props.machineId, { cwd: props.rootPath });
            if (!response.success) {
                setStashes([]);
                setSelectedStashRef(null);
                setStashesError(response.error || t('files.stash.failedToLoad'));
                return;
            }
            const next = Array.isArray(response.managedStashes) ? response.managedStashes : [];
            setStashes(next);
            setSelectedStashRef((prev) => {
                if (prev && next.some((s) => s.stashRef === prev)) return prev;
                return next[0]?.stashRef ?? null;
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : t('files.stash.failedToLoad');
            setStashes([]);
            setSelectedStashRef(null);
            setStashesError(message);
        } finally {
            setStashesLoading(false);
        }
    }, [props.machineId, props.rootPath]);

    React.useEffect(() => {
        void loadStashes();
    }, [loadStashes]);

    React.useEffect(() => {
        let active = true;
        const stashRef = selectedStashRef;
        if (!stashRef) {
            setDiffState({
                stashRef: null,
                loading: false,
                diff: '',
                truncated: false,
                error: null,
            });
            return () => {
                active = false;
            };
        }

        void (async () => {
            setDiffState({
                stashRef,
                loading: true,
                diff: '',
                truncated: false,
                error: null,
            });
            try {
                const response = await machineScmStashShow(props.machineId, { cwd: props.rootPath, stashRef });
                if (!active) return;
                if (!response.success) {
                    setDiffState({
                        stashRef,
                        loading: false,
                        diff: '',
                        truncated: false,
                        error: response.error || t('files.stash.failedToLoadDiff'),
                    });
                    return;
                }
                setDiffState({
                    stashRef,
                    loading: false,
                    diff: response.diff ?? '',
                    truncated: response.truncated === true,
                    error: null,
                });
            } catch (err) {
                if (!active) return;
                setDiffState({
                    stashRef,
                    loading: false,
                    diff: '',
                    truncated: false,
                    error: err instanceof Error ? err.message : t('files.stash.failedToLoadDiff'),
                });
            }
        })();

        return () => {
            active = false;
        };
    }, [props.machineId, props.rootPath, selectedStashRef]);

    if (stashesLoading && stashes.length === 0 && !stashesError) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (stashesError) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
                <Text style={{ color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                    {stashesError}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.retry')}
                    onPress={() => {
                        void loadStashes();
                    }}
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surface,
                    }}
                >
                    <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    if (stashes.length === 0) {
        return (
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Octicons name="archive" size={48} color={theme.colors.textSecondary} style={{ marginBottom: 12 }} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 520 }}>
                    {t('files.stash.empty')}
                </Text>
            </View>
        );
    }

    const diffBlocks = buildDiffBlocks({ unified_diff: diffState.diff });
    const files = buildDiffFileEntries(diffBlocks);
    const expandedKeys = new Set(files.map((f) => f.key));

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface }}>
            <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') }}>
                        {t('files.stash.detailsTitle')}
                    </Text>
                    <Pressable
                        onPress={() => {
                            void loadStashes();
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.refresh')}
                        style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                        }}
                    >
                        <Octicons name="sync" size={14} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') }}>
                            {t('common.refresh')}
                        </Text>
                    </Pressable>
                </View>

                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 10, gap: 8 }}
                >
                    {stashes.map((entry) => {
                        const selected = entry.stashRef === selectedStashRef;
                        const label = resolveStashLabel(entry);
                        const timestamp = formatStashTimestamp(entry.createdAt);
                        const subtitle = timestamp || (typeof entry.message === 'string' && entry.message.trim().length > 0 ? entry.message : null);
                        return (
                            <Pressable
                                key={entry.stashRef}
                                testID={`workspace-stash-${toTestIdSafeValue(entry.stashRef)}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('files.stash.selectA11y', { stash: label })}
                                onPress={() => setSelectedStashRef(entry.stashRef)}
                                style={{
                                    paddingHorizontal: 10,
                                    paddingVertical: 8,
                                    borderRadius: 12,
                                    borderWidth: 1,
                                    borderColor: selected ? theme.colors.textLink : theme.colors.divider,
                                    backgroundColor: selected ? theme.colors.surfaceHigh : theme.colors.surface,
                                    minWidth: 140,
                                    maxWidth: 220,
                                }}
                            >
                                <Text
                                    numberOfLines={1}
                                    style={{ fontSize: 12, color: selected ? theme.colors.text : theme.colors.textSecondary, ...Typography.default('semiBold') }}
                                >
                                    {label}
                                </Text>
                                {subtitle ? (
                                    <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() }}>
                                        {subtitle}
                                    </Text>
                                ) : null}
                            </Pressable>
                        );
                    })}
                </ScrollView>
            </View>

            {diffState.loading ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('common.loading')}
                    </Text>
                </View>
            ) : diffState.error ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                        {diffState.error}
                    </Text>
                </View>
            ) : files.length === 0 ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                        {t('files.noChanges')}
                    </Text>
                </View>
            ) : (
                <DiffFilesListView
                    files={files}
                    expandedKeys={expandedKeys}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs
                    wrapLines={wrapLines}
                    showLineNumbers={showLineNumbers}
                    showPrefix={showLineNumbers}
                    virtualizeFileList
                    onOpenFile={props.onOpenFile}
                    onOpenFilePinned={props.onOpenFilePinned}
                    ListFooterComponent={diffState.truncated ? (
                        <View style={{ paddingHorizontal: 18, paddingVertical: 20 }}>
                            <Text style={{ color: theme.colors.textSecondary, ...Typography.default(), textAlign: 'center' }}>
                                {t('files.stash.diffTruncated')}
                            </Text>
                        </View>
                    ) : null}
                />
            )}
        </View>
    );
});
