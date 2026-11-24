import * as React from 'react';
import { Button, ErrorState, Row, Stack, Text } from '@happier-dev/plugin-ui';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';
import { deploymentDatabaseAgentLevelLabel } from './DeploymentDatabaseAccessSettings';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { readDeploymentHomeWake, useDeploymentProject } from './useDeploymentProject';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

type AccessObserverInput = Parameters<NonNullable<HostDatabaseWorkbench['renderEnvironmentAccessObserver']>>[0];
type AccessSettingsInput = Parameters<NonNullable<HostDatabaseWorkbench['renderEnvironmentAccessSettings']>>[0];
export type DeploymentWorkbenchPresentationScope = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    isCurrent(): boolean;
}>;

export function readDeploymentWorkbenchLifetime(scope: DeploymentWorkbenchPresentationScope, serverId: string) {
    const lifetime = scope.accountLifetime;
    return scope.isCurrent() && lifetime?.isCurrent() && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId)
        ? lifetime : null;
}

/** Listen through the existing Home wake. A Preview additionally tracks its template identity. */
export function DeploymentWorkbenchAccessObserver({ target, environment, policyEnvironmentId, onChanged, scope }:
    AccessObserverInput & Readonly<{ scope: DeploymentWorkbenchPresentationScope }>) {
    const { serverId, projectSourceId, environmentId } = target.environment;
    const presented = useDeploymentPresentationDemand(true);
    // Production protection and Preview inheritance can coexist. The Access result resolves the policy owner;
    // until then a wake from this Source can revalidate its Preview without a separate Environment read.
    const unresolvedTemplate = policyEnvironmentId === undefined && (environment === 'preview' || environment === 'production');
    React.useEffect(() => {
      const lifetime = readDeploymentWorkbenchLifetime(scope, serverId);
      if (!presented.visible || !lifetime) return;
      return subscribeHomeAccountChange(event => {
        if (!scope.isCurrent() || !lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
        const wake = readDeploymentHomeWake(event);
        if (wake === 'all' || wake?.some(change => !change.deploymentId && !change.activityChanged
            && (change.projectSourceId === undefined || change.projectSourceId === projectSourceId)
            && (unresolvedTemplate || change.environmentId === environmentId || change.environmentId === policyEnvironmentId))) onChanged();
      }, { serverIds: [lifetime.scope.serverId] });
    }, [environmentId, onChanged, policyEnvironmentId, presented.visible, projectSourceId, scope, serverId, unresolvedTemplate]);
    return null;
}

/** Access Read supplied the policy owner address, including the template when a Preview is selected. */
export function DeploymentWorkbenchAccessSettings({ target, policy, scope }:
    AccessSettingsInput & Readonly<{ scope: DeploymentWorkbenchPresentationScope }>) {
    const router = useRouter();
    const { projectSourceId } = target.environment;
    const { serverId, environmentId } = policy;
    const presented = useDeploymentPresentationDemand(true);
    const lifetime = readDeploymentWorkbenchLifetime(scope, serverId);
    const { controller } = useDeploymentProject(lifetime, projectSourceId, presented);
    const record = useDeploymentEnvironmentRecord(controller, environmentId, presented);
    const environment = record.snapshot.value?.environment;
    return <Stack gap="small">
        {environment ? <>
            <Text tone="secondary" variant="meta" value={deploymentDatabaseAgentLevelLabel(environment.dataAgentAccess ?? 'read')} />
            {environment.capabilities.role !== 'manager' ? <Text tone="secondary" variant="meta"
                value={t('projects.deployments.settingsSections.databaseAccess.askManager')} /> : null}
        </> : record.snapshot.status === 'unavailable' ? <ErrorState layout="line" kind="unavailable"
            title={t('common.unavailable')} details={record.snapshot.failure?.code}
            onRetry={record.refresh} retryLabel={t('common.retry')} /> : null}
        <Row>
            <Button variant="secondary" size="small" title={t('projects.deployments.settingsSections.databaseAccess.openSettings')}
                disabled={!lifetime} onPress={() => {
                    if (!readDeploymentWorkbenchLifetime(scope, serverId)) return;
                    router.pushRetainingCurrent(deploymentEnvironmentRoute({
                        serverId, environmentId, projectSourceId, tab: 'settings', section: 'database-access',
                    }));
                }} />
        </Row>
    </Stack>;
}
