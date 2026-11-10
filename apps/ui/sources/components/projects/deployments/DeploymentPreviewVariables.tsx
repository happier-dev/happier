import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { DeploymentVariablesPanel } from './DeploymentVariablesPanel';
import { useEnvironmentSecretBindingsDraft } from './useEnvironmentSecretBindingsDraft';
import { createDeploymentActions } from './deploymentActions';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';

/** Preview blueprints use the same variable draft, Saved Secret picker and approval recovery as Variables. */
export function DeploymentPreviewVariables(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  editing: DeploymentEnvironmentEditing | null;
  review: DeploymentReviewHandle;
  phone: boolean;
  environmentName: (id: string) => string | null;
  sealedOn: string | null;
}>) {
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime, props.detail.environment.projectSourceId),
    [props.lifetime, props.detail.environment.projectSourceId]);
  const snapshot = React.useMemo(() => ({ status: 'ready' as const, value: props.detail, failure: null }), [props.detail]);
  const draft = useEnvironmentSecretBindingsDraft({ environmentId: props.detail.environment.id, lifetime: props.lifetime,
    snapshot, bindingTarget: 'previewTemplate', readOnly: !props.editing,
    setBindings: props.editing ? async (input, operation) => {
      const template = props.detail.content.previewTemplate;
      if (!template) throw new Error('deployment_unavailable');
      const result = await actions.setPreviewBindings(props.detail.environment, template, input, operation);
      if (result.ok) props.editing?.onChanged();
      return result;
    } : null });
  return <DeploymentVariablesPanel draft={draft} phone={props.phone} environmentName={props.environmentName}
    title={t('projects.deployments.settingsSections.previewEditor.variables')}
    description={t('projects.deployments.settingsSections.previewEditor.variablesBody')}
    environmentId={props.detail.environment.id} scope={props.lifetime.scope} lifetime={props.lifetime}
    review={props.review} sealedOn={props.sealedOn} />;
}
