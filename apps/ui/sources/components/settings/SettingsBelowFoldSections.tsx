import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { summarizeMachinesNeedingAttention, useMachinesNeedingAttention } from '@/components/machines/attention/useMachinesNeedingAttention';
import { Text } from '@/components/ui/text/Text';

import { MachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
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
import { useMachinePresenceCounts } from '@/sync/domains/state/storage';

function rootGroups(tree: readonly ResolvedSettingsPageNode[]): readonly ResolvedSettingsPageNode[] {
    return tree.find((node) => node.id === 'settings')?.children ?? [];
}

function minimumStageForRootGroup(index: number): number {
    if (index <= 1) return 0;
    if (index === 2) return 1;
    if (index === 3) return 2;
    return 3;
}

/** The Machines row says how many machines are online and offline (lab `hmachines-Mp`). */
function resolveProfileAndAccountSubtitle(page: ResolvedSettingsPageNode, defaultSubtitle: React.ReactNode | undefined): React.ReactNode | undefined {
    return page.id === 'machines' ? <SettingsMachinesRowPresence /> : defaultSubtitle;
}

/**
 * Its own leaf, so a presence change re-renders the row's subtitle and nothing else. When machines need
 * you it says who and why instead, in the attention tone (MPG-23, lab `rm` Hp); otherwise presence.
 */
const SettingsMachinesRowPresence = React.memo(function SettingsMachinesRowPresence() {
    const { theme } = useUnistyles();
    const counts = useMachinePresenceCounts();
    const needingYou = summarizeMachinesNeedingAttention(useMachinesNeedingAttention());
    if (needingYou) {
        return <Text testID="settings-machines-row-attention" style={{ color: theme.colors.state.attention.textForeground }} numberOfLines={1}>{needingYou.title}</Text>;
    }
    return <MachinePresenceCounts testID="settings-machines-row-presence" counts={counts} />;
});

function SettingsCatalogRootGroup(props: SettingsBelowFoldSectionsProps & Readonly<{
    groupId: string;
}>): React.ReactElement {
    switch (props.groupId) {
        case 'groupAiAndAgents':
            return <SettingsAiAndAgentsSection onNavigate={props.onNavigate} router={props.router} />;
        case 'groupSessionsBehavior':
            return (
                <SettingsSessionsBehaviorSection
                    automationsNeedLocalEnablement={props.automationsNeedLocalEnablement}
                    onNavigate={props.onNavigate}
                    router={props.router}
                    showAutomations={props.showAutomations}
                />
            );
        case 'groupProfileAndAccount':
            return (
                <SettingsCatalogOverviewGroup
                    groupId={props.groupId}
                    router={props.router}
                    onNavigate={props.onNavigate}
                    resolveSubtitle={resolveProfileAndAccountSubtitle}
                />
            );
        case 'groupFilesAndSourceControl':
            return <SettingsFilesAndSourceControlSection onNavigate={props.onNavigate} router={props.router} />;
        case 'groupSystem':
            return (
                <SettingsSystemSection
                    handleReportIssue={props.handleReportIssue}
                    onNavigate={props.onNavigate}
                    router={props.router}
                />
            );
        default:
            return (
                <SettingsCatalogOverviewGroup
                    groupId={props.groupId}
                    router={props.router}
                    onNavigate={props.onNavigate}
                />
            );
    }
}

/**
 * The Settings pages as a list, grouped as the rail groups them and from the same catalog owner. Where the rail
 * shows it is the index; on a phone this list is the Settings home (owner 11-06, as in 0.2).
 */
export const SettingsCatalogGroups = React.memo(function SettingsCatalogGroups(props: SettingsBelowFoldSectionsProps) {
    const catalog = useResolvedSettingsPageCatalog();
    const groups = React.useMemo(() => rootGroups(catalog.tree), [catalog.tree]);
    return (
        <>
            {groups.map((group, index) => (
                props.stage >= minimumStageForRootGroup(index) ? (
                    <SettingsCatalogRootGroup key={group.id} {...props} groupId={group.id} />
                ) : null
            ))}
        </>
    );
});

export const SettingsBelowFoldSections = React.memo(function SettingsBelowFoldSections(props: SettingsBelowFoldSectionsProps) {
    return (
        <>
            {props.stage >= 3 ? (
                <SettingsDeveloperSection devModeEnabled={props.devModeEnabled} router={props.router} />
            ) : null}
            {props.stage >= 4 ? (
                <SettingsAboutSection
                    appVersion={props.appVersion}
                    handleGitHub={props.handleGitHub}
                    handleVersionClick={props.handleVersionClick}
                    router={props.router}
                    showChangelog={props.showChangelog}
                    showRateUs={props.showRateUs}
                    supportUs={props.supportUs}
                />
            ) : null}
        </>
    );
});
