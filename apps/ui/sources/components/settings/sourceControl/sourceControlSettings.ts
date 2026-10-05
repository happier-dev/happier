import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';

/** The searchable settings of the `sourceControl` page. Rows render their labels from these declarations. */
export const SOURCE_CONTROL_SETTINGS = defineSettingsPage({
    pageId: 'sourceControl',
    sections: {
        walkthroughs: {
            titleKey: 'walkthroughSettings.title',
            settings: {
                explainChanges: { storage: { scope: 'account', key: 'scm.diffSummary.enabled', access: 'read_write' }, titleKey: 'walkthroughSettings.enabled', descriptionKey: 'walkthroughSettings.enabledDescription' },
                summaryModel: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride), titleKey: 'walkthroughSettings.model', descriptionKey: 'walkthroughSettings.modelDescription' },
                prepareAfterTurn: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch), titleKey: 'walkthroughSettings.prefetch', descriptionKey: 'walkthroughSettings.prefetchDescription' },
                savedWalkthroughs: { titleKey: 'walkthroughSettings.saved', descriptionKey: 'walkthroughSettings.savedDescription' },
            },
        },
        commits: {
            titleKey: 'settingsSourceControl.page.commits.title',
            settings: {
                commitStrategy: { storage: { scope: 'account', key: 'scmCommitStrategy', access: 'read_write' },
                    titleKey: 'settingsSourceControl.page.commitStrategy.title',
                    keywordKeys: ['settingsSourceControl.page.commitStrategy.atomic', 'settingsSourceControl.page.commitStrategy.gitStaging'],
                },
                commitMessageGenerator: { storage: { scope: 'account', key: 'scmCommitMessageGeneratorEnabled', access: 'read_write' }, titleKey: 'settingsSourceControl.commitMessageGenerator.title', descriptionKey: 'settingsSourceControl.page.generator.description' },
                commitMessageAgent: { titleKey: 'settingsSourceControl.page.generator.agentTitle', descriptionKey: 'settingsSourceControl.page.generator.agentDescription' },
                commitMessageInstructions: { storage: { scope: 'account', key: 'scmCommitMessageGeneratorInstructions', access: 'read_write' }, titleKey: 'settingsSourceControl.page.generator.instructionsTitle', descriptionKey: 'settingsSourceControl.page.generator.instructionsDescription' },
                includeCoAuthoredBy: { storage: { scope: 'account', key: 'scmIncludeCoAuthoredBy', access: 'read_write' }, titleKey: 'settingsSourceControl.commitAttribution.includeCoAuthoredBy.title', descriptionKey: 'settingsSourceControl.page.coAuthoredByDescription' },
            },
        },
        remote: {
            titleKey: 'settingsSourceControl.page.remote.title',
            settings: {
                confirmBeforePulling: { titleKey: 'settingsSourceControl.remoteConfirmation.confirmBeforePulling.title', descriptionKey: 'settingsSourceControl.remoteConfirmation.confirmBeforePulling.subtitle' },
                confirmBeforePushing: { titleKey: 'settingsSourceControl.remoteConfirmation.confirmBeforePushing.title', descriptionKey: 'settingsSourceControl.remoteConfirmation.confirmBeforePushing.subtitle' },
                pushRejection: { storage: { scope: 'account', key: 'scmPushRejectPolicy', access: 'read_write' },
                    titleKey: 'settingsSourceControl.page.pushRejection.title',
                    keywordKeys: ['settingsSourceControl.page.pushRejection.fetch'],
                },
                pullRequestPlacement: { storage: { scope: 'account', key: 'scmPullRequestPlacement', access: 'read_write' },
                    titleKey: 'sessionGitPullRequest.settings.placementTitle',
                    descriptionKey: 'sessionGitPullRequest.settings.placementDescription',
                    keywordKeys: ['sessionGitPullRequest.settings.sidebar', 'sessionGitPullRequest.settings.details'],
                },
            },
        },
        routing: {
            titleKey: 'settingsSourceControl.page.routing.title',
            settings: {
                gitRouting: {
                    titleKey: 'settingsSourceControl.page.routing.rowTitle',
                    keywordKeys: ['settingsSourceControl.page.routing.git', 'settingsSourceControl.page.routing.sapling'],
                },
            },
        },
        files: {
            titleKey: 'settingsSourceControl.page.files.title',
            settings: {
                // The renderer and layout rows exist on web only (the view's `Platform.OS === 'web'`).
                diffRenderer: { storage: { scope: 'account', key: 'filesDiffRendererMode', access: 'read_write' }, titleKey: 'settingsSourceControl.page.files.renderer', host: settingsHosts.web },
                diffLayout: { storage: { scope: 'account', key: 'filesDiffPresentationStyle', access: 'read_write' },
                    titleKey: 'settingsSourceControl.page.files.layout',
                    host: settingsHosts.web,
                    keywordKeys: ['settingsSourceControl.page.files.unified', 'settingsSourceControl.page.files.split'],
                },
                syntaxHighlighting: { storage: { scope: 'account', key: 'filesDiffSyntaxHighlightingMode', access: 'read_write' }, titleKey: 'settingsSourceControl.page.files.highlighting' },
                changedFilesDensity: { storage: { scope: 'account', key: 'filesChangedFilesRowDensity', access: 'read_write' }, titleKey: 'settingsSourceControl.page.files.density' },
                gitPaneLayout: { storage: { scope: 'account', key: 'scmGitPaneLayout', access: 'read_write' },
                    titleKey: 'sessionGitDisplay.settingsLayout',
                    keywordKeys: ['sessionGitDisplay.layoutUnified', 'sessionGitDisplay.layoutTabs'],
                },
                changedFilesLayout: { storage: { scope: 'account', key: 'scmChangedFilesLayout', access: 'read_write' },
                    titleKey: 'sessionGitDisplay.settingsShowAs',
                    keywordKeys: ['sessionGitDisplay.showAsList', 'sessionGitDisplay.showAsTree'],
                },
                showLineNumbersInDiffs: { storage: { scope: 'account', key: 'showLineNumbers', access: 'read_write' }, titleKey: 'settingsAppearance.showLineNumbersInDiffs', descriptionKey: 'settingsAppearance.showLineNumbersInDiffsDescription' },
                showLineNumbersInToolViews: { storage: { scope: 'account', key: 'showLineNumbersInToolViews', access: 'read_write' }, titleKey: 'settingsAppearance.showLineNumbersInToolViews', descriptionKey: 'settingsAppearance.showLineNumbersInToolViewsDescription' },
                wrapLinesInDiffs: { storage: { scope: 'account', key: 'wrapLinesInDiffs', access: 'read_write' }, titleKey: 'settingsAppearance.wrapLinesInDiffs', descriptionKey: 'settingsAppearance.wrapLinesInDiffsDescription' },
            },
        },
        backends: {
            // One row per source-control backend the chosen machine offers (page state).
            settings: {
                backendDefaultDiff: {
                    titleKey: 'settingsSourceControl.page.backend.defaultDiff',
                    descriptionKey: 'settingsSourceControl.backends.defaultDiffItemSubtitle',
                },
            },
        },
        editor: {
            titleKey: 'settingsSourceControl.editor',
            settings: {
                editorAutoSave: { storage: { scope: 'account', key: 'filesEditorAutoSave', access: 'read_write' }, titleKey: 'settingsSourceControl.editorAutoSave', descriptionKey: 'settingsSourceControl.editorAutoSaveDescription' },
            },
        },
        // The same Editor section on the page; this row renders only with the rich Markdown editor.
        editorMarkdown: {
            titleKey: 'settingsSourceControl.editor',
            featureId: 'files.markdownRichEditor',
            settings: {
                markdownEditMode: { storage: { scope: 'account', key: 'markdownDefaultEditMode', access: 'read_write' },
                    titleKey: 'settingsSourceControl.page.editor.markdownTitle',
                    keywordKeys: ['settingsSourceControl.page.editor.rich', 'settingsSourceControl.page.editor.raw'],
                },
            },
        },
    },
});
