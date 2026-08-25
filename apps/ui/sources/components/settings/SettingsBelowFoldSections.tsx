import * as React from 'react';

import { SettingsAboutSection } from '@/components/settings/SettingsAboutSection';
import { SettingsAiAndAgentsSection } from '@/components/settings/SettingsAiAndAgentsSection';
import { SettingsDeveloperSection } from '@/components/settings/SettingsDeveloperSection';
import { SettingsFilesAndSourceControlSection } from '@/components/settings/SettingsFilesAndSourceControlSection';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';
import { SettingsSystemSection } from '@/components/settings/SettingsSystemSection';
import { SettingsSessionsBehaviorSection } from '@/components/settings/SettingsSessionsBehaviorSection';
import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';

function rootGroups(tree: readonly ResolvedSettingsPageNode[]): readonly ResolvedSettingsPageNode[] {
    return tree.find((node) => node.id === 'settings')?.children ?? [];
}

function minimumStageForRootGroup(index: number): number {
    if (index <= 1) return 0;
    if (index === 2) return 1;
    if (index === 3) return 2;
    return 3;
}

function SettingsCatalogRootGroup(props: SettingsBelowFoldSectionsProps & Readonly<{
    groupId: string;
}>): React.ReactElement {
    switch (props.groupId) {
        case 'groupAiAndAgents':
            return <SettingsAiAndAgentsSection onNavigate={props.onNavigate} router={props.router} theme={props.theme} />;
        case 'groupSessionsBehavior':
            return (
                <SettingsSessionsBehaviorSection
                    automationsNeedLocalEnablement={props.automationsNeedLocalEnablement}
                    onNavigate={props.onNavigate}
                    router={props.router}
                    showAutomations={props.showAutomations}
                    terminalUseTmux={props.terminalUseTmux}
                    theme={props.theme}
                />
            );
        case 'groupFilesAndSourceControl':
            return <SettingsFilesAndSourceControlSection onNavigate={props.onNavigate} router={props.router} theme={props.theme} />;
        case 'groupSystem':
            return (
                <SettingsSystemSection
                    handleReportIssue={props.handleReportIssue}
                    onNavigate={props.onNavigate}
                    router={props.router}
                    theme={props.theme}
                />
            );
        default:
            return (
                <SettingsCatalogOverviewGroup
                    groupId={props.groupId}
                    router={props.router}
                    theme={props.theme}
                    onNavigate={props.onNavigate}
                />
            );
    }
}

export const SettingsBelowFoldSections = React.memo(function SettingsBelowFoldSections({
    appVersion,
    automationsNeedLocalEnablement,
    devModeEnabled,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    onNavigate,
    router,
    showAutomations,
    showChangelog,
    showRateUs,
    stage,
    terminalUseTmux,
    theme,
}: SettingsBelowFoldSectionsProps) {
    const catalog = useResolvedSettingsPageCatalog();
    const groups = React.useMemo(() => rootGroups(catalog.tree), [catalog.tree]);
    return (
        <>
            {groups.map((group, index) => (
                stage >= minimumStageForRootGroup(index) ? (
                    <SettingsCatalogRootGroup
                        key={group.id}
                        appVersion={appVersion}
                        automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                        devModeEnabled={devModeEnabled}
                        handleGitHub={handleGitHub}
                        handleReportIssue={handleReportIssue}
                        handleVersionClick={handleVersionClick}
                        onNavigate={onNavigate}
                        router={router}
                        showAutomations={showAutomations}
                        showChangelog={showChangelog}
                        showRateUs={showRateUs}
                        stage={stage}
                        terminalUseTmux={terminalUseTmux}
                        theme={theme}
                        groupId={group.id}
                    />
                ) : null
            ))}
            {stage >= 3 ? (
                <>
                    <SettingsDeveloperSection devModeEnabled={devModeEnabled} router={router} theme={theme} />
                </>
            ) : null}
            {stage >= 4 ? (
                <SettingsAboutSection
                    appVersion={appVersion}
                    handleGitHub={handleGitHub}
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
