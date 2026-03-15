import React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { scmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { Modal } from '@/modal';
import { t, type TranslationKey } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import type {
    ScmGitRepoPreferredBackend,
    ScmPushRejectPolicy,
    ScmRemoteConfirmPolicy,
} from '@/scm/settings/preferences';
import { TextInput } from '@/components/ui/text/Text';


type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const COMMIT_STRATEGY_OPTIONS: ReadonlyArray<{
    id: ScmCommitStrategy;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'atomic',
        titleKey: 'settingsSourceControl.commitStrategy.options.atomic.title',
        subtitleKey: 'settingsSourceControl.commitStrategy.options.atomic.subtitle',
        iconName: 'shield-checkmark-outline',
    },
    {
        id: 'git_staging',
        titleKey: 'settingsSourceControl.commitStrategy.options.gitStaging.title',
        subtitleKey: 'settingsSourceControl.commitStrategy.options.gitStaging.subtitle',
        iconName: 'git-compare-outline',
    },
];

const GIT_REPO_BACKEND_OPTIONS: ReadonlyArray<{
    id: ScmGitRepoPreferredBackend;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'git',
        titleKey: 'settingsSourceControl.gitRoutingPreference.options.git.title',
        subtitleKey: 'settingsSourceControl.gitRoutingPreference.options.git.subtitle',
        iconName: 'logo-github',
    },
    {
        id: 'sapling',
        titleKey: 'settingsSourceControl.gitRoutingPreference.options.sapling.title',
        subtitleKey: 'settingsSourceControl.gitRoutingPreference.options.sapling.subtitle',
        iconName: 'git-branch-outline',
    },
];

const REMOTE_CONFIRM_OPTIONS: ReadonlyArray<{
    id: ScmRemoteConfirmPolicy;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'always',
        titleKey: 'settingsSourceControl.remoteConfirmation.options.always.title',
        subtitleKey: 'settingsSourceControl.remoteConfirmation.options.always.subtitle',
        iconName: 'help-circle-outline',
    },
    {
        id: 'push_only',
        titleKey: 'settingsSourceControl.remoteConfirmation.options.pushOnly.title',
        subtitleKey: 'settingsSourceControl.remoteConfirmation.options.pushOnly.subtitle',
        iconName: 'arrow-up-circle-outline',
    },
    {
        id: 'never',
        titleKey: 'settingsSourceControl.remoteConfirmation.options.never.title',
        subtitleKey: 'settingsSourceControl.remoteConfirmation.options.never.subtitle',
        iconName: 'flash-outline',
    },
];

const PUSH_REJECT_OPTIONS: ReadonlyArray<{
    id: ScmPushRejectPolicy;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'prompt_fetch',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.promptFetch.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.promptFetch.subtitle',
        iconName: 'help-buoy-outline',
    },
    {
        id: 'auto_fetch',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.autoFetch.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.autoFetch.subtitle',
        iconName: 'sync-outline',
    },
    {
        id: 'manual',
        titleKey: 'settingsSourceControl.pushRejectionRecovery.options.manual.title',
        subtitleKey: 'settingsSourceControl.pushRejectionRecovery.options.manual.subtitle',
        iconName: 'hand-left-outline',
    },
];

const DIFF_MODE_OPTIONS: ReadonlyArray<{
    id: ScmDiffArea;
    titleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    { id: 'pending', titleKey: 'settingsSourceControl.diffMode.pending', iconName: 'time-outline' },
    { id: 'both', titleKey: 'settingsSourceControl.diffMode.combined', iconName: 'git-merge-outline' },
    { id: 'included', titleKey: 'settingsSourceControl.diffMode.included', iconName: 'checkmark-circle-outline' },
];

const FILES_SYNTAX_HIGHLIGHTING_OPTIONS: ReadonlyArray<{
    id: 'off' | 'simple' | 'advanced';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'off',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.off.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.off.subtitle',
        iconName: 'text-outline',
    },
    {
        id: 'simple',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.subtitle',
        iconName: 'color-palette-outline',
    },
    {
        id: 'advanced',
        titleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.advanced.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.advanced.subtitle',
        iconName: 'sparkles-outline',
    },
];

const FILES_DIFF_RENDERER_OPTIONS: ReadonlyArray<{
    id: 'pierre' | 'happier';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'pierre',
        titleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.pierre.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.pierre.subtitle',
        iconName: 'sparkles-outline',
    },
    {
        id: 'happier',
        titleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.subtitle',
        iconName: 'code-outline',
    },
];

const FILES_DIFF_PRESENTATION_OPTIONS: ReadonlyArray<{
    id: 'unified' | 'split';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'unified',
        titleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.subtitle',
        iconName: 'swap-vertical-outline',
    },
    {
        id: 'split',
        titleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.split.subtitle',
        iconName: 'grid-outline',
    },
];

