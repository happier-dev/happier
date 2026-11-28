import * as React from 'react';
import { Button, ErrorState, Item, ItemGroup, Row, Stack, Text } from '@happier-dev/plugin-ui';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';
import { summarizeDatabaseAccessV1 } from '@happier-dev/databases/access';
import { useDestinationVisibilitySignal } from '@/components/appShell/workspace/destinationInstanceContext';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';
import { deploymentDatabaseAgentLevelLabel, deploymentDatabaseEditorsLabel } from './DeploymentDatabaseAccessSettings';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { readDeploymentHomeWake, useDeploymentProject } from './useDeploymentProject';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

type AccessObserverInput = Parameters<NonNullable<HostDatabaseWorkbench['renderEnvironmentAccessObserver']>>[0];
type AccessSettingsInput = Parameters<NonNullable<HostDatabaseWorkbench['renderEnvironmentAccessSettings']>>[0];
type ViewerAccessTarget = Parameters<NonNullable<HostDatabaseWorkbench['useEnvironmentViewerAccess']>>[0];
export type DeploymentWorkbenchPresentationScope = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    isCurrent(): boolean;
}>;

export function readDeploymentWorkbenchLifetime(scope: DeploymentWorkbenchPresentationScope, serverId: string) {
    const lifetime = scope.accountLifetime;
    return scope.isCurrent() && lifetime?.isCurrent() && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId)
        ? lifetime : null;
}

/** The presented Home record already resolved this Person's inherited Environment policy. */
export function useDeploymentWorkbenchViewerAccess(target: ViewerAccessTarget, scope: DeploymentWorkbenchPresentationScope) {
    const address = target?.environment;
    const presented = useDeploymentPresentationDemand(Boolean(address));
    const lifetime = address ? readDeploymentWorkbenchLifetime(scope, address.serverId) : null;
    const { controller } = useDeploymentProject(lifetime, address?.projectSourceId ?? null, presented);
    const record = useDeploymentEnvironmentRecord(controller, address?.environmentId ?? null, presented);
    const environment = record.snapshot.status === 'ready' ? record.snapshot.value?.environment : undefined;
    return React.useMemo(() => environment && summarizeDatabaseAccessV1({
        requester: 'person',
        agentAccess: environment.dataAgentAccess ?? 'none',
        person: { mayWrite: environment.capabilities.editData, editingOff: environment.dataEditorMode === 'off' },
    }), [environment]);
}

/** Listen through the existing Home wake. A Preview additionally tracks its template identity. */
export function DeploymentWorkbenchAccessObserver({ target, environment, policyEnvironmentId, onChanged, scope }:
    AccessObserverInput & Readonly<{ scope: DeploymentWorkbenchPresentationScope }>) {
    const { serverId, projectSourceId, environmentId } = target.environment;
    const presentation = useDestinationVisibilitySignal();
    const { accountLifetime, isCurrent } = scope;
    // Production protection and Preview inheritance can coexist. The Access result resolves the policy owner;
    // until then a wake from this Source can revalidate its Preview without a separate Environment read.
    const unresolvedTemplate = policyEnvironmentId === undefined && (environment === 'preview' || environment === 'production');
    React.useEffect(() => {
      const lifetime = readDeploymentWorkbenchLifetime({ accountLifetime, isCurrent }, serverId);
      if (!lifetime) return;
      let needsRefresh = false;
      const refreshIfVisible = () => {
        if (!needsRefresh || !presentation.get() || !isCurrent() || !lifetime.isCurrent()) return;
        needsRefresh = false;
        onChanged();
      };
      const unsubscribeVisibility = presentation.subscribe(refreshIfVisible);
      const unsubscribeHome = subscribeHomeAccountChange(event => {
        if (!isCurrent() || !lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
        const wake = readDeploymentHomeWake(event);
        if (wake === 'all' || wake?.some(change => !change.deploymentId && !change.activityChanged
            && (change.projectSourceId === undefined || change.projectSourceId === projectSourceId)
            && (unresolvedTemplate || change.environmentId === environmentId || change.environmentId === policyEnvironmentId))) {
          needsRefresh = true;
          refreshIfVisible();
        }
      }, { serverIds: [lifetime.scope.serverId] });
      return () => { unsubscribeHome(); unsubscribeVisibility(); };
    }, [accountLifetime, environmentId, isCurrent, onChanged, policyEnvironmentId, presentation, projectSourceId, serverId, unresolvedTemplate]);
    return null;
}

/**
 * The loaded access sheet, and a policy refusal's recovery in Review: the Environment's choices, read-only, then who you
 * are. A manager's way forward opens the Environment's settings; anyone else learns whom to ask.
 * Access Read supplied the policy owner address, including the template when a Preview is selected.
 */
export function DeploymentWorkbenchAccessSettings({ target, policy, onEditingAllowed, scope }:
    AccessSettingsInput & Readonly<{ scope: DeploymentWorkbenchPresentationScope }>) {
    const router = useRouter();
    const { projectSourceId } = target.environment;
    const { serverId, environmentId } = policy;
    const presented = useDeploymentPresentationDemand(true);
    const lifetime = readDeploymentWorkbenchLifetime(scope, serverId);
    const { controller } = useDeploymentProject(lifetime, projectSourceId, presented);
    const record = useDeploymentEnvironmentRecord(controller, environmentId, presented);
    const environment = record.snapshot.value?.environment;
    const copy = 'projects.deployments.settingsSections.databaseAccess';
    const canEdit = environment?.capabilities.editData === true;
    React.useEffect(() => {
        if (canEdit) onEditingAllowed?.();
    }, [canEdit, onEditingAllowed]);
    if (!environment) {
        return record.snapshot.status === 'unavailable' ? <ErrorState layout="line" kind="unavailable"
            title={t('common.unavailable')} details={record.snapshot.failure?.code}
            onRetry={record.refresh} retryLabel={t('common.retry')} /> : null;
    }
    const manager = environment.capabilities.role === 'manager';
    return <Stack gap="small">
        <ItemGroup>
            <Item title={t(`${copy}.editors`)} detail={deploymentDatabaseEditorsLabel(environment.dataEditorMode ?? 'off')} />
            <Item title={t(`${copy}.agents`)} detail={deploymentDatabaseAgentLevelLabel(environment.dataAgentAccess ?? 'read')} />
        </ItemGroup>
        <Text tone="secondary" variant="meta" value={t(`${copy}.${manager ? 'youManage' : 'askManager'}`)} />
        {manager ? <Row>
            <Button variant="primary" size="small" title={t(`${copy}.openSettings`)}
                disabled={!lifetime} onPress={() => {
                    if (!readDeploymentWorkbenchLifetime(scope, serverId)) return;
                    router.pushRetainingCurrent(deploymentEnvironmentRoute({
                        serverId, environmentId, projectSourceId, tab: 'settings', section: 'database-access',
                    }));
                }} />
        </Row> : null}
    </Stack>;
}
