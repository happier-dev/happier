import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { DeploymentVariablesPanel } from './DeploymentVariablesPanel';
import type { useEnvironmentSecretBindingsDraft } from './useEnvironmentSecretBindingsDraft';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';

/** Preview blueprints use the same variable draft, Saved Secret picker and approval recovery as Variables. */
export function DeploymentPreviewVariables(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  draft: ReturnType<typeof useEnvironmentSecretBindingsDraft>;
  review: DeploymentReviewHandle;
  phone: boolean;
  environmentName: (id: string) => string | null;
  sealedOn: string | null;
  domainRead: NonNullable<React.ComponentProps<typeof DeploymentVariablesPanel>['domainRead']>;
}>) {
  return <DeploymentVariablesPanel draft={props.draft} phone={props.phone} environmentName={props.environmentName}
    title={t('projects.deployments.settingsSections.previewEditor.variables')}
    description={t('projects.deployments.settingsSections.previewEditor.variablesBody')}
    environmentId={props.detail.environment.id} scope={props.lifetime.scope} lifetime={props.lifetime}
    review={props.review} sealedOn={props.sealedOn} domainRead={props.domainRead} />;
}
