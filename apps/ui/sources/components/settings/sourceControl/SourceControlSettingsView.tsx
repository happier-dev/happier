import React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { scmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import type {
    ScmGitRepoPreferredBackend,
    ScmPushRejectPolicy,
    ScmRemoteConfirmPolicy,
} from '@/scm/settings/preferences';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const COMMIT_STRATEGY_OPTIONS: ReadonlyArray<{
    id: ScmCommitStrategy;
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'atomic',
        title: 'Atomic commit (recommended)',
        subtitle: 'No live staging in the repository index. Commit all pending changes in one RPC operation.',
        iconName: 'shield-checkmark-outline',
    },
    {
        id: 'git_staging',
        title: 'Git staging workflow',
        subtitle: 'Enable include/exclude and partial line staging for Git repositories.',
        iconName: 'git-compare-outline',
    },
];

const GIT_REPO_BACKEND_OPTIONS: ReadonlyArray<{
    id: ScmGitRepoPreferredBackend;
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'git',
        title: '.git repositories use Git',
        subtitle: 'Default and recommended for compatibility.',
        iconName: 'logo-github',
    },
    {
        id: 'sapling',
        title: '.git repositories prefer Sapling',
        subtitle: 'Use Sapling backend when both Git and Sapling are available.',
        iconName: 'git-branch-outline',
    },
];

const REMOTE_CONFIRM_OPTIONS: ReadonlyArray<{
    id: ScmRemoteConfirmPolicy;
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'always',
        title: 'Always confirm pull/push',
        subtitle: 'Show confirmation dialogs for pull and push operations.',
        iconName: 'help-circle-outline',
    },
    {
        id: 'push_only',
        title: 'Confirm push only',
        subtitle: 'Pull runs immediately; push requires confirmation.',
        iconName: 'arrow-up-circle-outline',
    },
    {
        id: 'never',
        title: 'Never confirm',
        subtitle: 'Run pull and push immediately.',
        iconName: 'flash-outline',
    },
];

const PUSH_REJECT_OPTIONS: ReadonlyArray<{
    id: ScmPushRejectPolicy;
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'prompt_fetch',
        title: 'Prompt to fetch',
        subtitle: 'Ask before running fetch when push is non-fast-forward rejected.',
        iconName: 'help-buoy-outline',
    },
    {
        id: 'auto_fetch',
        title: 'Auto-fetch',
        subtitle: 'Automatically fetch after non-fast-forward push rejection.',
        iconName: 'sync-outline',
    },
    {
        id: 'manual',
        title: 'Manual recovery',
        subtitle: 'Do not fetch automatically after push rejection.',
        iconName: 'hand-left-outline',
    },
];

const DIFF_MODE_OPTIONS: ReadonlyArray<{
    id: ScmDiffArea;
    title: string;
    iconName: IoniconName;
}> = [
    { id: 'pending', title: 'Pending', iconName: 'time-outline' },
    { id: 'both', title: 'Combined', iconName: 'git-merge-outline' },
    { id: 'included', title: 'Included', iconName: 'checkmark-circle-outline' },
];

const FILES_SYNTAX_HIGHLIGHTING_OPTIONS: ReadonlyArray<{
    id: 'off' | 'simple' | 'advanced';
    title: string;
    subtitle: string;
    iconName: IoniconName;
}> = [
    {
        id: 'off',
        title: 'Syntax highlighting: Off',
        subtitle: 'Render diffs and files as plain monospace text.',
        iconName: 'text-outline',
    },
    {
        id: 'simple',
        title: 'Syntax highlighting: Simple',
        subtitle: 'Fast token-based highlighting for common languages.',
        iconName: 'color-palette-outline',
    },
    {
        id: 'advanced',
        title: 'Syntax highlighting: Advanced',
        subtitle: 'Higher fidelity highlighting on web/desktop; falls back to simple on native.',
        iconName: 'sparkles-outline',
    },
];

