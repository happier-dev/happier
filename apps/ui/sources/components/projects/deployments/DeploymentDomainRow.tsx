import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Status, useHappierCollection, type CollectionAnatomy, type HappierCollectionGrouping } from '@happier-dev/plugin-ui';
import {
  isDeploymentReadDemandActiveV1,
  projectDeploymentDomainDnsReadinessV1,
  projectDeploymentDomainFactsV1,
  type DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { DeploymentDomainCloudflareRecoveryV1Schema, type DeploymentDomainCloudflareRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';

import { ApprovalTechnicalDetails } from '@/components/approvals/ActionApprovalFieldsCard';
import { presentActionFailureTechnicalDetails } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { useItemSubtitleTextStyle } from '@/components/ui/lists/ItemSubtitleText';
import { StatusWord, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { t } from '@/text';
import { deploymentDomainAttention, type DomainCredentialRole, type DomainItem } from './deploymentDomainAttention';
import { ServicesPageList } from './DeploymentEnvironmentRows';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FailureInvestigationActions } from '@/components/inbox/detail/FailureInvestigationActions';

export type { DomainCredentialRole, DomainItem } from './deploymentDomainAttention';

type DomainRowItem = DomainItem & Readonly<{ attached: boolean }>;

/** What a page can do to its addresses; absent where it cannot write (the rows stay read-only). */
export type DeploymentDomainRowActions = Readonly<{
  verify: (item: DomainItem) => void;
  remove: (item: DomainItem) => void;
  configureChecks?: (item: DomainItem, anchorRef: React.RefObject<View | null>) => void;
  /** Credentials this address's content asks for that no binding supplies; absent where the page cannot bind. */
  missingCredentials?: (item: DomainItem) => readonly DomainCredentialRole[];
  chooseCredential?: (item: DomainItem, role: DomainCredentialRole) => void;
  /** Opens the provider-owned zone picker for an address whose provider records still wait (Cloudflare DNS). */
  addDnsRecords?: (item: DomainItem) => void;
  /** Reviews resuming Add with the exact tunnel retained by its failed preparation. */
  adopt?: (item: DomainItem, recovery: DeploymentDomainCloudflareRecoveryV1) => void;
}>;

type DomainRowContext = Readonly<{
  accountId: string;
  serverId: string;
  disabled: boolean;
  /** The Machine the page already names; a route that leads only there doesn't repeat it. */
  ownMachineId: string | null;
  /** The Machine's name, for the DNS instruction a waiting address carries. */
  machineName: string | null;
  actions: DeploymentDomainRowActions | null;
  /** Exact operation reads that answered not_found, by read key. */
  notFound: ReadonlyMap<string, ActionOperationGetV1Response>;
}>;

const NO_ROLES: readonly DomainCredentialRole[] = Object.freeze([]);
const NO_NOT_FOUND: ReadonlyMap<string, ActionOperationGetV1Response> = new Map();
const noop = () => {};
const keyOf = (item: DomainItem) => item.domain.id;

/**
 * The domain list (lab `envDom` / `svcDom`): one row per address with its host and the line that matters (the
 * record to add, a redirect, password protection), then Reaches, Certificate and State columns and the row's ⋯.
 * The shared Collection list draws the columns on a wide page and folds them on a phone, where the state stays at
 * the row's end. The Environment's Domains tab and Services → Domains both draw it; the Account-wide view adds its
 * Project bands (`groups`) and an Environment column (`environmentTitle`).
 */
export function DeploymentDomainsList<Item extends DomainRowItem>(props: Readonly<{
  items: readonly Item[];
  groups?: HappierCollectionGrouping<Item>;
  /** Where each address belongs, for a list that spans Environments; the Environment's own tab names it already. */
  environmentTitle?: (item: Item) => string;
  accountId: string;
  serverId: string;
  demand: DeploymentReadDemandV1;
  disabled: boolean;
  ownMachineId?: string | null;
  machineName?: string | null;
  actions?: DeploymentDomainRowActions | null;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const notFound = useDomainOperationReads(props.items, props.accountId, props.demand);
  const model = useHappierCollection<Item>({ items: props.items, keyOf, ...(props.groups ? { groups: props.groups } : {}),
    openKey: null, onOpenChange: noop });
  const { environmentTitle } = props;
  const context = React.useMemo<DomainRowContext>(() => ({
    accountId: props.accountId, serverId: props.serverId, disabled: props.disabled, ownMachineId: props.ownMachineId ?? null,
    machineName: props.machineName ?? null, actions: props.actions ?? null, notFound,
  }), [notFound, props.accountId, props.actions, props.disabled, props.machineName, props.ownMachineId, props.serverId]);
  // A platform's addresses have no service route or certificate of ours: without a routed address the two columns
  // would stay empty and squeeze the host and its DNS record, so they are drawn only when some address routes here.
  const routed = props.items.some(item => item.content.target.kind !== 'provider');
  const anatomy = React.useMemo<CollectionAnatomy<Item>>(() => ({
    glyph: () => <Icon name="globe" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
    // The host is an identifier (lab envDom): one mono line ending in an ellipsis; the label keeps it whole.
    title: (item) => item.content.hostname,
    titleIdentifier: true,
    byline: (item, layout) => <DomainByline item={item} context={context} columns={layout?.fieldColumns === true}
      environment={environmentTitle?.(item) ?? null} />,
    // The recovery an address needs stands beside it, not only in ⋯ (DEPLOY-REACCEPT-1113): it ends the byline.
    titleControls: (item) => <DomainRowControls item={item} context={context} />,
    // A phone folds the columns; the state and ⋯ keep the row's end.
    titleMeta: (item) => <DomainRowEnd item={item} context={context} />,
    titleMetaAlign: 'row',
    // The facts keep tight columns so the host keeps most of the row (lab envDom: Domain about 45%).
    fields: [
      ...(routed ? [{ key: 'reaches', title: t('projects.deployments.editors.domainColumnReaches'), minWidth: 104, priority: 3,
        listColumn: true, render: (item: Item) => <DomainReaches item={item} /> }] : []),
      ...(environmentTitle ? [{ key: 'environment', title: t('projects.deployments.editors.domainColumnEnvironment'), minWidth: 112,
        priority: 1, listColumn: true, render: (item: Item) => <DomainEnvironment title={environmentTitle(item)} /> }] : []),
      ...(routed ? [{ key: 'certificate', title: t('projects.deployments.editors.domainColumnCertificate'), minWidth: 120, priority: 2,
        listColumn: true, render: (item: Item) => <DomainCertificate item={item} /> }] : []),
      // The state and the row's ⋯ share the last column, so the bar's titles stay over their figures.
      { key: 'state', title: t('projects.deployments.editors.domainColumnState'), minWidth: 128, priority: 4, listColumn: true,
        align: 'end', control: true, render: (item) => <DomainRowEnd item={item} context={context} /> },
    ],
    accessibilityLabel: (item) => [item.content.hostname, domainRoute(item.content)].filter(Boolean).join(', '),
    testID: (item) => `project-deployments.environment.domains.${item.domain.id}`,
    columnTitles: {
      title: t('projects.deployments.editors.domainColumnDomain'),
      titleMeta: t('projects.deployments.editors.domainColumnState'),
    },
  }), [context, environmentTitle, routed, theme.colors.text.secondary]);
  return (
    // The Services page's one list shell (Apps, Databases, Checks, Watched): the same bands, column bar and phone rows.
    <ServicesPageList<Item> testID={props.testID} model={model} anatomy={anatomy}
      accessibilityLabel={t('projects.deployments.tabDomains')} />
  );
}

/**
 * One exact cold read per presented address, then the pushed operation store; no native-target guess or polling.
 * Only a typed not_found is kept here: it is what makes an unresolved removal retryable.
 */
function useDomainOperationReads(items: readonly DomainItem[], accountId: string, demand: DeploymentReadDemandV1) {
  const presented = isDeploymentReadDemandActiveV1(demand);
  const addresses = JSON.stringify(items.flatMap(item => {
    const address = item.domain.operationAddress;
    return address ? [[resolveServerProfileScopeIdForIdentifier(address.serverId), address.machineId, address.operationId]] : [];
  }));
  const [notFound, setNotFound] = React.useState(NO_NOT_FOUND);
  React.useEffect(() => {
    if (!presented) return;
    const abort = new AbortController();
    const settle = (readKey: string, result: ActionOperationGetV1Response | null) => setNotFound(current => {
      if (result ? current.get(readKey) === result : !current.has(readKey)) return current;
      const next = new Map(current);
      if (result) next.set(readKey, result);
      else next.delete(readKey);
      return next;
    });
    for (const [serverId, machineId, operationId] of JSON.parse(addresses) as [string, string, string][]) {
      const readKey = domainReadKey(serverId, accountId, machineId, operationId);
      void getActionOperation({ serverId, accountId, machineId, operationId, requireCurrentDomainFacts: true, signal: abort.signal })
        .then(result => {
          if (abort.signal.aborted) return;
          if (result.kind === 'not_found') {
            settle(readKey, result);
            return;
          }
          settle(readKey, null);
          if (result.operation.operationId !== operationId
            || result.operation.scope.accountId !== accountId || result.operation.scope.machineId !== machineId) return;
          actionOperationStore.mergeSnapshots({ serverId, snapshots: [result.operation] });
        }, () => {
          // An unavailable read cannot turn an unresolved native removal into a retryable failure.
        });
    }
    return () => abort.abort();
  }, [accountId, addresses, presented]);
  return notFound;
}

function domainReadKey(serverId: string, accountId: string, machineId: string, operationId: string) {
  return JSON.stringify([serverId, accountId, machineId, operationId]);
}

/** The shared Domain owner's lifecycle and recovery facts for one row; a legacy capture keeps its desired state. */
function useDomainRowFacts(item: DomainRowItem, context: DomainRowContext) {
  const address = item.domain.operationAddress ?? null;
  const serverId = address ? resolveServerProfileScopeIdForIdentifier(address.serverId) : null;
  const record = useActionOperation({ serverId, operationId: address?.operationId ?? '' });
  const missingRead = address && serverId !== null
    ? context.notFound.get(domainReadKey(serverId, context.accountId, address.machineId, address.operationId)) ?? null : null;
  const observation = !address ? null : missingRead ?? (record ? { kind: 'found' as const, operation: record.snapshot } : null);
  const facts = projectDeploymentDomainFactsV1(item.domain, context.accountId, observation);
  const missing = context.actions?.missingCredentials?.(item) ?? NO_ROLES;
  // One state per row, from the Domain attention owner the live address reads too.
  return { ...facts, missing, attention: deploymentDomainAttention(item, facts.state, item.attached, missing) };
}

/** State: what needs the person, in its colour; a settled healthy address says it is serving, quietly. */
function DomainStateCell(props: Readonly<{ item: DomainRowItem; context: DomainRowContext }>) {
  const { attention, state } = useDomainRowFacts(props.item, props.context);
  const testID = `project-deployments.environment.domains.${props.item.domain.id}.state`;
  if (attention) return <Status tone={attention.variant} label={attention.label} presentation="inline" testID={testID} />;
  return state === 'active'
    ? <Status tone="secondary" label={t('projects.deployments.editors.domainServing')} presentation="inline" indicator={false} testID={testID} />
    : null;
}

function DomainRowEnd(props: Readonly<{ item: DomainRowItem; context: DomainRowContext }>) {
  return <View style={styles.rowEnd}>
    <DomainStateCell item={props.item} context={props.context} />
    <DomainRowMenu item={props.item} context={props.context} />
  </View>;
}

/** Reaches: the service and port it routes to, and its path when it is not every path. */
function DomainReaches(props: Readonly<{ item: DomainItem }>) {
  const { theme } = useUnistyles();
  const { target } = props.item.content;
  if (target.kind === 'provider') return null;
  const text = target.redirectTo ? `→ ${target.redirectTo}` : `${target.service}:${target.containerPort} ${target.path ?? '/'}`;
  return <Text variant="meta" numberOfLines={1} style={[Typography.mono(), { color: theme.colors.text.secondary }]}>{text}</Text>;
}

function DomainEnvironment(props: Readonly<{ title: string }>) {
  const { theme } = useUnistyles();
  return <Text variant="meta" numberOfLines={1} style={{ color: theme.colors.text.secondary }}>{props.title}</Text>;
}

/** Certificate: whose it is, and when it expires once the outside check has read it. */
function DomainCertificate(props: Readonly<{ item: DomainItem }>) {
  const { theme } = useUnistyles();
  const { content, health } = props.item;
  if (content.target.kind === 'provider') return null;
  const kind = content.tls?.kind === 'custom'
    ? t('projects.deployments.domainTagOwnCertificate') : t('projects.deployments.editors.certificateAutomatic');
  const certificate = health?.certificate;
  const expires = certificate?.expiresAt && (certificate.state === 'valid' || certificate.state === 'expiresSoon')
    ? t('projects.deployments.editors.domainCertificateExpires', {
      date: new Date(certificate.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    }) : null;
  return <Text variant="meta" numberOfLines={1} style={{ color: theme.colors.text.secondary }}>
    {expires ? `${kind} · ${expires}` : kind}
  </Text>;
}

/**
 * The row's second line: the record to add while DNS is missing, or what sets the address apart (a redirect, a
 * password), then the Machines it leads to. A phone has no Reaches column, so a row with nothing else says its route.
 */
function DomainByline(props: Readonly<{ item: DomainItem; context: DomainRowContext; columns: boolean; environment: string | null }>) {
  const { theme } = useUnistyles();
  const { item, context } = props;
  const { content } = item;
  // Where the address leads, by Machine name, unless it is only the Machine the page already names; raw ids stay out.
  const routedMachineIds = React.useMemo(() => domainRouteMachineIds(item.domain.routedReplicas?.replicas, context.ownMachineId),
    [item.domain.routedReplicas, context.ownMachineId]);
  const routedNames = useMachineDisplayNamesById(routedMachineIds);
  const routedOn = routedMachineIds.length > 0 ? t('projects.deployments.domainRoutedOn', {
    machines: [...new Set(routedMachineIds.map(machineId => routedNames[machineId] ?? t('projects.deployments.aMachine')))].join(', '),
  }) : null;
  const dns = projectDeploymentDomainDnsReadinessV1(item.domain.dnsHealth).state;
  const records = content.providerObservation?.dns.map(record =>
    t('projects.deployments.editors.domainAddRecord', { type: record.type, name: record.name, value: record.value })) ?? [];
  const lead = records.length > 0 ? records.join(' · ')
    : dns === 'missing' && context.machineName ? t('projects.deployments.domainDnsMissingBody', { machine: context.machineName })
    : dns === 'not_this_machine' && context.machineName ? t('projects.deployments.domainDnsElsewhereBody', { machine: context.machineName })
    // A wrong answer says what came back (lab svcDom "answers 502"): the Domain health owner's observed status.
    : item.health?.needsYou?.cause === 'http' && item.health.needsYou.httpStatus !== undefined
      ? t('projects.deployments.editors.domainAnswers', { status: item.health.needsYou.httpStatus })
    : content.target.kind !== 'provider' && content.target.redirectTo ? t('projects.deployments.domainRedirect', { target: content.target.redirectTo })
    : content.basicAuth ? t('projects.deployments.domainTagBasicAuth')
    : null;
  // A phone has no Environment column: the line names it first.
  const parts = [props.columns ? null : props.environment, lead, routedOn].filter(Boolean);
  const line = parts.length > 0 ? parts.join(' · ') : props.columns ? null : domainRoute(content);
  if (!line) return null;
  return <Text variant="meta" numberOfLines={2} selectable={records.length > 0} style={{ color: theme.colors.text.secondary }}
    testID={`project-deployments.environment.domains.${item.domain.id}.line`}>{line}</Text>;
}

/** Check again beside an address that needs the person, then its investigation and a failed change's details. */
function DomainRowControls(props: Readonly<{ item: DomainRowItem; context: DomainRowContext }>) {
  const { item, context } = props;
  const { attention, state, failure } = useDomainRowFacts(item, context);
  const id = `project-deployments.environment.domains.${item.domain.id}`;
  const verify = context.actions?.verify;
  const failureDetails: unknown = failure?.details;
  const recovery = DeploymentDomainCloudflareRecoveryV1Schema.safeParse(isRecord(failureDetails) ? failureDetails.recovery : undefined);
  const adopt = context.actions?.adopt;
  const adoptTunnel = adopt && recovery.success && state !== 'removing' ? (
    <RoundButton testID={`${id}.adopt`} size="small" display="secondary" title={t('projects.deployments.domainAdoptTunnel')}
      disabled={context.disabled} onPress={() => adopt(item, recovery.data)} />
  ) : null;
  const checkAgain = !adoptTunnel && attention && attention.checkAgain !== false && verify && state !== 'removing' ? (
    <RoundButton testID={`${id}.checkAgain`} size="small" display="secondary" title={t('projects.deployments.domainCheckAgain')}
      disabled={context.disabled} onPress={() => verify(item)} />
  ) : null;
  // Only a failed address carries the investigation beside it (lab svcDom: a row says its state; G5); the
  // investigation keeps its own outcome and placement line, so it stays in the row rather than a menu.
  const investigate = attention?.variant === 'danger' ? (
    <FailureInvestigationActions subject={{ kind: 'domain', serverId: context.serverId,
      environmentId: item.domain.environmentId, domainId: item.domain.id }} serverId={context.serverId}
      controllerMachineId={item.domain.operationAddress?.machineId} compact emphasis="secondary" testID={`${id}.investigate`} />
  ) : null;
  // Records a provider still waits for can be written through Cloudflare beside where the row lists them.
  const addDnsRecords = context.actions?.addDnsRecords;
  const observation = item.content.providerObservation;
  const addRecords = addDnsRecords && state !== 'removing' && observation?.state === 'pending' && observation.dns.length > 0 ? (
    <RoundButton testID={`${id}.dnsProvider`} size="small" display="secondary"
      title={t('projects.deployments.editors.domainDnsCloudflareAction')} disabled={context.disabled}
      onPress={() => addDnsRecords(item)} />
  ) : null;
  // Why the provider could not set the address up, through the one failure-details presenter.
  const providerCause = observation?.failureCause;
  const providerDetails = providerCause ? presentActionFailureTechnicalDetails({ error: providerCause.errorCode ?? providerCause.phase,
    errorCode: providerCause.errorCode ?? providerCause.phase, failureCause: providerCause }, 'deployment') : null;
  if (!adoptTunnel && !checkAgain && !addRecords && !investigate && !failure && !providerDetails) return null;
  const actions = adoptTunnel || addRecords || checkAgain || investigate ? <View style={styles.controls}>
    {adoptTunnel}
    {addRecords}
    {checkAgain}
    {investigate}
  </View> : null;
  // Details open beneath the row's actions, never beside them: an open disclosure is a block, not a control.
  return <View style={styles.controlStack}>
    {actions}
    {failure ? <ApprovalTechnicalDetails lines={presentActionFailureTechnicalDetails(failure)} /> : null}
    {providerDetails ? <ApprovalTechnicalDetails lines={providerDetails} /> : null}
  </View>;
}

/** A row's `⋯`: a missing credential first, then Check again and Add check, then Remove. */
function DomainRowMenu(props: Readonly<{ item: DomainRowItem; context: DomainRowContext }>) {
  const { theme } = useUnistyles();
  const { item, context } = props;
  const { actions } = context;
  const { retryRemoval, missing } = useDomainRowFacts(item, context);
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const id = `project-deployments.environment.domains.${item.domain.id}.menu`;
  const removing = item.domain.state === 'removing';
  const chooseCredential = actions?.chooseCredential;
  const configureChecks = actions?.configureChecks;
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      // What the address still needs leads its menu, as the row's state says.
      ...(!removing && chooseCredential ? missing.map(role => ({
        id: `credential:${role}`, category: 'credential', testID: `${id}.credential.${role}`, title: credentialChoiceTitle(role),
        icon: <Icon name="key" size={16} color={theme.colors.text.secondary} />,
      })) : []),
      ...(!removing ? [{
        id: 'verify', category: 'check', testID: `${id}.verify`, title: t('projects.deployments.domainCheckAgain'),
        icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />,
      }] : []),
      ...(!removing && configureChecks ? [{
        id: 'configure-checks', category: 'check', testID: `${id}.configure-checks`,
        title: t('projects.deployments.settingsSections.addCheck'),
        icon: <Icon name="pulse" size={16} color={theme.colors.text.secondary} />,
      }] : []),
      {
        id: 'remove', category: 'operations', testID: `${id}.remove`, title: t('projects.deployments.domainRemove'), destructive: true,
        icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
      },
    ],
    [chooseCredential, configureChecks, id, missing, removing, theme.colors.text.secondary],
  );
  if (!actions || context.disabled || removing && !retryRemoval) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={item.content.hostname}
      separateCategories
      onSelect={(itemId) => {
        if (itemId.startsWith('credential:')) {
          const role = missing.find(entry => `credential:${entry}` === itemId);
          if (role) chooseCredential?.(item, role);
        } else if (itemId === 'verify') actions.verify(item);
        else if (itemId === 'configure-checks') configureChecks?.(item, anchorRef);
        else if (itemId === 'remove') actions.remove(item);
      }}
      trigger={({ toggle }) => (
        <View ref={anchorRef}><IconButton testID={id} iconName="dots-three" variant="plain"
          accessibilityLabel={t('common.more')} onPress={toggle} /></View>
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

/** The Machines a route names: none when its replicas run only on the Machine the page already names. */
export function domainRouteMachineIds(
  replicas: ReadonlyArray<Readonly<{ machineId: string }>> | undefined,
  ownMachineId: string | null,
): readonly string[] {
  const ids = [...new Set(replicas?.map(replica => replica.machineId) ?? [])];
  return ids.length === 1 && ids[0] === ownMachineId ? [] : ids;
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

function credentialChoiceTitle(role: DomainCredentialRole): string {
  switch (role) {
    case 'basicAuth': return t('projects.deployments.editors.choosePassword');
    case 'certificateChain': return t('projects.deployments.editors.chooseCertificate');
    case 'privateKey': return t('projects.deployments.editors.chooseKey');
  }
}

const styles = StyleSheet.create((theme) => ({
  rowEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8 },
  controlStack: { gap: theme.space.s4 },
}));
