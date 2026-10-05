import React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { createScmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { getFirstPartyScmBackendLegacyLocalId } from '@/scm/registry/firstPartyScmBackendIdentity';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useApplySettings, useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createScmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import { useDaemonScmContributionCatalog } from '@/scm/registry/useDaemonScmContributionCatalog';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { t, type TranslationKey } from '@/text';
import { Switch } from '@/components/ui/forms/Switch';
import type {
    ScmGitRepoPreferredBackend,
    ScmPushRejectPolicy,
} from '@/scm/settings/preferences';
import {
    buildScmGitRepoBackendPreferenceSettingsDelta,
    resolveScmGitRepoPreferredBackendId,
} from '@/scm/settings/preferences';
import {
    normalizeScmRemoteConfirmPolicy,
    setRemoteConfirmationForKind,
    shouldConfirmRemoteOperation,
} from '@/scm/settings/remoteConfirmationPolicy';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';
import { ScmDiffSummaryModelPicker } from '@/components/settings/sourceControl/ScmDiffSummaryModelPicker';
import { WalkthroughSavedSettings } from '@/components/settings/sourceControl/WalkthroughSavedSettings';
import { Modal } from '@/modal';


/**
 * Without a machine's source-control backends, the routing section (which says to choose a machine)
 * also answers for the per-backend rows it cannot show yet.
 */
const BACKEND_SECTIONS = [SOURCE_CONTROL_SETTINGS.sectionRefs.backends];

/** Anchors the per-backend default-diff row on one backend only, so a search reveal marks one row. */
function BackendDefaultDiffAnchor(props: Readonly<{ anchored: boolean; children: React.ReactElement; showDivider?: boolean }>) {
    if (!props.anchored) {
        return props.showDivider === undefined
            ? props.children
            : React.cloneElement(props.children as React.ReactElement<{ showDivider?: boolean }>, { showDivider: props.showDivider });
    }
    return <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.backendDefaultDiff} showDivider={props.showDivider}>{props.children}</SettingAnchor>;
}

const COMMIT_STRATEGY_OPTIONS: ReadonlyArray<{
    id: ScmCommitStrategy;
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'atomic', labelKey: 'settingsSourceControl.page.commitStrategy.atomic', descriptionKey: 'settingsSourceControl.page.commitStrategy.atomicDescription' },
    { id: 'git_staging', labelKey: 'settingsSourceControl.page.commitStrategy.gitStaging', descriptionKey: 'settingsSourceControl.page.commitStrategy.gitStagingDescription' },
];

const LEGACY_GIT_REPO_BACKEND_OPTIONS: ReadonlyArray<{
    id: ScmGitRepoPreferredBackend;
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'git', labelKey: 'settingsSourceControl.page.routing.git', descriptionKey: 'settingsSourceControl.gitRoutingPreference.options.git.subtitle' },
    { id: 'sapling', labelKey: 'settingsSourceControl.page.routing.sapling', descriptionKey: 'settingsSourceControl.gitRoutingPreference.options.sapling.subtitle' },
];

const PUSH_REJECT_OPTIONS: ReadonlyArray<{
    id: ScmPushRejectPolicy;
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'prompt_fetch', labelKey: 'settingsSourceControl.page.pushRejection.ask', descriptionKey: 'settingsSourceControl.page.pushRejection.askDescription' },
    { id: 'auto_fetch', labelKey: 'settingsSourceControl.page.pushRejection.fetch', descriptionKey: 'settingsSourceControl.page.pushRejection.fetchDescription' },
    { id: 'manual', labelKey: 'settingsSourceControl.page.pushRejection.manual', descriptionKey: 'settingsSourceControl.page.pushRejection.manualDescription' },
];

const DIFF_MODE_OPTIONS: ReadonlyArray<{
    id: ScmDiffArea;
    labelKey: TranslationKey;
}> = [
    { id: 'pending', labelKey: 'settingsSourceControl.diffMode.pending' },
    { id: 'both', labelKey: 'settingsSourceControl.diffMode.combined' },
    { id: 'included', labelKey: 'settingsSourceControl.diffMode.included' },
];