export const SourceControlSettingsView = React.memo(function SourceControlSettingsView() {
    const { theme } = useUnistyles();
    const [scmCommitStrategy, setScmCommitStrategy] = useSettingMutable('scmCommitStrategy');
    const [scmGitRepoPreferredBackend, setScmGitRepoPreferredBackend] = useSettingMutable('scmGitRepoPreferredBackend');
    const [scmRemoteConfirmPolicy, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const [scmPushRejectPolicy, setScmPushRejectPolicy] = useSettingMutable('scmPushRejectPolicy');
    const [scmDefaultDiffModeByBackend, setScmDefaultDiffModeByBackend] = useSettingMutable('scmDefaultDiffModeByBackend');
    const [filesDiffSyntaxHighlightingMode, setFilesDiffSyntaxHighlightingMode] = useSettingMutable('filesDiffSyntaxHighlightingMode');
    const backendPlugins = scmBackendSettingsRegistry.listPlugins();
    const currentDiffModeByBackend = scmDefaultDiffModeByBackend ?? {};
    const effectiveFilesDiffSyntaxHighlightingMode = (filesDiffSyntaxHighlightingMode ?? 'off') as 'off' | 'simple' | 'advanced';

    const renderIcon = React.useCallback((iconName: IoniconName) => (
        <Ionicons name={iconName} size={29} color={theme.colors.textSecondary} />
    ), [theme.colors.textSecondary]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Commit strategy"
                footer="Atomic commit avoids cross-agent index interference. Git staging enables interactive include/exclude workflows."
            >
                {COMMIT_STRATEGY_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmCommitStrategy === option.id ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setScmCommitStrategy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title=".git routing preference"
                footer="Select which backend to prefer when the repository mode is .git."
            >
                {GIT_REPO_BACKEND_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmGitRepoPreferredBackend === option.id ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setScmGitRepoPreferredBackend(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title="Remote confirmation"
                footer="Controls whether pull/push operations require confirmation."
            >
                {REMOTE_CONFIRM_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmRemoteConfirmPolicy === option.id ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setScmRemoteConfirmPolicy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title="Push rejection recovery"
                footer="Behavior when push is rejected because the branch is behind upstream."
            >
                {PUSH_REJECT_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmPushRejectPolicy === option.id ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setScmPushRejectPolicy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title="Files display"
                footer="Syntax highlighting is experimental and may be disabled for very large diffs."
            >
                {FILES_SYNTAX_HIGHLIGHTING_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveFilesDiffSyntaxHighlightingMode === option.id ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setFilesDiffSyntaxHighlightingMode(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {backendPlugins.map((plugin) => (
                <ItemGroup key={plugin.backendId} title={`${plugin.title} backend`} footer={plugin.description}>
                    {(() => {
                        const backendUiPlugin = scmUiBackendRegistry.getPlugin(plugin.backendId);
                        const availableModes = backendUiPlugin.diffModeConfig(null).availableModes;
                        return DIFF_MODE_OPTIONS
                            .filter((option) => availableModes.includes(option.id))
                            .map((option) => (
                                <Item
                                    key={`diff-${plugin.backendId}-${option.id}`}
                                    title={`${plugin.title} default diff: ${option.title}`}
                                    subtitle="Default mode when viewing files with included and pending deltas."
                                    icon={renderIcon(option.iconName)}
                                    rightElement={
                                        currentDiffModeByBackend[plugin.backendId] === option.id
                                            ? <Ionicons name="checkmark" size={20} color="#007AFF" />
                                            : null
                                    }
                                    onPress={() => {
                                        setScmDefaultDiffModeByBackend({
                                            ...currentDiffModeByBackend,
                                            [plugin.backendId]: option.id,
                                        });
                                    }}
                                    showChevron={false}
                                />
                            ));
                    })()}
                    {plugin.infoItems.map((item) => (
                        <Item
                            key={item.id}
                            title={item.title}
                            subtitle={item.subtitle}
                            icon={renderIcon(item.iconName)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});
