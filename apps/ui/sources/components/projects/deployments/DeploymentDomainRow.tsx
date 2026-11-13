import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isDeploymentReadDemandActiveV1, projectDeploymentDomainFactsV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import type { ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';

import { ApprovalTechnicalDetails } from '@/components/approvals/ActionApprovalFieldsCard';
import { presentActionFailureTechnicalDetails } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { useItemSubtitleTextStyle } from '@/components/ui/lists/ItemSubtitleText';
import { StatusPill, StatusWord, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { t } from '@/text';
import { deploymentDomainAttention, type DomainCredentialRole, type DomainItem } from './deploymentDomainAttention';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

export type { DomainCredentialRole, DomainItem } from './deploymentDomainAttention';
type OperationAddress = NonNullable<DomainItem['domain']['operationAddress']>;
type DomainRowProps = Readonly<{
  item: DomainItem;
  accountId: string;
  demand: DeploymentReadDemandV1;
  disabled: boolean;
  onVerify?: () => void;
  onRemove?: () => void;
  onConfigureChecks?: (anchorRef: React.RefObject<View | null>) => void;
  /** Credentials this address's content asks for that no binding supplies; absent where the page cannot bind. */
  missingCredentials?: readonly DomainCredentialRole[];
  onChooseCredential?: (role: DomainCredentialRole) => void;
}>;

/** A legacy capture has no controller address to inspect; it keeps the Domain owner's desired state. */
export function DeploymentDomainRow(props: DomainRowProps) {
  return props.item.domain.operationAddress
    ? <ObservedDomainRow {...props} address={props.item.domain.operationAddress} />
    : <DomainRowContent {...props} observation={null} />;
}

/** One exact cold read, followed by the existing pushed operation store; no native-target guess or polling. */
function ObservedDomainRow(props: DomainRowProps & Readonly<{ address: OperationAddress }>) {
  const { accountId, address } = props;
  const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
  const record = useActionOperation({ serverId, operationId: address.operationId });
  const readKey = JSON.stringify([serverId, accountId, address.machineId, address.operationId]);
  const [missing, setMissing] = React.useState<Readonly<{ key: string; result: ActionOperationGetV1Response }> | null>(null);
  const presented = isDeploymentReadDemandActiveV1(props.demand);
  React.useEffect(() => {
    if (!presented) return;
    const abort = new AbortController();
    void getActionOperation({ serverId, accountId, machineId: address.machineId,
      operationId: address.operationId, requireCurrentDomainFacts: true, signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      if (result.kind === 'not_found') {
        setMissing({ key: readKey, result });
        return;
      }
      setMissing(null);
      if (result.operation.operationId !== address.operationId
        || result.operation.scope.accountId !== accountId || result.operation.scope.machineId !== address.machineId) return;
      actionOperationStore.mergeSnapshots({ serverId, snapshots: [result.operation] });
    }, () => {
      // An unavailable read cannot turn an unresolved native removal into a retryable failure.
    });
    return () => abort.abort();
  }, [accountId, address.machineId, address.operationId, presented, readKey, serverId]);
  const observation = missing?.key === readKey ? missing.result
    : record ? { kind: 'found' as const, operation: record.snapshot } : null;
  return <DomainRowContent {...props} observation={observation} />;
}

/** Render the shared Domain owner's lifecycle and recovery facts. */
function DomainRowContent(props: DomainRowProps & Readonly<{ observation: ActionOperationGetV1Response | null }>) {
  const { theme } = useUnistyles();
  const { item } = props;
  const { state: lifecycle, retryRemoval, failure } = projectDeploymentDomainFactsV1(item.domain, props.accountId, props.observation);
  const missing = props.missingCredentials ?? [];
  // One state per row, from the Domain attention owner the live address reads too.
  const state = deploymentDomainAttention(item, lifecycle, missing);
  const tag = domainTag(item.content);
  // Recorded routed replicas say where the address leads, by Machine name; raw ids stay out of the row.
  const replicaMachineIds = React.useMemo(() => item.domain.routedReplicas?.replicas.map(replica => replica.machineId) ?? [],
    [item.domain.routedReplicas]);
  const replicaNames = useMachineDisplayNamesById(replicaMachineIds);
  const replicas = item.domain.routedReplicas && replicaMachineIds.length > 0
    ? `${t('projects.deployments.domainRecordedRoutedReplicas')} · ${[...new Set(replicaMachineIds
      .map(machineId => replicaNames[machineId] ?? t('projects.deployments.aMachine')))].join(', ')}` : null;
  const route = [domainRoute(item.content), replicas].filter(Boolean).join(' · ') || null;
  // An address that needs the person shows its recovery beside it, not only in ⋯.
  const checkAgain = state && props.onVerify && lifecycle !== 'removing' ? props.onVerify : null;
  return <>
    <Item
      testID={`project-deployments.environment.domains.${item.domain.id}`}
      icon={<Icon name="globe" size={18} color={theme.colors.text.secondary} />}
      title={item.content.hostname}
      titleAccessory={tag ? <StatusPill variant="neutral" hideDot label={tag} /> : undefined}
      subtitle={state ? <DomainStateLine state={state} route={route} /> : route}
      mode="info"
      rightElement={props.onRemove && props.onVerify ? <View style={styles.rowActions}>
        {checkAgain ? <RoundButton testID={`project-deployments.environment.domains.${item.domain.id}.checkAgain`}
          size="small" display="secondary" title={t('projects.deployments.domainCheckAgain')} disabled={props.disabled}
          onPress={checkAgain} /> : null}
        <DomainRowMenu item={item} disabled={props.disabled}
          retryRemoval={retryRemoval} onVerify={props.onVerify} onRemove={props.onRemove}
          onConfigureChecks={props.onConfigureChecks}
          missingCredentials={missing} onChooseCredential={props.onChooseCredential} />
      </View> : undefined}
    />
    {item.content.providerObservation?.dns.map((record, index) => (
      <FieldItem key={JSON.stringify([record.type, record.name, index])} label={`${record.type} · ${record.name}`}>
        <Text selectable>{record.value}</Text>
      </FieldItem>
    ))}
    {failure ? <ApprovalTechnicalDetails lines={presentActionFailureTechnicalDetails(failure)} /> : null}
  </>;
}

/** A row's `⋯`: Check again re-observes the address, Remove takes it off this environment. */
function DomainRowMenu(
  props: Readonly<{
    item: DomainItem;
    disabled: boolean;
    retryRemoval: boolean;
    onVerify: () => void;
    onRemove: () => void;
    onConfigureChecks?: (anchorRef: React.RefObject<View | null>) => void;
    missingCredentials: readonly DomainCredentialRole[];
    onChooseCredential?: (role: DomainCredentialRole) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const { missingCredentials, onChooseCredential } = props;
  const id = `project-deployments.environment.domains.${props.item.domain.id}.menu`;
  const removing = props.item.domain.state === 'removing';
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      // What the address still needs leads its menu, as the row's state line says.
      ...(!removing && onChooseCredential ? missingCredentials.map(role => ({
        id: `credential:${role}`,
        category: 'credential',
        testID: `${id}.credential.${role}`,
        title: credentialChoiceTitle(role),
        icon: <Icon name="key" size={16} color={theme.colors.text.secondary} />,
      })) : []),
      ...(!removing ? [{
        id: 'verify',
        category: 'check',
        testID: `${id}.verify`,
        title: t('projects.deployments.domainCheckAgain'),
        icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />,
      }] : []),
      ...(!removing && props.onConfigureChecks ? [{
        id: 'configure-checks',
        category: 'check',
        testID: `${id}.configure-checks`,
        title: t('projects.deployments.settingsSections.addCheck'),
        icon: <Icon name="pulse" size={16} color={theme.colors.text.secondary} />,
      }] : []),
      {
        id: 'remove',
        category: 'operations',
        testID: `${id}.remove`,
        title: t('projects.deployments.domainRemove'),
        destructive: true,
        icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
      },
    ],
    [id, missingCredentials, onChooseCredential, props.onConfigureChecks, removing, theme.colors.text.secondary],
  );
  if (props.disabled || removing && !props.retryRemoval) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={props.item.content.hostname}
      separateCategories
      onSelect={(itemId) => {
        if (itemId.startsWith('credential:')) {
          const role = missingCredentials.find(item => `credential:${item}` === itemId);
          if (role) onChooseCredential?.(role);
        } else if (itemId === 'verify') props.onVerify();
        else if (itemId === 'configure-checks') props.onConfigureChecks?.(anchorRef);
        else if (itemId === 'remove') props.onRemove();
      }}
      trigger={({ toggle }) => (
        <View ref={anchorRef}><IconButton
          testID={id}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        /></View>
      )}
    />
  );
}