const FILES_CHANGED_FILES_DENSITY_OPTIONS: ReadonlyArray<{
    id: 'comfortable' | 'compact';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IoniconName;
}> = [
    {
        id: 'comfortable',
        titleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.comfortable.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.comfortable.subtitle',
        iconName: 'list-outline',
    },
    {
        id: 'compact',
        titleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.title',
        subtitleKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.subtitle',
        iconName: 'reorder-three-outline',
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
    const [filesDiffRendererMode, setFilesDiffRendererMode] = useSettingMutable('filesDiffRendererMode');
    const [filesDiffPresentationStyle, setFilesDiffPresentationStyle] = useSettingMutable('filesDiffPresentationStyle');
    const [filesChangedFilesRowDensity, setFilesChangedFilesRowDensity] = useSettingMutable('filesChangedFilesRowDensity');
    const [scmCommitMessageGeneratorEnabled, setScmCommitMessageGeneratorEnabled] = useSettingMutable('scmCommitMessageGeneratorEnabled');
    const [scmCommitMessageGeneratorBackendId, setScmCommitMessageGeneratorBackendId] = useSettingMutable('scmCommitMessageGeneratorBackendId');
    const [scmCommitMessageGeneratorInstructions, setScmCommitMessageGeneratorInstructions] = useSettingMutable('scmCommitMessageGeneratorInstructions');
    const [scmIncludeCoAuthoredBy, setScmIncludeCoAuthoredBy] = useSettingMutable('scmIncludeCoAuthoredBy');
    const backendPlugins = scmBackendSettingsRegistry.listPlugins();
    const currentDiffModeByBackend = scmDefaultDiffModeByBackend ?? {};
    const effectiveFilesDiffSyntaxHighlightingMode = (filesDiffSyntaxHighlightingMode ?? 'off') as 'off' | 'simple' | 'advanced';
    const effectiveFilesDiffRendererMode = filesDiffRendererMode === 'happier' ? 'happier' : 'pierre';
    const effectiveFilesDiffPresentationStyle = filesDiffPresentationStyle === 'unified' || filesDiffPresentationStyle === 'split'
        ? filesDiffPresentationStyle
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const effectiveFilesChangedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const effectiveCommitMessageGeneratorEnabled = scmCommitMessageGeneratorEnabled === true;
    const effectiveCommitMessageGeneratorBackendId = typeof scmCommitMessageGeneratorBackendId === 'string' && scmCommitMessageGeneratorBackendId.trim()
        ? scmCommitMessageGeneratorBackendId.trim()
        : 'claude';
    const effectiveCommitMessageGeneratorInstructions = typeof scmCommitMessageGeneratorInstructions === 'string'
        ? scmCommitMessageGeneratorInstructions
        : '';
    const effectiveIncludeCoAuthoredBy = scmIncludeCoAuthoredBy === true;

    const renderIcon = React.useCallback((iconName: IoniconName) => (
        <Ionicons name={iconName} size={29} color={theme.colors.textSecondary} />
    ), [theme.colors.textSecondary]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSourceControl.commitStrategy.title')}
                footer={t('settingsSourceControl.commitStrategy.footer')}
            >
                {COMMIT_STRATEGY_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmCommitStrategy === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmCommitStrategy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.gitRoutingPreference.title')}
                footer={t('settingsSourceControl.gitRoutingPreference.footer')}
            >
                {GIT_REPO_BACKEND_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmGitRepoPreferredBackend === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmGitRepoPreferredBackend(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.remoteConfirmation.title')}
                footer={t('settingsSourceControl.remoteConfirmation.footer')}
            >
                {REMOTE_CONFIRM_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmRemoteConfirmPolicy === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmRemoteConfirmPolicy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.pushRejectionRecovery.title')}
                footer={t('settingsSourceControl.pushRejectionRecovery.footer')}
            >
                {PUSH_REJECT_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={scmPushRejectPolicy === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setScmPushRejectPolicy(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.commitMessageGenerator.title')}
                footer={t('settingsSourceControl.commitMessageGenerator.footer')}
            >
                <Item
                    title={t('settingsSourceControl.commitMessageGenerator.title')}
                    subtitle={effectiveCommitMessageGeneratorEnabled ? t('common.enabled') : t('common.disabled')}
                    icon={renderIcon('sparkles-outline')}
                    rightElement={effectiveCommitMessageGeneratorEnabled ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                    onPress={() => setScmCommitMessageGeneratorEnabled(!effectiveCommitMessageGeneratorEnabled)}
                    showChevron={false}
                />
                <Item
                    title={t('settingsSourceControl.commitMessageGenerator.backendItemTitle', { backendId: effectiveCommitMessageGeneratorBackendId })}
                    subtitle={t('settingsSourceControl.commitMessageGenerator.backendItemSubtitle')}
                    icon={renderIcon('server-outline')}
                    onPress={async () => {
                        const next = await Modal.prompt(t('settingsSourceControl.commitMessageGenerator.backendPromptTitle'), t('settingsSourceControl.commitMessageGenerator.backendPromptMessage'), {
                            defaultValue: effectiveCommitMessageGeneratorBackendId,
                            placeholder: 'claude',
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
                        });
                        if (typeof next === 'string' && next.trim()) {
                            setScmCommitMessageGeneratorBackendId(next.trim());
                        }
                    }}
                    showChevron={false}
                />

                <View style={{ paddingHorizontal: 16, paddingTop: 0, gap: 6 }}>
                      <TextInput
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            height: 110,
                            textAlignVertical: 'top' as any,
                            color: theme.colors.text,
                        }}
                        placeholder={t('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={effectiveCommitMessageGeneratorInstructions}
                        multiline={true}
                        onChangeText={(value) => setScmCommitMessageGeneratorInstructions(String(value))}
                    />
                </View>
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.commitAttribution.title')}
                footer={t('settingsSourceControl.commitAttribution.footer')}
            >
                <Item
                    title={t('settingsSourceControl.commitAttribution.includeCoAuthoredBy.title')}
                    subtitle={effectiveIncludeCoAuthoredBy ? t('common.enabled') : t('common.disabled')}
                    icon={renderIcon('people-outline')}
                    rightElement={effectiveIncludeCoAuthoredBy ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                    onPress={() => setScmIncludeCoAuthoredBy(!effectiveIncludeCoAuthoredBy)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSourceControl.filesDisplay.title')}
                footer={t('settingsSourceControl.filesDisplay.footer')}
            >
                {(Platform.OS === 'web' || String(Platform.OS) === 'node') ? (
                    <>
                        {FILES_DIFF_RENDERER_OPTIONS.map((option) => (
                            <Item
                                key={option.id}
                                title={t(option.titleKey)}
                                subtitle={t(option.subtitleKey)}
                                icon={renderIcon(option.iconName)}
                                rightElement={effectiveFilesDiffRendererMode === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                                onPress={() => setFilesDiffRendererMode(option.id)}
                                showChevron={false}
                            />
                        ))}
                        {effectiveFilesDiffRendererMode === 'pierre' ? (
                            <>
                                {FILES_DIFF_PRESENTATION_OPTIONS.map((option) => (
                                    <Item
                                        key={option.id}
                                        title={t(option.titleKey)}
                                        subtitle={t(option.subtitleKey)}
                                        icon={renderIcon(option.iconName)}
                                        rightElement={effectiveFilesDiffPresentationStyle === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                                        onPress={() => setFilesDiffPresentationStyle(option.id)}
                                        showChevron={false}
                                    />
                                ))}
                            </>
                        ) : null}
                    </>
                ) : null}
                {FILES_SYNTAX_HIGHLIGHTING_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveFilesDiffSyntaxHighlightingMode === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setFilesDiffSyntaxHighlightingMode(option.id)}
                        showChevron={false}
                    />
                ))}
                {FILES_CHANGED_FILES_DENSITY_OPTIONS.map((option) => (
                    <Item
                        key={option.id}
                        title={t(option.titleKey)}
                        subtitle={t(option.subtitleKey)}
                        icon={renderIcon(option.iconName)}
                        rightElement={effectiveFilesChangedFilesRowDensity === option.id ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                        onPress={() => setFilesChangedFilesRowDensity(option.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {backendPlugins.map((plugin) => (
                <ItemGroup key={plugin.backendId} title={t('settingsSourceControl.backends.backendGroupTitle', { backendTitle: plugin.title })} footer={plugin.description}>
                    {(() => {
                        const backendUiPlugin = scmUiBackendRegistry.getPlugin(plugin.backendId);
                        const availableModes = backendUiPlugin.diffModeConfig(null).availableModes;
                        return DIFF_MODE_OPTIONS
                            .filter((option) => availableModes.includes(option.id))
                            .map((option) => (
                                <Item
                                    key={`diff-${plugin.backendId}-${option.id}`}
                                    title={t('settingsSourceControl.backends.defaultDiffItemTitle', { backendTitle: plugin.title, diffModeTitle: t(option.titleKey) })}
                                    subtitle={t('settingsSourceControl.backends.defaultDiffItemSubtitle')}
                                    icon={renderIcon(option.iconName)}
                                    rightElement={
                                        currentDiffModeByBackend[plugin.backendId] === option.id
                                            ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} />
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