const FILES_SYNTAX_HIGHLIGHTING_OPTIONS: ReadonlyArray<{
    id: 'off' | 'simple' | 'advanced';
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'off', labelKey: 'settingsSourceControl.page.files.off', descriptionKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.off.subtitle' },
    { id: 'simple', labelKey: 'settingsSourceControl.page.files.simple', descriptionKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.simple.subtitle' },
    { id: 'advanced', labelKey: 'settingsSourceControl.page.files.advanced', descriptionKey: 'settingsSourceControl.filesDisplay.syntaxHighlighting.options.advanced.subtitle' },
];

const FILES_DIFF_RENDERER_OPTIONS: ReadonlyArray<{
    id: 'pierre' | 'happier';
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'pierre', labelKey: 'settingsSourceControl.page.files.rendererPierre', descriptionKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.pierre.subtitle' },
    { id: 'happier', labelKey: 'settingsSourceControl.page.files.rendererHappier', descriptionKey: 'settingsSourceControl.filesDisplay.diffRenderer.options.happier.subtitle' },
];

const FILES_DIFF_PRESENTATION_OPTIONS: ReadonlyArray<{
    id: 'unified' | 'split';
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'unified', labelKey: 'settingsSourceControl.page.files.unified', descriptionKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.subtitle' },
    { id: 'split', labelKey: 'settingsSourceControl.page.files.split', descriptionKey: 'settingsSourceControl.filesDisplay.diffPresentation.options.split.subtitle' },
];

const FILES_CHANGED_FILES_DENSITY_OPTIONS: ReadonlyArray<{
    id: 'comfortable' | 'compact';
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'comfortable', labelKey: 'settingsSourceControl.page.files.comfortable', descriptionKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.comfortable.subtitle' },
    { id: 'compact', labelKey: 'settingsSourceControl.page.files.compact', descriptionKey: 'settingsSourceControl.filesDisplay.changedFilesDensity.options.compact.subtitle' },
];

const PULL_REQUEST_PLACEMENT_OPTIONS: ReadonlyArray<{
    id: 'sidebar' | 'details';
    labelKey: TranslationKey;
}> = [
    { id: 'sidebar', labelKey: 'sessionGitPullRequest.settings.sidebar' },
    { id: 'details', labelKey: 'sessionGitPullRequest.settings.details' },
];

const MARKDOWN_EDIT_MODE_OPTIONS: ReadonlyArray<{
    id: 'rich' | 'raw';
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    { id: 'rich', labelKey: 'settingsSourceControl.page.editor.rich', descriptionKey: 'settingsSourceControl.markdownEditMode.options.rich.subtitle' },
    { id: 'raw', labelKey: 'settingsSourceControl.page.editor.raw', descriptionKey: 'settingsSourceControl.markdownEditMode.options.raw.subtitle' },
];

/** Options for a segmented row, translated. */
const SCM_GIT_PANE_LAYOUT_OPTIONS = [
    { id: 'unified', labelKey: 'sessionGitDisplay.layoutUnified' },
    { id: 'tabs', labelKey: 'sessionGitDisplay.layoutTabs' },
] as const satisfies ReadonlyArray<{ id: 'unified' | 'tabs'; labelKey: TranslationKey }>;
const SCM_CHANGED_FILES_LAYOUT_OPTIONS = [
    { id: 'list', labelKey: 'sessionGitDisplay.showAsList' },
    { id: 'tree', labelKey: 'sessionGitDisplay.showAsTree' },
] as const satisfies ReadonlyArray<{ id: 'list' | 'tree'; labelKey: TranslationKey }>;

function translateOptions<T extends string>(options: ReadonlyArray<{ id: T; labelKey: TranslationKey; descriptionKey?: TranslationKey }>) {
    return options.map((option) => ({
        id: option.id,
        label: t(option.labelKey),
        description: option.descriptionKey ? t(option.descriptionKey) : undefined,
    }));
}

/** The most a segmented row holds; longer backend lists use a field select. */
const MAX_SEGMENTED_OPTIONS = 4;

export const SourceControlSettingsView = React.memo(function SourceControlSettingsView() {
    const { push } = useRouter();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl,
    );
    const executionTarget = administrationTargetSelection.resolveExecutionTarget();
    const contributionCatalog = useDaemonScmContributionCatalog({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
    });
    const [scmCommitStrategy, setScmCommitStrategy] = useSettingMutable('scmCommitStrategy');
    const [scmGitRepoPreferredBackend] = useSettingMutable('scmGitRepoPreferredBackend');
    const [scmGitRepoPreferredBackendQualifiedId] = useSettingMutable('scmGitRepoPreferredBackendQualifiedId');
    const applySettings = useApplySettings();
    const settingsScope = useAccountSettingsScope();
    const [explainChanges, setExplainChanges] = useSettingMutable('scm.diffSummary.enabled');
    const [prepareAfterTurn] = useSettingMutable('scm.diffSummary.prefetch');
    const [summaryModel] = useSettingMutable('scm.diffSummary.modelProfileOverride');
    const [summaryModelAvailable, setSummaryModelAvailable] = React.useState(false);
    const setWalkthroughSetting = async (anchor: string, value: string | boolean) => {
        if (!settingsScope) { Modal.alert(t('common.error'), t('walkthroughSettings.unavailable')); return; }
        try {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const result = await createDefaultActionExecutor().execute('settings.set', { anchor, value }, { surface: 'ui',
                serverId: settingsScope.serverId, expectedAccountId: settingsScope.accountId });
            if (!result.ok || result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false) {
                Modal.alert(t('common.error'), t('walkthroughSettings.unavailable'));
            }
        } catch { Modal.alert(t('common.error'), t('walkthroughSettings.unavailable')); }
    };
    const [scmRemoteConfirmPolicy, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const [scmPushRejectPolicy, setScmPushRejectPolicy] = useSettingMutable('scmPushRejectPolicy');
    const [scmPullRequestPlacement, setScmPullRequestPlacement] = useSettingMutable('scmPullRequestPlacement');
    const [scmDefaultDiffModeByBackend, setScmDefaultDiffModeByBackend] = useSettingMutable('scmDefaultDiffModeByBackend');
    const [filesDiffSyntaxHighlightingMode, setFilesDiffSyntaxHighlightingMode] = useSettingMutable('filesDiffSyntaxHighlightingMode');
    const [filesDiffRendererMode, setFilesDiffRendererMode] = useSettingMutable('filesDiffRendererMode');
    const [filesDiffPresentationStyle, setFilesDiffPresentationStyle] = useSettingMutable('filesDiffPresentationStyle');
    const [filesChangedFilesRowDensity, setFilesChangedFilesRowDensity] = useSettingMutable('filesChangedFilesRowDensity');
    const [scmGitPaneLayout, setScmGitPaneLayout] = useSettingMutable('scmGitPaneLayout');
    const [scmChangedFilesLayout, setScmChangedFilesLayout] = useSettingMutable('scmChangedFilesLayout');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [scmCommitMessageGeneratorEnabled, setScmCommitMessageGeneratorEnabled] = useSettingMutable('scmCommitMessageGeneratorEnabled');
    const [scmCommitMessageGeneratorBackendId, setScmCommitMessageGeneratorBackendId] = useSettingMutable('scmCommitMessageGeneratorBackendId');
    const [scmCommitMessageGeneratorInstructions, setScmCommitMessageGeneratorInstructions] = useSettingMutable('scmCommitMessageGeneratorInstructions');
    const [scmIncludeCoAuthoredBy, setScmIncludeCoAuthoredBy] = useSettingMutable('scmIncludeCoAuthoredBy');
    const [filesEditorAutoSave, setFilesEditorAutoSave] = useSettingMutable('filesEditorAutoSave');
    const [markdownDefaultEditMode, setMarkdownDefaultEditMode] = useSettingMutable('markdownDefaultEditMode');
    const markdownRichEditorEnabled = useFeatureEnabled('files.markdownRichEditor');
    const backendSettingsRegistry = React.useMemo(
        () => createScmBackendSettingsRegistry(contributionCatalog),
        [contributionCatalog],
    );
    const backendUiRegistry = React.useMemo(
        () => createScmUiBackendRegistry(contributionCatalog),
        [contributionCatalog],
    );
    const backendPlugins = backendSettingsRegistry.listPlugins();
    const hostingProviders = backendSettingsRegistry.listHostingProviders();
    const contributionCatalogIsStale = contributionCatalog.state === 'stale';
    const describeProjectedMetadata = React.useCallback((description: string) => (
        contributionCatalogIsStale
            ? [description, t('status.offline')].filter(Boolean).join(' · ')
            : description
    ), [contributionCatalogIsStale]);
    const currentDiffModeByBackend = scmDefaultDiffModeByBackend ?? {};
    const effectiveFilesDiffSyntaxHighlightingMode = (filesDiffSyntaxHighlightingMode ?? 'off') as 'off' | 'simple' | 'advanced';
    const effectiveFilesDiffRendererMode = filesDiffRendererMode === 'happier' ? 'happier' : 'pierre';
    const effectiveFilesDiffPresentationStyle = filesDiffPresentationStyle === 'unified' || filesDiffPresentationStyle === 'split'
        ? filesDiffPresentationStyle
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const effectiveFilesChangedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const effectiveMarkdownDefaultEditMode = markdownDefaultEditMode === 'raw' ? 'raw' : 'rich';
    const effectiveCommitMessageGeneratorEnabled = scmCommitMessageGeneratorEnabled === true;
    const effectiveCommitMessageGeneratorBackendId = typeof scmCommitMessageGeneratorBackendId === 'string' && scmCommitMessageGeneratorBackendId.trim()
        ? scmCommitMessageGeneratorBackendId.trim()
        : DEFAULT_AGENT_ID;
    const effectiveCommitMessageGeneratorInstructions = typeof scmCommitMessageGeneratorInstructions === 'string'
        ? scmCommitMessageGeneratorInstructions
        : '';
    const effectiveIncludeCoAuthoredBy = scmIncludeCoAuthoredBy === true;
    const effectiveRemoteConfirmPolicy = normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicy);
    const confirmsPull = shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'pull');
    const confirmsPush = shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'push');
    const effectiveScmGitRepoPreferredBackendId = resolveScmGitRepoPreferredBackendId({
        legacyPreference: scmGitRepoPreferredBackend,
        qualifiedPreference: scmGitRepoPreferredBackendQualifiedId,
    });
    const setScmGitRepoPreferredBackend = React.useCallback((backendId: string) => {
        const delta = buildScmGitRepoBackendPreferenceSettingsDelta(backendId);
        if (delta) applySettings(delta);
    }, [applySettings]);

    const routingScopeState = administrationTargetSelection.state;
    const routingScopeMachineName = routingScopeState.kind === 'unselected'
        ? null
        : routingScopeState.kind === 'online'
            ? routingScopeState.machine.displayName
            : routingScopeState.snapshot?.displayName ?? routingScopeState.target.machineId;
    const routingOptions = contributionCatalog.source === 'legacy'
        ? LEGACY_GIT_REPO_BACKEND_OPTIONS.map((option) => ({
            id: resolveScmGitRepoPreferredBackendId({ legacyPreference: option.id, qualifiedPreference: null }),
            preferenceId: option.id as string,
            label: t(option.labelKey),
            description: t(option.descriptionKey),
        }))
        : contributionCatalog.backends.map((backend) => ({
            id: backend.id,
            preferenceId: backend.id,
            label: backend.title,
            description: describeProjectedMetadata(backend.description) || undefined,
        }));
    const selectedRoutingOption = routingOptions.find((option) => option.id === effectiveScmGitRepoPreferredBackendId);
    const [routingMenuOpen, setRoutingMenuOpen] = React.useState(false);

    // One anchor per page for the per-backend default diff: search reveals the first backend that
    // offers a choice, and the first backend's section answers when none does.
    const defaultDiffAnchorBackendIndex = backendPlugins.findIndex((plugin) => (
        backendUiRegistry.getPlugin(plugin.backendId).diffModeConfig(null).availableModes
            .some((mode) => DIFF_MODE_OPTIONS.some((option) => option.id === mode))
    ));

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                description={t('settingsSourceControl.page.description')}
                actions={(
                    <MachineAdministrationTargetSelector
                        selection={administrationTargetSelection}
                        testIDPrefix="settings.sourceControl.administration.target"
                        presentation="chip"
                    />
                )}
            />

            {/* The generator's agent and instructions wait on its switch, in this section. */}
            <SettingSection section={SOURCE_CONTROL_SETTINGS.sectionRefs.commits}>
            <ItemGroup
                title={t('settingsSourceControl.page.commits.title')}
                description={t('settingsSourceControl.page.commits.description')}
            >
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.commitStrategy}>
                    <SegmentedChoiceItem<ScmCommitStrategy>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.commitStrategy.titleKey)}
                        testIDPrefix="settings.sourceControl.commitStrategy"
                        options={translateOptions(COMMIT_STRATEGY_OPTIONS)}
                        value={scmCommitStrategy === 'git_staging' ? 'git_staging' : 'atomic'}
                        onChange={setScmCommitStrategy}
                    />
                </SettingAnchor>
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.commitMessageGenerator}
                    rightElement={(
                        <Switch
                            value={effectiveCommitMessageGeneratorEnabled}
                            onValueChange={(value) => setScmCommitMessageGeneratorEnabled(value)}
                        />
                    )}
                    onPress={() => setScmCommitMessageGeneratorEnabled(!effectiveCommitMessageGeneratorEnabled)}
                    showChevron={false}
                />
                {effectiveCommitMessageGeneratorEnabled ? (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.commitMessageAgent}>
                        <FieldValueItem
                            subtitleLines={0}
                            title={t(SOURCE_CONTROL_SETTINGS.settings.commitMessageAgent.titleKey)}
                            subtitle={t('settingsSourceControl.page.generator.agentDescription')}
                            fieldTestID="settings.sourceControl.commitMessageAgent"
                            placeholder={DEFAULT_AGENT_ID}
                            value={effectiveCommitMessageGeneratorBackendId}
                            onCommit={(draft) => {
                                const next = draft.trim();
                                if (!next) return effectiveCommitMessageGeneratorBackendId;
                                setScmCommitMessageGeneratorBackendId(next);
                                return next;
                            }}
                        />
                    </SettingAnchor>
                ) : null}
                {effectiveCommitMessageGeneratorEnabled ? (
                    <SettingRow
                        subtitleLines={0}
                        setting={SOURCE_CONTROL_SETTINGS.settings.commitMessageInstructions}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID="settings.sourceControl.commitMessageInstructions"
                                accessibilityLabel={t(SOURCE_CONTROL_SETTINGS.settings.commitMessageInstructions.titleKey)}
                                placeholder={t('settingsSourceControl.commitMessageGenerator.instructionsPlaceholder')}
                                value={effectiveCommitMessageGeneratorInstructions}
                                multiline
                                autoCapitalize="sentences"
                                onChangeText={(value) => setScmCommitMessageGeneratorInstructions(String(value))}
                            />
                        )}
                    />
                ) : null}
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.includeCoAuthoredBy}
                    rightElement={(
                        <Switch
                            value={effectiveIncludeCoAuthoredBy}
                            onValueChange={(value) => setScmIncludeCoAuthoredBy(value)}
                        />
                    )}
                    onPress={() => setScmIncludeCoAuthoredBy(!effectiveIncludeCoAuthoredBy)}
                    showChevron={false}
                />
            </ItemGroup>
            </SettingSection>

            <ItemGroup
                title={t('settingsSourceControl.page.remote.title')}
                description={t('settingsSourceControl.page.remote.description')}
            >
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.confirmBeforePulling}
                    rightElement={(
                        <Switch
                            value={confirmsPull}
                            onValueChange={(value) => setScmRemoteConfirmPolicy(setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'pull', value))}
                        />
                    )}
                    onPress={() => setScmRemoteConfirmPolicy(setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'pull', !confirmsPull))}
                    showChevron={false}
                />
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.confirmBeforePushing}
                    rightElement={(
                        <Switch
                            value={confirmsPush}
                            onValueChange={(value) => setScmRemoteConfirmPolicy(setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'push', value))}
                        />
                    )}
                    onPress={() => setScmRemoteConfirmPolicy(setRemoteConfirmationForKind(effectiveRemoteConfirmPolicy, 'push', !confirmsPush))}
                    showChevron={false}
                />
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.pushRejection}>
                    <SegmentedChoiceItem<ScmPushRejectPolicy>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.pushRejection.titleKey)}
                        testIDPrefix="settings.sourceControl.pushRejection"
                        options={translateOptions(PUSH_REJECT_OPTIONS)}
                        value={PUSH_REJECT_OPTIONS.some((option) => option.id === scmPushRejectPolicy) ? scmPushRejectPolicy as ScmPushRejectPolicy : 'prompt_fetch'}
                        onChange={setScmPushRejectPolicy}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.pullRequestPlacement}>
                    <SegmentedChoiceItem<'sidebar' | 'details'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.pullRequestPlacement.titleKey)}
                        subtitle={t('sessionGitPullRequest.settings.placementDescription')}
                        testIDPrefix="settings.sourceControl.pullRequestPlacement"
                        options={translateOptions(PULL_REQUEST_PLACEMENT_OPTIONS)}
                        value={scmPullRequestPlacement === 'details' ? 'details' : 'sidebar'}
                        onChange={setScmPullRequestPlacement}
                    />
                </SettingAnchor>
            </ItemGroup>

            <SettingSection section={SOURCE_CONTROL_SETTINGS.sectionRefs.routing} answersFor={backendPlugins.length > 0 ? undefined : BACKEND_SECTIONS}>
            <ItemGroup
                title={t('settingsSourceControl.page.routing.title')}
                description={t('settingsSourceControl.page.routing.description')}
            >
                {routingOptions.length === 0 ? (
                    <Item
                        testID="settings.sourceControl.routing.scopeState"
                        title={routingScopeMachineName === null
                            ? t('settingsSourceControl.page.routing.chooseMachine')
                            : routingScopeState.kind === 'online'
                                ? t('settingsSourceControl.page.routing.waiting', { machine: routingScopeMachineName })
                                : routingScopeState.kind === 'offline'
                                    ? t('settingsSourceControl.page.routing.offline', { machine: routingScopeMachineName })
                                    : t('settingsSourceControl.page.routing.unavailable', { machine: routingScopeMachineName })}
                        subtitle={routingScopeMachineName === null
                            ? t('settingsSourceControl.page.routing.chooseMachineDescription')
                            : routingScopeState.kind === 'online' || routingScopeState.kind === 'offline'
                                ? t('settingsSourceControl.page.routing.waitingDescription')
                                : t('settingsSourceControl.page.routing.unavailableDescription')}
                        showChevron={false}
                    />
                ) : routingOptions.length <= MAX_SEGMENTED_OPTIONS ? (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.gitRouting}>
                        <SegmentedChoiceItem<string>
                            subtitleLines={0}
                            title={t(SOURCE_CONTROL_SETTINGS.settings.gitRouting.titleKey)}
                            testIDPrefix="settings.sourceControl.gitRouting"
                            options={routingOptions}
                            value={selectedRoutingOption?.id ?? ''}
                            disabled={contributionCatalogIsStale}
                            onChange={(next) => {
                                const option = routingOptions.find((candidate) => candidate.id === next);
                                if (option) setScmGitRepoPreferredBackend(option.preferenceId);
                            }}
                        />
                    </SettingAnchor>
                ) : (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.gitRouting}>
                        <DropdownMenu
                            open={routingMenuOpen}
                            onOpenChange={setRoutingMenuOpen}
                            selectedId={selectedRoutingOption?.id}
                            items={routingOptions.map((option) => ({ id: option.id, title: option.label, subtitle: option.description }))}
                            onSelect={(id) => {
                                const option = routingOptions.find((candidate) => candidate.id === id);
                                if (option && !contributionCatalogIsStale) setScmGitRepoPreferredBackend(option.preferenceId);
                                setRoutingMenuOpen(false);
                            }}
                            itemTrigger={{
                                title: t(SOURCE_CONTROL_SETTINGS.settings.gitRouting.titleKey),
                                subtitle: selectedRoutingOption?.description,
                            }}
                        />
                    </SettingAnchor>
                )}
            </ItemGroup>
            </SettingSection>

            {hostingProviders.length > 0 ? (
                <ItemGroup
                    title={t('connectedServices.title')}
                    description={t('settingsSourceControl.page.services.description')}
                >
                    {hostingProviders.map((provider) => (
                        <Item
                            key={provider.providerId}
                            title={provider.title}
                            subtitle={describeProjectedMetadata(provider.description)}
                            onPress={!contributionCatalogIsStale && provider.serviceId ? () => push({
                                pathname: '/(app)/settings/connected-services/[serviceId]',
                                params: { serviceId: provider.serviceId },
                            }) : undefined}
                            disabled={contributionCatalogIsStale}
                            showChevron={!contributionCatalogIsStale && provider.serviceId !== null}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {/* The layout row exists only with the Pierre renderer; the section (with its Renderer row) answers otherwise. */}
            <SettingSection section={SOURCE_CONTROL_SETTINGS.sectionRefs.files}>
            <ItemGroup
                title={t('settingsSourceControl.page.files.title')}
                description={t('settingsSourceControl.page.files.description')}
            >
                {(Platform.OS === 'web' || String(Platform.OS) === 'node') ? (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.diffRenderer}>
                        <SegmentedChoiceItem<'pierre' | 'happier'>
                            subtitleLines={0}
                            title={t(SOURCE_CONTROL_SETTINGS.settings.diffRenderer.titleKey)}
                            testIDPrefix="settings.sourceControl.diffRenderer"
                            options={translateOptions(FILES_DIFF_RENDERER_OPTIONS)}
                            value={effectiveFilesDiffRendererMode}
                            onChange={setFilesDiffRendererMode}
                        />
                    </SettingAnchor>
                ) : null}
                {(Platform.OS === 'web' || String(Platform.OS) === 'node') && effectiveFilesDiffRendererMode === 'pierre' ? (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.diffLayout}>
                        <SegmentedChoiceItem<'unified' | 'split'>
                            subtitleLines={0}
                            title={t(SOURCE_CONTROL_SETTINGS.settings.diffLayout.titleKey)}
                            testIDPrefix="settings.sourceControl.diffLayout"
                            options={translateOptions(FILES_DIFF_PRESENTATION_OPTIONS)}
                            value={effectiveFilesDiffPresentationStyle}
                            onChange={setFilesDiffPresentationStyle}
                        />
                    </SettingAnchor>
                ) : null}
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.syntaxHighlighting}>
                    <SegmentedChoiceItem<'off' | 'simple' | 'advanced'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.syntaxHighlighting.titleKey)}
                        testIDPrefix="settings.sourceControl.syntaxHighlighting"
                        options={translateOptions(FILES_SYNTAX_HIGHLIGHTING_OPTIONS)}
                        value={effectiveFilesDiffSyntaxHighlightingMode}
                        onChange={setFilesDiffSyntaxHighlightingMode}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.gitPaneLayout}>
                    <SegmentedChoiceItem<'unified' | 'tabs'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.gitPaneLayout.titleKey)}
                        testIDPrefix="settings.sourceControl.gitPaneLayout"
                        options={translateOptions(SCM_GIT_PANE_LAYOUT_OPTIONS)}
                        value={scmGitPaneLayout === 'tabs' ? 'tabs' : 'unified'}
                        onChange={setScmGitPaneLayout}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.changedFilesLayout}>
                    <SegmentedChoiceItem<'list' | 'tree'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.changedFilesLayout.titleKey)}
                        testIDPrefix="settings.sourceControl.changedFilesLayout"
                        options={translateOptions(SCM_CHANGED_FILES_LAYOUT_OPTIONS)}
                        value={scmChangedFilesLayout === 'tree' ? 'tree' : 'list'}
                        onChange={setScmChangedFilesLayout}
                    />
                </SettingAnchor>
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.changedFilesDensity}>
                    <SegmentedChoiceItem<'comfortable' | 'compact'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.changedFilesDensity.titleKey)}
                        testIDPrefix="settings.sourceControl.changedFilesDensity"
                        options={translateOptions(FILES_CHANGED_FILES_DENSITY_OPTIONS)}
                        value={effectiveFilesChangedFilesRowDensity}
                        onChange={setFilesChangedFilesRowDensity}
                    />
                </SettingAnchor>
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.showLineNumbersInDiffs}
                    rightElement={<Switch value={showLineNumbers === true} onValueChange={setShowLineNumbers} />}
                    showChevron={false}
                    onPress={() => setShowLineNumbers(showLineNumbers !== true)}
                />
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.showLineNumbersInToolViews}
                    rightElement={<Switch value={showLineNumbersInToolViews === true} onValueChange={setShowLineNumbersInToolViews} />}
                    showChevron={false}
                    onPress={() => setShowLineNumbersInToolViews(showLineNumbersInToolViews !== true)}
                />
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.wrapLinesInDiffs}
                    rightElement={<Switch value={wrapLinesInDiffs === true} onValueChange={setWrapLinesInDiffs} />}
                    showChevron={false}
                    onPress={() => setWrapLinesInDiffs(wrapLinesInDiffs !== true)}
                />
            </ItemGroup>
            </SettingSection>

            <SettingSection section={SOURCE_CONTROL_SETTINGS.sectionRefs.walkthroughs}>
                <ItemGroup title={t('walkthroughSettings.title')} description={t('walkthroughSettings.description')}>
                    <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.explainChanges} subtitleLines={0} showChevron={false}
                        rightElement={<Switch value={explainChanges !== false} onValueChange={setExplainChanges} />}
                        onPress={() => setExplainChanges(explainChanges === false)} />
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.summaryModel}>
                        <ScmDiffSummaryModelPicker value={typeof summaryModel === 'string' ? summaryModel : ''}
                            onChange={value => { void setWalkthroughSetting(SOURCE_CONTROL_SETTINGS.settings.summaryModel.anchor, value); }}
                            onAvailabilityChange={setSummaryModelAvailable}
                            machineId={executionTarget?.machine.id} serverId={executionTarget?.serverId} testID="settings.sourceControl.summaryModel" />
                    </SettingAnchor>
                    <WalkthroughSavedSettings machineId={executionTarget?.machine.id ?? null} serverId={executionTarget?.serverId ?? null}
                        machineName={administrationTargetSelection.candidates.find(candidate => candidate.target.machineId === executionTarget?.machine.id)?.displayName ?? ''}
                        prepareAfterTurn={prepareAfterTurn === true}
                        onPrepareAfterTurn={value => { void setWalkthroughSetting(SOURCE_CONTROL_SETTINGS.settings.prepareAfterTurn.anchor, value); }} modelAvailable={summaryModelAvailable} />
                </ItemGroup>
            </SettingSection>

            {backendPlugins.map((plugin, backendIndex) => {
                const backendUiPlugin = backendUiRegistry.getPlugin(plugin.backendId);
                const availableModes = backendUiPlugin.diffModeConfig(null).availableModes;
                const legacyBackendId = getFirstPartyScmBackendLegacyLocalId(plugin.backendId);
                const selectedDiffMode = currentDiffModeByBackend[plugin.backendId]
                    ?? (legacyBackendId ? currentDiffModeByBackend[legacyBackendId] : undefined);
                const diffModeOptions = translateOptions(DIFF_MODE_OPTIONS.filter((option) => availableModes.includes(option.id)));
                const anchorsDefaultDiff = backendIndex === defaultDiffAnchorBackendIndex;
                const group = (
                    <ItemGroup
                        key={plugin.backendId}
                        title={t('settingsSourceControl.backends.backendGroupTitle', { backendTitle: plugin.title })}
                        description={plugin.description}
                    >
                        {diffModeOptions.length > 0 ? (
                            <BackendDefaultDiffAnchor anchored={anchorsDefaultDiff}>
                                {diffModeOptions.length > 1 ? (
                                <SegmentedChoiceItem<ScmDiffArea>
                                    subtitleLines={0}
                                    testID={`settings.sourceControl.backend.${plugin.backendId}.defaultDiff`}
                                    title={t(SOURCE_CONTROL_SETTINGS.settings.backendDefaultDiff.titleKey)}
                                    subtitle={t('settingsSourceControl.backends.defaultDiffItemSubtitle')}
                                    testIDPrefix={`settings.sourceControl.backend.${plugin.backendId}.defaultDiff`}
                                    options={diffModeOptions}
                                    value={selectedDiffMode ?? diffModeOptions[0].id}
                                    disabled={contributionCatalogIsStale}
                                    onChange={(mode) => {
                                        setScmDefaultDiffModeByBackend({
                                            ...currentDiffModeByBackend,
                                            [plugin.backendId]: mode,
                                        });
                                    }}
                                />
                            ) : (
                                <Item
                                    testID={`settings.sourceControl.backend.${plugin.backendId}.defaultDiff`}
                                    title={t(SOURCE_CONTROL_SETTINGS.settings.backendDefaultDiff.titleKey)}
                                    subtitle={t('settingsSourceControl.backends.defaultDiffItemSubtitle')}
                                    detail={diffModeOptions[0].label}
                                    showChevron={false}
                                />
                            )}
                            </BackendDefaultDiffAnchor>
                        ) : null}
                        {plugin.infoItems.map((item) => (
                            <Item
                                key={item.id}
                                title={item.title}
                                subtitle={item.subtitle}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                );
                return backendIndex === 0 ? (
                    <SettingSection key={plugin.backendId} section={SOURCE_CONTROL_SETTINGS.sectionRefs.backends}>{group}</SettingSection>
                ) : group;
            })}

            <ItemGroup
                title={t('settingsSourceControl.editor')}
                description={t('settingsSourceControl.page.editor.description')}
            >
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.editorAutoSave}
                    rightElement={
                        <Switch
                            value={filesEditorAutoSave === true}
                            onValueChange={setFilesEditorAutoSave}
                        />
                    }
                    onPress={() => setFilesEditorAutoSave(filesEditorAutoSave !== true)}
                    showChevron={false}
                />
                {markdownRichEditorEnabled ? (
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.markdownEditMode}>
                        <SegmentedChoiceItem<'rich' | 'raw'>
                            subtitleLines={0}
                            title={t(SOURCE_CONTROL_SETTINGS.settings.markdownEditMode.titleKey)}
                            testIDPrefix="settings.sourceControl.markdownEditMode"
                            options={translateOptions(MARKDOWN_EDIT_MODE_OPTIONS)}
                            value={effectiveMarkdownDefaultEditMode}
                            onChange={setMarkdownDefaultEditMode}
                        />
                    </SettingAnchor>
                ) : null}
            </ItemGroup>
        </ItemList>
    );
});