/** "Needs a look · admin : 8080 · all paths": the state word and the route wrap as one run in the row's subtitle role. */
export function DomainStateLine(
  props: Readonly<{
    state: Readonly<{ variant: StatusPillVariant; label: string }>;
    route: string | null;
  }>,
) {
  const subtitleStyle = useItemSubtitleTextStyle();
  return (
    <Text style={subtitleStyle}>
      <StatusWord variant={props.state.variant} label={props.state.label} />
      {props.route ? ` · ${props.route}` : null}
    </Text>
  );
}

/** Where the address leads: a redirect, or the service and port (and path, when it is not every path). */
function domainRoute(content: DomainItem['content']): string | null {
  const { target } = content;
  if (target.kind === 'provider') return null;
  if (target.redirectTo)
    return t('projects.deployments.domainRedirect', {
      target: target.redirectTo,
    });
  return t('projects.deployments.domainRoute', {
    service: target.service,
    port: target.containerPort,
    path: target.path ?? t('projects.deployments.domainAllPaths'),
  });
}

/** The one thing that sets this address apart from a plain public one, as lab r3 tags it. */
function domainTag(content: DomainItem['content']): string | null {
  if (content.target.kind === 'provider') return null;
  if (content.target.redirectTo)
    return t('projects.deployments.domainTagRedirect');
  if (content.basicAuth) return t('projects.deployments.domainTagBasicAuth');
  if (content.tls?.kind === 'custom')
    return t('projects.deployments.domainTagOwnCertificate');
  if (content.target.path) return t('projects.deployments.domainTagPath');
  return null;
}

function credentialChoiceTitle(role: DomainCredentialRole): string {
  switch (role) {
    case 'basicAuth': return t('projects.deployments.editors.choosePassword');
    case 'certificateChain': return t('projects.deployments.editors.chooseCertificate');
    case 'privateKey': return t('projects.deployments.editors.chooseKey');
  }
}

const styles = StyleSheet.create((theme) => ({
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
