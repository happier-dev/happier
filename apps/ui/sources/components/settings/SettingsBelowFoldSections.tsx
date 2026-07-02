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
    connectedServicesEnabled,
    devModeEnabled,
    executionRunsEnabled,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    mcpServersEnabled,
    memorySearchEnabled,
    promptsLibraryEnabled,
    router,
    showAutomations,
    showChangelog,
    showFilesAndSourceControlGroup,
    showRateUs,
    sourceControlEnabled,
    stage,
    terminalUseTmux,
    theme,
    useProfiles,
    voiceEnabled,
}: SettingsBelowFoldSectionsProps) {
    return (
        <>
            {stage >= 1 ? (
                <SettingsAiAndAgentsSection
                    connectedServicesEnabled={connectedServicesEnabled}
                    mcpServersEnabled={mcpServersEnabled}
                    memorySearchEnabled={memorySearchEnabled}
                    promptsLibraryEnabled={promptsLibraryEnabled}
                    router={router}
                    theme={theme}
                    useProfiles={useProfiles}
                    voiceEnabled={voiceEnabled}
                />
            ) : null}
            {stage >= 2 ? (
                <SettingsSessionsBehaviorSection
                    automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                    executionRunsEnabled={executionRunsEnabled}
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
