import React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { createScmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { getFirstPartyScmBackendLegacyLocalId } from '@/scm/registry/firstPartyScmBackendIdentity';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createScmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';
import { useDaemonScmContributionCatalog } from '@/scm/registry/useDaemonScmContributionCatalog';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { getLanguageEnglishName, getLanguageNativeName, SUPPORTED_LANGUAGE_CODES, t, type TranslationKey } from '@/text';
import type { ImageBackground, ImageBackgroundByKind } from '@/sync/domains/settings/registry/local/localSettingDefinitions.files';
import { Switch } from '@/components/ui/forms/Switch';
import type {
    ScmGitRepoPreferredBackend,
    ScmPushRejectPolicy,
} from '@/scm/settings/preferences';
import {
    resolveScmGitRepoPreferredBackendId,
} from '@/scm/settings/preferences';
import {
    normalizeScmRemoteConfirmPolicy,
    shouldConfirmRemoteOperation,
} from '@/scm/settings/remoteConfirmationPolicy';
import { CommitMessageInstructionsSetting } from './CommitMessageInstructionsSetting';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
import { WalkthroughSavedSettings } from '@/components/settings/sourceControl/WalkthroughSavedSettings';
import { FileEditorAiSuggestionSettings } from '@/components/settings/sourceControl/FileEditorAiSuggestionSettings';
import { ResourceOpenLocationSetting } from '@/components/settings/sourceControl/ResourceOpenLocationSetting';


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

const IMAGE_BACKGROUND_OPTIONS = [
    { id: 'checkerboard', labelKey: 'files.viewer.backgroundCheckerboard' },
    { id: 'light', labelKey: 'files.viewer.backgroundLight' },
    { id: 'dark', labelKey: 'files.viewer.backgroundDark' },
] as const satisfies ReadonlyArray<Readonly<{ id: ImageBackground; labelKey: TranslationKey }>>;

/**
 * The preview background (lab FV4, P2 Background): the device's one value per kind, also set from a file's
 * `⋯ › Background`. The row sets images and SVGs together; when they differ it names both instead of picking one.
 */
function ImageBackgroundRow(props: Readonly<{ value: ImageBackgroundByKind | undefined; onChange: (value: ImageBackgroundByKind) => void }>) {
    const options = translateOptions(IMAGE_BACKGROUND_OPTIONS);
    const image = props.value?.image ?? 'checkerboard';
    const svg = props.value?.svg ?? 'checkerboard';
    const label = (id: ImageBackground) => options.find((option) => option.id === id)?.label ?? id;
    return (
        <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.imageBackground}>
            <SegmentedChoiceItem<ImageBackground>
                subtitleLines={0}
                title={t(SOURCE_CONTROL_SETTINGS.settings.imageBackground.titleKey)}
                subtitle={image === svg
                    ? t('settingsSourceControl.page.files.imageBackgroundDescription')
                    : t('settingsSourceControl.page.files.imageBackgroundMixed', { image: label(image), svg: label(svg) })}
                testIDPrefix="settings.sourceControl.imageBackground"
                options={options}
                value={image}
                onChange={(next) => props.onChange({ image: next, svg: next })}
            />
        </SettingAnchor>
    );
}

