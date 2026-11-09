import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useAccountSettingsScope } from '@/sync/store/hooks';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useDeploymentAccountDefaults } from '@/components/projects/deployments/useDeploymentAccountDefaults';
import { renderDeploymentDefaultsEditorRows } from '@/components/projects/deployments/DeploymentCreationDefaultsRows';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { presentSettingWriteFailure } from '@/components/settings/shell/writeFailure';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';
import { DEPLOYMENTS_SETTINGS } from './deploymentsSettings';

export function DeploymentsSettingsView() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const activeScope = useAccountSettingsScope();
    const serverId = readProjectRouteStringParam(params.serverId) ?? activeScope?.serverId ?? null;
    const homeLabel = useHomeDisplayLabel(serverId ? getServerProfileById(serverId) : null);
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const defaults = useDeploymentAccountDefaults(binding ?? null);
    const execution = useMountedActionExecution(binding?.scope);
    const router = useRouter();
    const [saving, setSaving] = React.useState(false);
    const save = async (preferences: DeploymentCreationDefaultsV1) => {
        if (saving) return;
        setSaving(true);
        try {
            const result = await execution.execute('settings.set', { anchor: DEPLOYMENTS_SETTINGS.settings.creationDefaults.anchor, value: preferences });
            if (result.ok) defaults.accept(preferences);
            else presentSettingWriteFailure(result);
        } catch (error) { presentSettingWriteFailure(error); }
        finally { setSaving(false); }
    };
    const resolved = binding && defaults.preferences ? resolveDeploymentCreationDefaultsV1({
        projectOwner: { kind: 'account', accountId: binding.scope.accountId },
        account: { accountId: binding.scope.accountId, defaults: defaults.preferences }, target: { kind: 'ownServer', machines: [] },
    }) : null;
    return <ItemList testID="settings-deployments" style={{ paddingTop: 0 }}>
        <SettingsPageHeader title={t('projects.deployments.title')} description={t('projects.deployments.defaultsEditor.accountDescription')}
            meta={serverId ? [{ key: 'home', text: homeLabel }] : []} />
        {execution.approval.approvalPending ? <ActionApprovalPendingNotice message={t('approvals.waitingForYou')}
            summary={execution.approval.approvalSummary} onOpenApproval={execution.approval.openApproval} /> : null}
        {resolved && defaults.preferences && serverId ? <SettingAnchor setting={DEPLOYMENTS_SETTINGS.settings.creationDefaults}>
            <ItemGroup title={t('projects.deployments.creationDefaults')}>
                {renderDeploymentDefaultsEditorRows({ serverId, preferences: defaults.preferences, resolved,
                    inheritLabel: t('projects.deployments.defaultsEditor.useBuiltin'), disabled: saving || !execution.ready,
                    onChange: next => { void save(next); } })}
            </ItemGroup>
        </SettingAnchor> : <SurfaceStateCard kind={defaults.error ? 'error' : 'loading'} title={t('projects.deployments.creationDefaults')}
            {...(defaults.error ? { action: { label: t('common.retry'), onPress: defaults.retry } } : {})} />}
        <ItemGroup><Item testID="deployment-defaults.notifications" title={t('projects.deployments.defaultsEditor.alertChannels')}
            icon={<Icon name="bell" size={18} color={theme.colors.text.secondary} />}
            onPress={() => router.push(SETTINGS_ROUTES.notifications)} /></ItemGroup>
    </ItemList>;
}
