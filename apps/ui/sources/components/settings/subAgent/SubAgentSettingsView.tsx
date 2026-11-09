import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';

import { createPluginAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useSetting } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useActiveMachineFacts } from '@/sync/store/hooks';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SUB_AGENT_SETTINGS } from '@/components/settings/subAgent/subAgentSettings';
import { SubAgentWorkDepthSection } from '@/components/settings/subAgent/SubAgentWorkDepthSection';

/**
 * The instructions rows exist only while sub-agents are on, and the "turn them on" row only while
 * they are off. Whichever section is on screen answers a search for the other one's rows.
 */
const SUB_AGENTS_DISABLED_SECTIONS = [SUB_AGENT_SETTINGS.sectionRefs.disabled];
const SUB_AGENTS_INSTRUCTIONS_SECTIONS = [SUB_AGENT_SETTINGS.sectionRefs.instructions];

function resolveText(input: string | Readonly<{ fallback: string }> | undefined): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return input;
    return input.fallback;
}

export const SubAgentSettingsView = React.memo(function SubAgentSettingsView() {
    const router = useRouter();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const [notifyParentOnCompletion, setNotifyParentOnCompletion] = useSettingMutable('executionRunsNotifyParentOnCompletionDefault');
    const [approvalReviewerEnabled, setApprovalReviewerEnabled] = useSettingMutable('approvalReviewerEnabled');
    const machines = useActiveMachineFacts();
    const scope = useActiveServerAccountScope();
    const reachabilityRevision = useMachineReachabilityRevision();
    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const preferredMachineId = React.useMemo(() => {
        return resolvePreferredMachineId({
            machines,
            scope,
            recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
        });
    }, [machines, recentMachinePaths, scope, reachabilityRevision]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: preferredMachineId,
        enabled: Boolean(preferredMachineId),
        // Only the Agent-targeted editable settings groups' sub-agent sections are read.
        sections: ['settingsById'],
    });

    const agentSubagentSections = React.useMemo(() => (
        Object.values(daemonMergedProjection.inputs?.pluginProjectionById ?? {}).flatMap((plugin) => (
            plugin.editableSettingsGroups.flatMap((group) => {
                const target = group.target;
                if (target.kind !== 'agent') return [];
                return group.presentation.subagentSections.map((section) => ({
                    agent: target.agent,
                    section,
                }));
            })
        ))
    ), [daemonMergedProjection.inputs?.pluginProjectionById]);

    return (
        <ItemList testID="settings.subAgent">
            <SettingsPageHeader description={t('subAgentGuidance.settings.pagePurpose')} />

            <SubAgentWorkDepthSection />

            {executionRunsEnabled ? (
                <SettingSection section={SUB_AGENT_SETTINGS.sectionRefs.instructions} answersFor={SUB_AGENTS_DISABLED_SECTIONS}>
                    {/* One row that names itself: a section title over it would only repeat it. */}
                    <ItemGroup>
                        <SettingRow
                            setting={SUB_AGENT_SETTINGS.settings.notifyParentOnCompletion}
                            testID="settings.subAgent.notifyParentOnCompletion"
                            subtitleLines={0}
                            rightElement={<Switch value={notifyParentOnCompletion === true} onValueChange={(v) => setNotifyParentOnCompletion(v as any)} />}
                            showChevron={false}
                            onPress={() => setNotifyParentOnCompletion((notifyParentOnCompletion !== true) as any)}
                        />
                    </ItemGroup>
                </SettingSection>
            ) : (
                <SettingSection section={SUB_AGENT_SETTINGS.sectionRefs.disabled} answersFor={SUB_AGENTS_INSTRUCTIONS_SECTIONS}>
                    <ItemGroup
                        title={t('subAgentGuidance.settings.disabled.title')}
                        description={t('subAgentGuidance.settings.disabled.footer')}
                    >
                        <SettingRow
                            icon={<Icon name="flask" />}
                            setting={SUB_AGENT_SETTINGS.settings.enableExecutionRuns}
                            onPress={() => router.push(SETTINGS_ROUTES.features)}
                        />
                    </ItemGroup>
                </SettingSection>
            )}

            <SettingSection section={SUB_AGENT_SETTINGS.sectionRefs.approvalReviewer}>
                {/* One row that names itself: a section title over it would only repeat "Approval reviewer". */}
                <ItemGroup>
                    <SettingRow
                        setting={SUB_AGENT_SETTINGS.settings.approvalReviewerEnabled}
                        testID="settings.subAgent.approvalReviewerEnabled"
                        subtitleLines={0}
                        showChevron={false}
                        onPress={() => setApprovalReviewerEnabled(!approvalReviewerEnabled)}
                        rightElement={<Switch value={approvalReviewerEnabled} onValueChange={setApprovalReviewerEnabled} />}
                    />
                </ItemGroup>
            </SettingSection>

            {agentSubagentSections.map(({ agent, section }) => (
                <ItemGroup
                    key={`${agent.pluginId}:${agent.localId}:${section.id}`}
                    title={resolveText(section.title) ?? ''}
                    description={resolveText(section.description)}
                >
                    {section.items.map((item) => (
                        <Item
                            icon={<Icon name="sliders-horizontal" />}
                            key={`${agent.pluginId}:${agent.localId}:${section.id}:${item.id}`}
                            title={resolveText(item.title) ?? ''}
                            subtitle={resolveText(item.description)}
                            onPress={() => router.push(createPluginAgentSettingsRoute(agent) as never)}
                        />
                    ))}
                </ItemGroup>
            ))}

            <ItemGroup
                title={t('subAgentGuidance.settings.related.groupTitle')}
                description={t('subAgentGuidance.settings.related.footer')}
            >
                <SettingRow
                    icon={<Icon name="arrows-left-right" />}
                    testID="settings.subAgent.related.session"
                    setting={SUB_AGENT_SETTINGS.settings.session}
                    onPress={() => router.push(SETTINGS_ROUTES.session)}
                />
                <SettingRow
                    icon={<Icon name="sparkle" />}
                    setting={SUB_AGENT_SETTINGS.settings.agents}
                    onPress={() => router.push(SETTINGS_ROUTES.agents)}
                />
            </ItemGroup>
        </ItemList>
    );
});