export const SourceControlSettingsView = React.memo(function SourceControlSettingsView() {
    const { push } = useRouter();
    // The canonical declaration gates legacy SCM rows; the mixed Files page is not gated.
    const scmWriteOperationsEnabled = useFeatureEnabled(SOURCE_CONTROL_SETTINGS.settings.commitStrategy.featureId!);
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl,
    );
    const executionTarget = administrationTargetSelection.resolveExecutionTarget();
    const contributionCatalog = useDaemonScmContributionCatalog({
        machineId: scmWriteOperationsEnabled ? executionTarget?.machine.id ?? null : null,
        serverId: scmWriteOperationsEnabled ? executionTarget?.serverId ?? null : null,
    });
    const [scmCommitStrategy, setScmCommitStrategy] = useSettingMutable('scmCommitStrategy');
    const [scmGitRepoPreferredBackend] = useSettingMutable('scmGitRepoPreferredBackend');
    const [scmGitRepoPreferredBackendQualifiedId] = useSettingMutable('scmGitRepoPreferredBackendQualifiedId');
    const { setSetting } = useSettingActionFeedback();
    const [explainChanges, setExplainChanges] = useSettingMutable('scm.diffSummary.enabled');
    const [prepareAfterTurn] = useSettingMutable('scm.diffSummary.prefetch');
    const [investigateSurroundingFiles] = useSettingMutable('scm.diffSummary.investigateSurroundingFiles');
    const [outputLanguage] = useSettingMutable('scm.diffSummary.outputLanguage');
    const [outputLanguageMenuOpen, setOutputLanguageMenuOpen] = React.useState(false);
    const selectedOutputLanguage = typeof outputLanguage === 'string' ? outputLanguage : '';
    // Empty follows the app language; a stored tag outside the app's languages stays listed as the current choice.
    const outputLanguageItems = React.useMemo(() => [
        { id: '', title: t('walkthroughSettings.appLanguage') },
        ...SUPPORTED_LANGUAGE_CODES.map((code) => {
            const nativeName = getLanguageNativeName(code);
            const englishName = getLanguageEnglishName(code);
            return { id: code, title: nativeName, subtitle: englishName !== nativeName ? englishName : undefined };
        }),
        ...(selectedOutputLanguage && !SUPPORTED_LANGUAGE_CODES.some((code) => code === selectedOutputLanguage)
            ? [{ id: selectedOutputLanguage, title: selectedOutputLanguage }] : []),
    ], [selectedOutputLanguage]);
    const [summaryRunnerChoice] = useSettingMutable('scm.diffSummary.runnerV1');
    const [summaryModelAvailable, setSummaryModelAvailable] = React.useState(false);
    const [scmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const [scmPushRejectPolicy, setScmPushRejectPolicy] = useSettingMutable('scmPushRejectPolicy');
    const [scmPullRequestPlacement, setScmPullRequestPlacement] = useSettingMutable('scmPullRequestPlacement');
    const [scmDefaultDiffModeByBackend] = useSettingMutable('scmDefaultDiffModeByBackend');
    const [filesDiffSyntaxHighlightingMode, setFilesDiffSyntaxHighlightingMode] = useSettingMutable('filesDiffSyntaxHighlightingMode');
    const [filesDiffRendererMode, setFilesDiffRendererMode] = useSettingMutable('filesDiffRendererMode');
    const [filesDiffPresentationStyle, setFilesDiffPresentationStyle] = useSettingMutable('filesDiffPresentationStyle');
    const [filesChangedFilesRowDensity, setFilesChangedFilesRowDensity] = useSettingMutable('filesChangedFilesRowDensity');
    const [scmGitPaneLayout, setScmGitPaneLayout] = useSettingMutable('scmGitPaneLayout');
    const [scmChangedFilesLayout, setScmChangedFilesLayout] = useSettingMutable('scmChangedFilesLayout');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [filesTrackAgentEdits, setFilesTrackAgentEdits] = useLocalSettingMutable('filesTrackAgentEdits');
    const [filesImageBackgroundByKind, setFilesImageBackgroundByKind] = useLocalSettingMutable('filesImageBackgroundByKind');
    const [filesAskWithoutSessionTarget, setFilesAskWithoutSessionTarget] = useSettingMutable('filesAskWithoutSessionTarget');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [scmCommitMessageGeneratorEnabled, setScmCommitMessageGeneratorEnabled] = useSettingMutable('scmCommitMessageGeneratorEnabled');
    const [scmCommitMessageGeneratorRunnerV1] = useSettingMutable('scmCommitMessageGeneratorRunnerV1');
    const [scmIncludeCoAuthoredBy, setScmIncludeCoAuthoredBy] = useSettingMutable('scmIncludeCoAuthoredBy');
    const [filesEditorAutoSave, setFilesEditorAutoSave] = useSettingMutable('filesEditorAutoSave');
    const [formatOnSave, setFormatOnSave] = useSettingMutable('filesEditorFormatOnSave');
    const [inlayHints, setInlayHints] = useSettingMutable('filesEditorInlayHints');
    const [semanticHighlighting, setSemanticHighlighting] = useSettingMutable('filesEditorSemanticHighlighting');
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
            ? [description, t('common.unavailable')].filter(Boolean).join(' · ')
            : description
    ), [contributionCatalogIsStale]);
    const currentDiffModeByBackend = scmDefaultDiffModeByBackend ?? {};
    const effectiveFilesDiffSyntaxHighlightingMode = filesDiffSyntaxHighlightingMode ?? settingsDefaults.filesDiffSyntaxHighlightingMode;
    const effectiveFilesDiffRendererMode = filesDiffRendererMode === 'happier' ? 'happier' : 'pierre';
    const effectiveFilesDiffPresentationStyle = filesDiffPresentationStyle === 'unified' || filesDiffPresentationStyle === 'split'
        ? filesDiffPresentationStyle
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const effectiveFilesChangedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const effectiveMarkdownDefaultEditMode = markdownDefaultEditMode === 'raw' ? 'raw' : 'rich';
    const effectiveCommitMessageGeneratorEnabled = scmCommitMessageGeneratorEnabled === true;
    const effectiveIncludeCoAuthoredBy = scmIncludeCoAuthoredBy === true;
    const effectiveRemoteConfirmPolicy = normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicy);
    const confirmsPull = shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'pull');
    const confirmsPush = shouldConfirmRemoteOperation(effectiveRemoteConfirmPolicy, 'push');
    const effectiveScmGitRepoPreferredBackendId = resolveScmGitRepoPreferredBackendId({
        legacyPreference: scmGitRepoPreferredBackend,
        qualifiedPreference: scmGitRepoPreferredBackendQualifiedId,
    });
    const setScmGitRepoPreferredBackend = React.useCallback((backendId: string) => {
        void setSetting(SOURCE_CONTROL_SETTINGS.settings.gitRouting, backendId);
    }, [setSetting]);

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
    // Independent setting bindings settle without changing the Machine control.
    // Keep its node stable so phone chrome does not withdraw and republish it on each settlement.
    const headerActions = React.useMemo(() => scmWriteOperationsEnabled ? (
        <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="settings.sourceControl.administration.target"
            presentation="chip"
        />
    ) : undefined, [administrationTargetSelection, scmWriteOperationsEnabled]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                description={t('settingsSourceControl.page.description')}
                actions={headerActions}
            />

            {scmWriteOperationsEnabled ? <>
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
                        <LlmTaskRunnerPicker
                            task="scm_commit_message"
                            value={scmCommitMessageGeneratorRunnerV1}
                            onChange={(next) => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.commitMessageAgent, projectNativeJsonValueForTransport(next)); }}
                            machineId={executionTarget?.machine.id ?? null}
                            serverId={executionTarget?.serverId ?? null}
                            engineFieldTitle={t(SOURCE_CONTROL_SETTINGS.settings.commitMessageAgent.titleKey)}
                            testIDPrefix="settings.sourceControl.commitMessageAgent"
                        />
                    </SettingAnchor>
                ) : null}
                {effectiveCommitMessageGeneratorEnabled ? (
                    <CommitMessageInstructionsSetting />
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

            <SettingSection section={SOURCE_CONTROL_SETTINGS.sectionRefs.walkthroughs}>
                <ItemGroup title={t('walkthroughSettings.title')} description={t('walkthroughSettings.description')}>
                    <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.explainChanges} subtitleLines={0} showChevron={false}
                        rightElement={<Switch value={explainChanges !== false} onValueChange={setExplainChanges} />}
                        onPress={() => setExplainChanges(explainChanges === false)} />
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.summaryModel}>
                        <LlmTaskRunnerPicker
                            task="scm_diff_summary"
                            value={summaryRunnerChoice}
                            onChange={next => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.summaryModel, projectNativeJsonValueForTransport(next)); }}
                            onAvailabilityChange={setSummaryModelAvailable}
                            machineId={executionTarget?.machine.id ?? null}
                            serverId={executionTarget?.serverId ?? null}
                            engineFieldTitle={t(SOURCE_CONTROL_SETTINGS.settings.summaryModel.titleKey)}
                            testIDPrefix="settings.sourceControl.summaryModel"
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.outputLanguage}>
                        <DropdownMenu
                            open={outputLanguageMenuOpen}
                            onOpenChange={setOutputLanguageMenuOpen}
                            items={outputLanguageItems}
                            selectedId={selectedOutputLanguage}
                            variant="selectable"
                            matchTriggerWidth
                            connectToTrigger
                            onSelect={(id) => {
                                void setSetting(SOURCE_CONTROL_SETTINGS.settings.outputLanguage, id);
                                setOutputLanguageMenuOpen(false);
                            }}
                            itemTrigger={{
                                title: t(SOURCE_CONTROL_SETTINGS.settings.outputLanguage.titleKey),
                                subtitle: t('walkthroughSettings.outputLanguageDescription'),
                                showSelectedSubtitle: false,
                                detailFormatter: (item) => item?.title ?? t('walkthroughSettings.appLanguage'),
                                itemProps: { testID: 'settings.sourceControl.outputLanguage', subtitleLines: 0 },
                            }}
                        />
                    </SettingAnchor>
                    <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.investigateSurroundingFiles} subtitleLines={0} showChevron={false}
                        rightElement={<Switch value={investigateSurroundingFiles === true}
                            onValueChange={value => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.investigateSurroundingFiles, value); }} />}
                        onPress={() => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.investigateSurroundingFiles, investigateSurroundingFiles !== true); }} />
                    <WalkthroughSavedSettings machineId={executionTarget?.machine.id ?? null} serverId={executionTarget?.serverId ?? null}
                        machineAvailability={administrationTargetSelection.state.kind}
                        machineName={administrationTargetSelection.candidates.find(candidate => candidate.target.machineId === executionTarget?.machine.id)?.displayName ?? routingScopeMachineName ?? ''}
                        prepareAfterTurn={prepareAfterTurn === true}
                        onPrepareAfterTurn={value => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.prepareAfterTurn, value); }} modelAvailable={summaryModelAvailable} />
                </ItemGroup>
            </SettingSection>

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
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.trackAgentEdits}
                    rightElement={<Switch value={filesTrackAgentEdits === true} onValueChange={setFilesTrackAgentEdits} />}
                    showChevron={false}
                    onPress={() => setFilesTrackAgentEdits(filesTrackAgentEdits !== true)}
                />
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.askWithoutSessionTarget}>
                    <SegmentedChoiceItem<'detached_run' | 'session'>
                        subtitleLines={0}
                        title={t(SOURCE_CONTROL_SETTINGS.settings.askWithoutSessionTarget.titleKey)}
                        subtitle={t('files.askSelection.targetDescription')}
                        testIDPrefix="settings.sourceControl.askWithoutSessionTarget"
                        options={[
                            { id: 'detached_run', label: t('files.askSelection.detachedRun') },
                            { id: 'session', label: t('files.askSelection.newSession') },
                        ]}
                        value={filesAskWithoutSessionTarget === 'session' ? 'session' : 'detached_run'}
                        onChange={setFilesAskWithoutSessionTarget}
                    />
                </SettingAnchor>
                <ImageBackgroundRow value={filesImageBackgroundByKind} onChange={setFilesImageBackgroundByKind} />
            </ItemGroup>
            </SettingSection>
            </> : null}

            <ResourceOpenLocationSetting>
                {scmWriteOperationsEnabled ? <>
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.confirmBeforePulling}
                    rightElement={(
                        <Switch
                            value={confirmsPull}
                            onValueChange={(value) => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.confirmBeforePulling, value); }}
                        />
                    )}
                    onPress={() => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.confirmBeforePulling, !confirmsPull); }}
                    showChevron={false}
                />
                <SettingRow
                    subtitleLines={0}
                    setting={SOURCE_CONTROL_SETTINGS.settings.confirmBeforePushing}
                    rightElement={(
                        <Switch
                            value={confirmsPush}
                            onValueChange={(value) => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.confirmBeforePushing, value); }}
                        />
                    )}
                    onPress={() => { void setSetting(SOURCE_CONTROL_SETTINGS.settings.confirmBeforePushing, !confirmsPush); }}
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
                </> : null}
            </ResourceOpenLocationSetting>

            {scmWriteOperationsEnabled ? <>
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
                    {hostingProviders.map((provider) => {
                        const serviceId = provider.serviceId;
                        return (
                        <Item
                            key={provider.providerId}
                            title={provider.title}
                            subtitle={describeProjectedMetadata(provider.description)}
                            onPress={!contributionCatalogIsStale && serviceId ? () => push({
                                pathname: '/(app)/settings/connected-services/[serviceId]',
                                params: { serviceId },
                            }) : undefined}
                            disabled={contributionCatalogIsStale}
                            showChevron={!contributionCatalogIsStale && provider.serviceId !== null}
                        />
                        );
                    })}
                </ItemGroup>
            ) : null}



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
                                        void setSetting(SOURCE_CONTROL_SETTINGS.settings.backendDefaultDiff, { backendId: plugin.backendId, mode });
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
            </> : null}

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
                <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.editorFormatOnSave} showChevron={false}
                    rightElement={<Switch value={formatOnSave} onValueChange={setFormatOnSave} />} onPress={() => setFormatOnSave(!formatOnSave)} />
                <SettingAnchor setting={SOURCE_CONTROL_SETTINGS.settings.editorInlayHints}>
                    <SegmentedChoiceItem<'off' | 'parameters' | 'all'> title={t('files.pane.menu.inlayHints')} value={inlayHints} onChange={setInlayHints}
                        options={[{ id: 'off', label: t('files.pane.menu.inlayOff') }, { id: 'parameters', label: t('files.pane.menu.inlayParameters') }, { id: 'all', label: t('files.pane.menu.inlayAll') }]} />
                </SettingAnchor>
                <SettingRow setting={SOURCE_CONTROL_SETTINGS.settings.editorSemanticHighlighting} showChevron={false}
                    rightElement={<Switch value={semanticHighlighting} onValueChange={setSemanticHighlighting} />} onPress={() => setSemanticHighlighting(!semanticHighlighting)} />
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
            <FileEditorAiSuggestionSettings machineId={executionTarget?.machine.id ?? null} serverId={executionTarget?.serverId ?? null} />
        </ItemList>
    );
});
