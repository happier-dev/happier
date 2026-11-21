import * as React from 'react';
import type { ManagedGithubRepositoryHookSaveResultV1 } from '@happier-dev/protocol/automations/event-setup-result';
import type { AutomationPluginEventDefinitionTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { Modal } from '@/modal';
import { readDeploymentPushManagedRepositoryId } from './deploymentPushSetup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

export function DeploymentPushTriggerFields(props: Readonly<{
  branch: string; onBranchChange: (value: string) => void;
  approval: 'automatic' | 'ask'; inherited?: boolean;
  onApprovalChange: (value: 'automatic' | 'ask') => void;
  source?: Omit<AutomationPluginEventDefinitionTrigger, 'enabled'> | null;
}>) {
  return <>
    <Item title={t('projects.open.branch')} showChevron={false} rightElement={<FieldTextInput
      testID="deployment-push-branch" value={props.branch} onChangeText={props.onBranchChange}
      accessibilityLabel={t('projects.open.branch')} autoCapitalize="none" />} />
    <SegmentedChoiceItem title={t('settingsApiTokens.grant.deployApproval.title')}
      testIDPrefix="deployment-push-approval" value={props.approval}
      valueSource={props.inherited ? 'inherited' : 'set'} onChange={props.onApprovalChange}
      options={[
        { id: 'automatic', label: t('settingsApiTokens.grant.deployApproval.automatic') },
        { id: 'ask', label: t('settingsApiTokens.grant.deployApproval.ask') },
      ]} />
    {props.source ? <Item mode="info" testID="deployment-push-trigger-setup.delivery"
      title={t('projects.deployments.pushDelivery.title')}
      subtitle={props.source.observationTransport.kind === 'durablePush' ? t('projects.deployments.pushDelivery.webhook')
        : readDeploymentPushManagedRepositoryId(props.source) !== undefined ? t('projects.deployments.pushDelivery.managedOnSave')
        : t('projects.deployments.pushDelivery.polling')} /> : null}
  </>;
}

export function showDeploymentPushDeliveryResult(delivery: ManagedGithubRepositoryHookSaveResultV1 | undefined) {
  if (!delivery || delivery.kind === 'webhook') return;
  const code = delivery.kind === 'polling' ? delivery.code : undefined;
  const needsReconnect = code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing
    || code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  const detail = delivery.kind === 'pendingVerification' ? 'pending'
    : code === 'route_unavailable' ? 'polling' : needsReconnect ? 'reconnect' : 'unconfirmed';
  void Modal.alert(t('projects.deployments.pushDelivery.saved'), t(`projects.deployments.pushDelivery.${detail}`));
}
