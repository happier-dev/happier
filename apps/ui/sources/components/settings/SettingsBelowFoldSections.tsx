import * as React from 'react';

import { SettingsAboutSection } from '@/components/settings/SettingsAboutSection';
import { SettingsAiAndAgentsSection } from '@/components/settings/SettingsAiAndAgentsSection';
import { SettingsDeveloperSection } from '@/components/settings/SettingsDeveloperSection';
import { SettingsFilesAndSourceControlSection } from '@/components/settings/SettingsFilesAndSourceControlSection';
import { SettingsSystemSection } from '@/components/settings/SettingsSystemSection';
import { SettingsSessionsBehaviorSection } from '@/components/settings/SettingsSessionsBehaviorSection';
import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';

export const SettingsBelowFoldSections = React.memo(function SettingsBelowFoldSections({
    appVersion,
    attachmentsUploadsEnabled,
    automationsNeedLocalEnablement,
    devModeEnabled,
    executionRunsEnabled,
    externalSessionsEnabled,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    router,
    showAutomations,
    showChangelog,
    showFilesAndSourceControlGroup,
    showRateUs,
    sourceControlEnabled,
    stage,
    terminalUseTmux,
    theme,
}: SettingsBelowFoldSectionsProps) {
    return (
        <>
            {stage >= 1 ? (
                <SettingsAiAndAgentsSection
                    router={router}
                    theme={theme}
                />
            ) : null}
            {stage >= 2 ? (
                <SettingsSessionsBehaviorSection
                    automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                    executionRunsEnabled={executionRunsEnabled}
                    externalSessionsEnabled={externalSessionsEnabled}
                    router={router}
                    showAutomations={showAutomations}
                    terminalUseTmux={terminalUseTmux}
                    theme={theme}
                />
            ) : null}
            {stage >= 3 ? (
                <>
                    {showFilesAndSourceControlGroup ? (
                        <SettingsFilesAndSourceControlSection
                            attachmentsUploadsEnabled={attachmentsUploadsEnabled}
                            router={router}
                            sourceControlEnabled={sourceControlEnabled}
                            theme={theme}
                        />
                    ) : null}
                    <SettingsSystemSection router={router} theme={theme} />
                    <SettingsDeveloperSection devModeEnabled={devModeEnabled} router={router} theme={theme} />
                </>
            ) : null}
            {stage >= 4 ? (
                <SettingsAboutSection
                    appVersion={appVersion}
                    handleGitHub={handleGitHub}
                    handleReportIssue={handleReportIssue}
                    handleVersionClick={handleVersionClick}
                    router={router}
                    showChangelog={showChangelog}
                    showRateUs={showRateUs}
                    theme={theme}
                />
            ) : null}
        </>
    );
});
