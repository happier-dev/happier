import { commitMessageAgentStorage, scmGitRoutingStorage, scmBackendDefaultDiffStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';

import { remoteConfirmationStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

/** The searchable settings of the `sourceControl` page. Rows render their labels from these declarations. */
export const SOURCE_CONTROL_SETTINGS = defineSettingsPage({
    pageId: 'sourceControl',
    sections: {
        aiSuggestions: {
            titleKey: 'files.editing.aiSuggestions.title',
            settings: {
                aiSuggestionsEnabled: {}, aiSuggestionsProvider: {}, aiSuggestionsModel: {}, aiSuggestionsNextEdit: {}, aiSuggestionsNextEditModel: {},
                aiSuggestionsMode: {}, aiSuggestionsDelay: {}, aiSuggestionsExcluded: {},
                aiSuggestionsDisabledLanguages: {}, aiSuggestionsUsage: {},
            },
        },
        walkthroughs: {
            titleKey: 'walkthroughSettings.title',
            settings: {
                explainChanges: {},
                summaryModel: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.runner),  },
                outputLanguage: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage) },
                prepareAfterTurn: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch),  },
                investigateSurroundingFiles: { storage: scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles) },
                savedWalkthroughs: {},
            },
        },
        commits: {
            titleKey: 'settingsSourceControl.page.commits.title',
            settings: {
                commitStrategy: {},
                commitMessageGenerator: {},
                commitMessageAgent: { storage: commitMessageAgentStorage },
                commitMessageInstructions: {},
                includeCoAuthoredBy: {},
            },
        },
        remote: {
            titleKey: 'settingsSourceControl.page.remote.title',
            settings: {
                confirmBeforePulling: { storage: remoteConfirmationStorage('pull'),  },
                confirmBeforePushing: { storage: remoteConfirmationStorage('push'),  },
                pushRejection: {},
                pullRequestPlacement: {},
                resourceOpenLocation: {},
            },
        },
        routing: {
            titleKey: 'settingsSourceControl.page.routing.title',
            settings: {
                gitRouting: { storage: scmGitRoutingStorage },
            },
        },
        files: {
            titleKey: 'settingsSourceControl.page.files.title',
            settings: {
                trackAgentEdits: { anchor: 'files.trackAgentEdits' },
                askWithoutSessionTarget: { anchor: 'files.askWithoutSessionTarget' },
                imageBackground: { anchor: 'files.imageBackground' },
                // The renderer and layout rows exist on web only (the view's `Platform.OS === 'web'`).
                diffRenderer: { host: settingsHosts.web },
                diffLayout: {

                    host: settingsHosts.web,

                },
                syntaxHighlighting: {},
                changedFilesDensity: {},
                gitPaneLayout: {},
                changedFilesLayout: {},
                showLineNumbersInDiffs: {},
                showLineNumbersInToolViews: {},
                wrapLinesInDiffs: {},
            },
        },
        backends: {
            // One row per source-control backend the chosen machine offers (page state).
            settings: {
                backendDefaultDiff: { storage: scmBackendDefaultDiffStorage },
            },
        },
        editor: {
            titleKey: 'settingsSourceControl.editor',
            settings: {
                editorAutoSave: {},
                editorFormatOnSave: {},
                editorInlayHints: {},
                editorSemanticHighlighting: {},
            },
        },
        // The same Editor section on the page; this row renders only with the rich Markdown editor.
        editorMarkdown: {
            titleKey: 'settingsSourceControl.editor',
            featureId: 'files.markdownRichEditor',
            settings: {
                markdownEditMode: {},
            },
        },
    },
});
