import * as React from 'react';
import type { DeploymentEnvironmentSecretScopeV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DeploymentWithdrawnSecretControl, type DeploymentSecretControlTarget } from './DeploymentWithdrawnSecretControl';

const id = 'project-deployments.environment.secret-scope';

/** The Environment read checks installed workload seals. The viewer's picker says only what they can choose. */
export function DeploymentSecretBindingsNotice(props: Readonly<{
    secretScope: DeploymentEnvironmentSecretScopeV1 | undefined;
    canManageBindings: boolean;
    refresh?: () => void;
    useNewRevision?: () => void;
    controlTarget?: DeploymentSecretControlTarget;
}>) {
    const router = useRouter();
    const scope = props.secretScope;
    if (!scope || scope.status === 'ready') return null;

    // The reason describes aggregate coverage and cannot identify the affected binding.
    const resourceUnavailable = scope.reason === 'secret_scope_resource_unavailable';
    const revisionChanged = scope.reason === 'secret_scope_resource_revision_changed';
    const grantsRequired = scope.reason === 'secret_scope_grants_required';
    const reason = resourceUnavailable ? t('projects.deployments.editors.bindingScope.resourceUnavailable')
        : revisionChanged ? t('projects.deployments.editors.bindingScope.revisionChanged')
            : grantsRequired ? t('projects.deployments.editors.bindingScope.grantsRequired')
                : t('projects.deployments.editors.bindingScope.requirementsUnavailable');
    const needsBindingRepair = resourceUnavailable || revisionChanged || grantsRequired;
    const repair = revisionChanged && props.useNewRevision
        ? { label: t('projects.deployments.editors.useNewRevision'), onPress: props.useNewRevision }
        : needsBindingRepair && props.canManageBindings
            ? { label: t('settings.secrets'), onPress: () => router.push(SETTINGS_ROUTES.secrets) }
            : props.refresh ? { label: t('common.retry'), onPress: props.refresh } : undefined;
    const note = needsBindingRepair && !props.useNewRevision
        ? t(props.canManageBindings ? 'projects.deployments.editors.bindingScope.reviewBindings' : 'projects.deployments.editors.bindingScope.askManager')
        : undefined;
    return <>
        <SurfaceStateCard testID={id} size="line" kind="warning" title={t('projects.deployments.editors.bindingScope.title')}
            reason={reason} diagnosticCode={scope.reason} note={note} action={repair && { ...repair, testID: id + '.repair' }} />
        {resourceUnavailable && props.controlTarget ? <DeploymentWithdrawnSecretControl target={props.controlTarget} /> : null}
    </>;
}
