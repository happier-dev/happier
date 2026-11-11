import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useAccountSettingsScope } from '@/sync/store/hooks';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
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
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const activeScope = useAccountSettingsScope();
    const serverId = readProjectRouteStringParam(params.serverId) ?? activeScope?.serverId ?? null;
    const homeLabel = useHomeDisplayLabel(serverId ? getServerProfileById(serverId) : null);
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    return <DeploymentDefaultsEditor key={binding ? `${binding.scope.serverId}:${binding.scope.accountId}` : 'unbound'}
        binding={binding} serverId={serverId} homeLabel={homeLabel} />;
}

function DeploymentDefaultsEditor({ binding, serverId, homeLabel }: Readonly<{
    binding: ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'];
    serverId: string | null;
    homeLabel: string;
}>) {
    const { theme } = useUnistyles();
    const defaults = useDeploymentAccountDefaults(binding ?? null);
    const execution = useMountedActionExecution(binding?.scope);
    const router = useRouter();
    const [draft, setDraft] = React.useState<DeploymentCreationDefaultsV1 | null>(null);
    const saving = React.useRef<{ preferences: DeploymentCreationDefaultsV1 } | null>(null);
    const save = async (edit: React.SetStateAction<DeploymentCreationDefaultsV1>) => {
        const previous = saving.current?.preferences ?? defaults.preferences;
        if (!previous) return;
        const preferences = typeof edit === 'function' ? edit(previous) : edit;
        if (retainIfEqual(previous, preferences) === previous) return;
        setDraft(preferences);
        if (saving.current) { saving.current.preferences = preferences; return; }
        const pending = { preferences };
        saving.current = pending;
        try {
            while (true) {
                const sent = pending.preferences;
                const result = await execution.execute('settings.set', { anchor: DEPLOYMENTS_SETTINGS.settings.creationDefaults.anchor, value: sent });
                if (!result.ok) { presentSettingWriteFailure(result); break; }
                defaults.accept(sent);
                if (!execution.isCurrent() || retainIfEqual(sent, pending.preferences) === sent) break;
            }
        } catch (error) { presentSettingWriteFailure(error); }
        finally { saving.current = null; setDraft(null); }
    };
    const preferences = draft ?? defaults.preferences;
    const resolved = binding && preferences ? resolveDeploymentCreationDefaultsV1({
        projectOwner: { kind: 'account', accountId: binding.scope.accountId },
        account: { accountId: binding.scope.accountId, defaults: preferences }, target: { kind: 'ownServer', machines: [] },
    }) : null;
    return <ItemList testID="settings-deployments" style={{ paddingTop: 0 }}>
        <SettingsPageHeader title={t('projects.deployments.title')} description={t('projects.deployments.defaultsEditor.accountDescription')}
            meta={serverId ? [{ key: 'home', text: homeLabel }] : []} />
        {execution.approval.approvalPending ? <ActionApprovalPendingNotice message={t('approvals.waitingForYou')}
            summary={execution.approval.approvalSummary} onOpenApproval={execution.approval.openApproval} /> : null}
        {resolved && preferences && serverId ? <SettingAnchor setting={DEPLOYMENTS_SETTINGS.settings.creationDefaults}>
            <ItemGroup title={t('projects.deployments.creationDefaults')}>
                {renderDeploymentDefaultsEditorRows({ serverId, preferences, resolved,
                    inheritLabel: t('projects.deployments.defaultsEditor.useBuiltin'), disabled: !execution.ready,
                    onChange: next => { void save(next); } })}
            </ItemGroup>
        </SettingAnchor> : <SurfaceStateCard kind={defaults.error ? 'error' : 'loading'} title={t('projects.deployments.creationDefaults')}
            {...(defaults.error ? { action: { label: t('common.retry'), onPress: defaults.retry } } : {})} />}
        <ItemGroup><Item testID="deployment-defaults.notifications" title={t('projects.deployments.defaultsEditor.alertChannels')}
            icon={<Icon name="bell" size={18} color={theme.colors.text.secondary} />}
            onPress={() => router.push(SETTINGS_ROUTES.notifications)} /></ItemGroup>
    </ItemList>;
}
