import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks display and pre-run account settings from the canonical account registry', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionThinkingDisplayMode: 'hidden',
            sessionThinkingInlinePresentation: 'full',
            sessionThinkingInlineChrome: 'card',
            showLineNumbers: false,
            showLineNumbersInToolViews: true,
            wrapLinesInDiffs: true,
            sessionReplayStrategy: 'summary_plus_recent',
            executionRunsGuidanceEnabled: true,
            attachmentsUploadsUploadLocation: 'os_temp',
            attachmentsUploadsVcsIgnoreStrategy: 'none',
            attachmentsUploadsVcsIgnoreWritesEnabled: false,
            serverSelectionActiveTargetKind: 'group',
            sessionTagsEnabled: false,
            terminalConnectLegacySecretExportEnabled: true,
        });

        expect(snapshot.properties.acct_setting__sessionThinkingDisplayMode).toBe('hidden');
        expect(snapshot.properties.acct_setting__sessionThinkingInlinePresentation).toBe('full');
        expect(snapshot.properties.acct_setting__sessionThinkingInlineChrome).toBe('card');
        expect(snapshot.properties.acct_setting__showLineNumbers).toBe(false);
        expect(snapshot.properties.acct_setting__showLineNumbersInToolViews).toBe(true);
        expect(snapshot.properties.acct_setting__wrapLinesInDiffs).toBe(true);
        expect(snapshot.properties.acct_setting__sessionReplayStrategy).toBe('summary_plus_recent');
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__attachmentsUploadsUploadLocation).toBe('os_temp');
        expect(snapshot.properties.acct_setting__attachmentsUploadsVcsIgnoreStrategy).toBe('none');
        expect(snapshot.properties.acct_setting__attachmentsUploadsVcsIgnoreWritesEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__serverSelectionActiveTargetKind).toBe('group');
        expect(snapshot.properties.acct_setting__sessionTagsEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__terminalConnectLegacySecretExportEnabled).toBe(true);
    });

    it('tracks scm and files settings from the canonical account registry', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            scmCommitStrategy: 'git_staging',
            scmGitRepoPreferredBackend: 'sapling',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'manual',
            scmUncommittedChangesStrategy: 'always_stash',
            scmAskBeforeOverwritingBranchStash: false,
            scmCommitMessageGeneratorEnabled: false,
            scmIncludeCoAuthoredBy: true,
            filesDiffSyntaxHighlightingMode: 'advanced',
            filesDiffRendererMode: 'happier',
            filesDiffPresentationStyle: 'unified',
            filesChangedFilesRowDensity: 'compact',
            filesDiffFoldingEnabled: false,
            filesDiffIntraLineWordDiffEnabled: false,
            filesRepositoryTreeWarmCacheEnabled: false,
            filesEditorAutoSave: true,
            filesEditorWebMonacoEnabled: false,
            filesEditorNativeCodeMirrorEnabled: false,
        });

        expect(snapshot.properties.acct_setting__scmCommitStrategy).toBe('git_staging');
        expect(snapshot.properties.acct_setting__scmGitRepoPreferredBackend).toBe('sapling');
        expect(snapshot.properties.acct_setting__scmRemoteConfirmPolicy).toBe('never');
        expect(snapshot.properties.acct_setting__scmPushRejectPolicy).toBe('manual');
        expect(snapshot.properties.acct_setting__scmUncommittedChangesStrategy).toBe('always_stash');
        expect(snapshot.properties.acct_setting__scmAskBeforeOverwritingBranchStash).toBe(false);
        expect(snapshot.properties.acct_setting__scmCommitMessageGeneratorEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__scmIncludeCoAuthoredBy).toBe(true);
        expect(snapshot.properties.acct_setting__filesDiffSyntaxHighlightingMode).toBe('advanced');
        expect(snapshot.properties.acct_setting__filesDiffRendererMode).toBe('happier');
        expect(snapshot.properties.acct_setting__filesDiffPresentationStyle).toBe('unified');
        expect(snapshot.properties.acct_setting__filesChangedFilesRowDensity).toBe('compact');
        expect(snapshot.properties.acct_setting__filesDiffFoldingEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__filesDiffIntraLineWordDiffEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__filesRepositoryTreeWarmCacheEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__filesEditorAutoSave).toBe(true);
        expect(snapshot.properties.acct_setting__filesEditorWebMonacoEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__filesEditorNativeCodeMirrorEnabled).toBe(false);
    });

    it('tracks notifications, handoff defaults, and preferred language from canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            preferredLanguage: 'fr',
            notificationsSettingsV1: {
                ...settingsDefaults.notificationsSettingsV1,
                pushEnabled: false,
                ready: false,
                readyIncludeMessageText: false,
                permissionRequest: false,
                userActionRequest: false,
                foregroundBehavior: 'silent',
            },
            sessionHandoffDefaultsV1: {
                ...settingsDefaults.sessionHandoffDefaultsV1,
                workspaceTransferEnabled: false,
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'include_selected',
                directTargetMode: 'convert_to_persisted',
            },
        });

        expect(snapshot.properties.acct_setting__preferredLanguage).toBe('fr');
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__pushEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__ready).toBe(false);
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__readyIncludeMessageText).toBe(false);
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__permissionRequest).toBe(false);
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__userActionRequest).toBe(false);
        expect(snapshot.properties.acct_setting__notificationsSettingsV1__foregroundBehavior).toBe('silent');
        expect(snapshot.properties.acct_setting__sessionHandoffDefaultsV1__workspaceTransferEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__sessionHandoffDefaultsV1__conflictPolicy).toBe('replace_existing');
        expect(snapshot.properties.acct_setting__sessionHandoffDefaultsV1__includeIgnoredMode).toBe('include_selected');
        expect(snapshot.properties.acct_setting__sessionHandoffDefaultsV1__directTargetMode).toBe('convert_to_persisted');
    });
});
