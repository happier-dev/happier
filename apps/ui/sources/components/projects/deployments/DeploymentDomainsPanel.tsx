import * as React from 'react';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import type { OwnServerDeploymentRuntimeProjectionV1 } from '@happier-dev/deployment-protocol/v1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { DeploymentDomainHealthCheckV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainHealthCheckV1';
import type { DeploymentDomainCloudflareRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentDomainContentV1, DeploymentEnvironmentContentV1, DeploymentTargetLinkContentV1 } from '@happier-dev/deployment-protocol/v1';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { NewAccountTriggerPopover } from '@/components/workflows/triggers/AccountTriggersSection';
import { guidedStarterEventSeed } from '@/components/workflows/triggers/guidedAutomation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { useDeploymentChangePress } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import {
  DeployOutcomeBanner,
  type DeploymentReviewHandle,
} from './DeploymentEnvironmentDetail';
import { useDeploymentDomainIngressFields, type DomainIngressInspection } from './DeploymentDomainIngressFields';
import { DeploymentTabState } from './DeploymentTabState';
import { readDeploymentComposeServiceFacts } from './deploymentPreflightWarnings';
import { useDeploymentEnvironmentDomains, useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { projectDeploymentDomainDnsReadinessV1, type DeploymentDomainDnsReadinessV1 } from '@happier-dev/deployments';
import { DeploymentDomainsList, type DeploymentDomainRowActions, type DomainCredentialRole, type DomainItem } from './DeploymentDomainRow';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

type DomainActions = Pick<
  ReturnType<typeof createDeploymentActions>,
  'addDomain' | 'removeDomain' | 'verifyDomain'
> & Partial<Pick<ReturnType<typeof createDeploymentActions>, 'setBindings' | 'previewDomainDns' | 'createDomainDns'>>
  & Readonly<{ inspectPlatformTarget?: DomainIngressInspection }>;
type EnvironmentContent = DeploymentEnvironmentContentV1;
type RouteExport = Readonly<{ service: string; containerPort: number }>;
const NO_SERVICES: readonly string[] = Object.freeze([]);
const NO_EXPORTS: readonly RouteExport[] = Object.freeze([]);
const NO_BOUND: ReadonlySet<string> = new Set();
/** The press position of the add form, so its outcome renders there. */
const ADD_AT = 'add';
/** The press position of the Cloudflare record form. */
const DNS_AT = 'dns';
const credentialKey = (domainId: string, role: DomainCredentialRole) => JSON.stringify([domainId, role]);

/** What the page can change here: the Action owner's Domain Actions and the revisions they are admitted against. */
export type DeploymentDomainEditing = Readonly<{
  actions: DomainActions;
  environmentRevision: number;
  recordedIngress?: DeploymentEnvironmentContentV1['ingress'];
  /** The Compose services the serving receipt runs, by name: what Service starts on when the definition lists none. */
  deployedServices?: readonly string[];
  /** The runtime target the addresses route to; Add domain needs one. */
  targetLink: Readonly<{ id: string; revision: number; provider?: DeploymentTargetLinkContentV1 | null }> | null;
  review: DeploymentReviewHandle;
  /** Names the Machine a held review waits on. */
  machine: string;
  /** A settled change moved the Environment's revision: re-read it before the next press. */
  onChanged: () => void;
}>;

/**
 * Environment → Domains (lab r3 `domains/routing`): one row per address, saying which service and port it reaches.
 * A healthy address is quiet; one still being set up, needing a look or failing says so on its row. DNS, the
 * certificate's renewal and the outside check are not published per Domain yet, so they are not drawn.
 */
export function DeploymentDomainsPanel(
  props: Readonly<{
    controller: DeploymentReadControllerV1;
    environmentId: string;
    demand: DeploymentReadDemandV1;
    phone?: boolean;
    /** The Machine the Environment's header names; a Domain route that leads only there doesn't repeat it. */
    ownMachineId?: string | null;
    runtimeProjections?: readonly OwnServerDeploymentRuntimeProjectionV1[];
    /** Absent where the page cannot write: the addresses stay read-only. */
    editing?: DeploymentDomainEditing | null;
    healthSetup?: Readonly<{ controllerMachineId: string; lifetime: ServerAccountScopeLifetime }> | null;
  }>,
) {
  const domains = useDeploymentEnvironmentDomains(
    props.controller,
    props.environmentId,
    props.demand,
  );
  const { items } = domains.result;
  const unavailableDockerDesktop = props.runtimeProjections?.some(projection =>
    presentMachineAuthorityV1({ engine: projection.engineKind }).deployment.domains === 'unavailableDockerDesktop') ?? false;
  const editing = unavailableDockerDesktop ? null : props.editing;
  const [adding, setAdding] = React.useState(false);
  const [dnsFor, setDnsFor] = React.useState<DomainItem | null>(null);
  const [checkSetup, setCheckSetup] = React.useState<Readonly<{
    item: DomainItem; anchorRef: React.RefObject<View | null>;
  }> | null>(null);
  const refresh = domains.refresh;
  const onSettled = React.useCallback(() => {
    editing?.onChanged();
    void refresh();
  }, [editing, refresh]);
  const change = useDeploymentChangePress(editing?.review ?? null, onSettled);
  const { running, outcome, press } = change;
  // The Environment record (one shared lease with the page) names its services, their declared ports and which
  // Domain credentials are already bound; it is read only where this viewer can edit.
  const record = useDeploymentEnvironmentRecord(props.controller, editing ? props.environmentId : null, props.demand);
  const environment = record.snapshot.value;
  const content: EnvironmentContent | null = environment?.content ?? null;
  // A recorded export names a service's port; otherwise the port its stored Compose service declares fills Port.
  const explicitExports = content?.ownServer?.serviceExports ?? NO_EXPORTS;
  const storedDocument = content?.definition.kind === 'stored' ? content.definition.document : null;
  const [declared, setDeclared] = React.useState<Readonly<{
    document: string; services: readonly string[]; exports: readonly RouteExport[];
  }> | null>(null);
  React.useEffect(() => {
    if (!storedDocument) return;
    let current = true;
    void readDeploymentComposeServiceFacts(storedDocument).then(facts => {
      if (current) setDeclared({ document: storedDocument, services: facts.services, exports: facts.containerPorts });
    }, () => {
      // Compose that does not parse declares no port; Port stays typed and the add's own check refuses it.
    });
    return () => { current = false; };
  }, [storedDocument]);
  const routeExports = React.useMemo(() => {
    const declaredExports = declared && declared.document === storedDocument ? declared.exports : NO_EXPORTS;
    if (declaredExports.length === 0) return explicitExports;
    const named = new Set(explicitExports.map(entry => entry.service));
    return [...explicitExports, ...declaredExports.filter(entry => !named.has(entry.service))];
  }, [declared, explicitExports, storedDocument]);
  // The definition's selected services; before one is selected (a never-deployed stored Compose), the ones it declares.
  const services = React.useMemo(() => {
    const selected = content ? composeServices(content) : NO_SERVICES;
    return selected.length > 0 || !declared || declared.document !== storedDocument ? selected : declared.services;
  }, [content, declared, storedDocument]);
  const bound = React.useMemo(() => content ? new Set(content.bindings.flatMap(binding => binding.purpose === 'domainCredential'
    ? [credentialKey(binding.domainId, binding.role)] : [])) : NO_BOUND, [content]);
  const setBindings = editing?.actions.setBindings;
  const serverId = props.controller.scope.serverId;
  const chooseCredential = React.useCallback(async (item: DomainItem, role: DomainCredentialRole) => {
    if (!setBindings || !environment) return;
    const controller = new AbortController();
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId, controller.signal);
    try {
      const { presentSavedSecretReferencePicker } = await import('@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker');
      const selected = await presentSavedSecretReferencePicker({ accountLifetime: account.accountLifetime,
        signal: controller.signal, isCurrent: () => account.accountLifetime.isCurrent() });
      if (!selected) return;
      // One `deployments.bindings.set` write, the same Action an agent uses (with `person_selects` at its review).
      await press(() => setBindings({ environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        set: [{ purpose: 'domainCredential', domainId: item.domain.id, role,
          source: { kind: 'secret', ref: selected.ref, resourceRevision: selected.resourceRevision } }], remove: [] }));
    } finally { account.dispose(); }
  }, [environment, press, serverId, setBindings]);
  // Row actions keep one identity across renders, so the list's rows re-render only for their own facts.
  const verify = useEventCallback((item: DomainItem) => {
    if (editing) void press(() => editing.actions.verifyDomain(domainOperands(props.environmentId, editing, item)));
  });
  const remove = useEventCallback((item: DomainItem) => {
    if (editing) void press(() => editing.actions.removeDomain(domainOperands(props.environmentId, editing, item)));
  });
  const adopt = useEventCallback((item: DomainItem, recovery: DeploymentDomainCloudflareRecoveryV1) => {
    if (!editing?.targetLink) return;
    const targetLink = editing.targetLink;
    void press(() => {
      const input = { ...domainOperands(props.environmentId, editing, item), targetLinkId: targetLink.id,
        expectedTargetLinkRevision: targetLink.revision };
      // Prepared content already owns the connector facts; the host resumes that exact tunnel.
      if (item.content.cloudflarePreparation) {
        return editing.actions.addDomain({ ...input, contentArtifactId: item.domain.contentArtifactId,
          contentHeaderVersion: item.domain.contentHeaderVersion, contentBodyVersion: item.domain.contentBodyVersion });
      }
      // Preparation may have failed before it persisted. Change the original explicit choice to Adopt,
      // keeping the credential, zone, connector and route inputs for the same reviewed Add Action.
      const ingress = item.content.ingress;
      const config = ingress?.config;
      const controller = isRecord(config) ? config.controller : null;
      const tunnel = isRecord(controller) ? controller.tunnel : null;
      if (!ingress || !isRecord(config) || !isRecord(controller) || !isRecord(tunnel) || typeof tunnel.name !== 'string') {
        throw new Error(t('projects.deployments.domainIngressChoose'));
      }
      return editing.actions.addDomain({ ...input, content: { ...item.content, ingress: { ...ingress,
        config: { ...config, controller: { ...controller, tunnel: { kind: 'adopt', tunnelId: recovery.tunnelId, name: tunnel.name } } } } } });
    });
  });
  const configureChecks = useEventCallback((item: DomainItem, anchorRef: React.RefObject<View | null>) => setCheckSetup({ item, anchorRef }));
  const choose = useEventCallback((item: DomainItem, role: DomainCredentialRole) => { void chooseCredential(item, role); });
  const canBind = setBindings !== undefined && content !== null;
  const missingFor = React.useCallback((item: DomainItem) => missingCredentials(item, bound), [bound]);
  const canCheck = !!editing && !!props.healthSetup;
  const addDnsRecords = useEventCallback((item: DomainItem) => setDnsFor(item));
  const canWriteDns = !!editing?.actions.createDomainDns && !!editing.actions.inspectPlatformTarget;
  const canEdit = !!editing;
  const canAdopt = !!editing?.targetLink;
  const rowActions = React.useMemo<DeploymentDomainRowActions | null>(() => canEdit ? {
    verify, remove, ...(canAdopt ? { adopt } : {}), ...(canCheck ? { configureChecks } : {}),
    ...(canBind ? { missingCredentials: missingFor, chooseCredential: choose } : {}),
    ...(canWriteDns ? { addDnsRecords } : {}),
  } : null, [addDnsRecords, adopt, canAdopt, canEdit, canBind, canCheck, canWriteDns, choose, configureChecks, missingFor, remove, verify]);
  const canAdd = editing !== null && editing !== undefined && editing.targetLink !== null;
  // An add's outcome shows inside the open form, beside the Add domain the person pressed.
  const addOutcome = adding && change.outcomeAt === ADD_AT;
  const dnsOutcome = dnsFor !== null && change.outcomeAt === DNS_AT;
  const addAction = canAdd && !adding ? (
    <SectionActionButton
      testID="project-deployments.environment.domains.add"
      title={t('projects.deployments.domainAddTitle')}
      icon="plus"
      onPress={() => setAdding(true)}
    />
  ) : undefined;
  // "3 domains" and what the list says about each (lab `envDom`); the list draws its own sheet.
  return (
    <ItemGroup
      testID="project-deployments.environment.domains"
      title={items.length > 0 ? t('projects.deployments.editors.domainsCount', { count: items.length }) : t('projects.deployments.tabDomains')}
      description={t('projects.deployments.editors.domainsLede')}
      action={addAction}
      surface="none"
    >
      {unavailableDockerDesktop ? (
        <SurfaceStateCard testID="project-deployments.environment.domains.unavailableDockerDesktop"
          size="line" kind="empty" title={t('projects.deployments.review.domainsUnavailable')} />
      ) : null}
      {outcome && editing && !addOutcome && !dnsOutcome ? (
        <DeployOutcomeBanner
          controller={change.banner}
          machine={editing.machine}
          copy="domain"
        />
      ) : null}
      {adding && editing?.targetLink ? (
        <DomainAddForm
          phone={props.phone === true}
          busy={running}
          taken={items.map((item) => item.content.hostname)}
          recordedIngress={editing.recordedIngress}
          provider={editing.targetLink.provider}
          inspect={editing.actions.inspectPlatformTarget}
          services={services}
          initialService={content ? initialDomainService(content, services.length > 0 ? services : editing.deployedServices ?? NO_SERVICES) : null}
          machine={editing.machine}
          routeExports={routeExports}
          credentials={setBindings !== undefined}
          notice={addOutcome && outcome ? (
            <DeployOutcomeBanner controller={change.banner} machine={editing.machine} copy="domainAdd" placement="inline" />
          ) : null}
          onCancel={() => setAdding(false)}
          checkDns={editing.actions.previewDomainDns ? async (content) => {
            const link = editing.targetLink!;
            const result = await editing.actions.previewDomainDns!({ environmentId: props.environmentId,
              expectedRevision: editing.environmentRevision, targetLinkId: link.id,
              expectedTargetLinkRevision: link.revision, content });
            return projectDeploymentDomainDnsReadinessV1(result.dnsHealth);
          } : undefined}
          onAdd={async (content) => {
            const link = editing.targetLink!;
            const added = await press(() => editing.actions.addDomain({
              environmentId: props.environmentId,
              expectedRevision: editing.environmentRevision,
              targetLinkId: link.id,
              expectedTargetLinkRevision: link.revision,
              content,
            }), ADD_AT);
            if (added) setAdding(false);
          }}
        />
      ) : null}
      {items.length > 0 ? <DeploymentDomainsList
        testID="project-deployments.environment.domains.list"
        items={items}
        accountId={props.controller.scope.accountId}
        serverId={props.controller.scope.serverId}
        demand={props.demand}
        ownMachineId={props.ownMachineId ?? null}
        machineName={editing?.machine ?? null}
        disabled={running}
        actions={rowActions}
      /> : null}
      {dnsFor && editing?.actions.createDomainDns && editing.actions.inspectPlatformTarget ? (
        <DomainDnsRecordsForm
          key={dnsFor.domain.id}
          hostname={dnsFor.content.hostname}
          busy={running}
          inspect={editing.actions.inspectPlatformTarget}
          notice={dnsOutcome && outcome ? (
            <DeployOutcomeBanner controller={change.banner} machine={editing.machine} copy="domain" placement="inline" />
          ) : null}
          onCancel={() => setDnsFor(null)}
          onCreate={async (dns) => {
            const created = await press(() => editing.actions.createDomainDns!({ environmentId: props.environmentId,
              expectedRevision: editing.environmentRevision, domainId: dnsFor.domain.id,
              expectedDomainRevision: dnsFor.domain.revision, dns }), DNS_AT);
            if (created) setDnsFor(null);
          }}
        />
      ) : null}
      {checkSetup && editing && props.healthSetup ? <NewAccountTriggerPopover
        anchorRef={checkSetup.anchorRef}
        onRequestClose={() => setCheckSetup(null)}
        accountLifetime={props.healthSetup.lifetime}
        initialProject={{ machineId: props.healthSetup.controllerMachineId, directory: '~' }}
        eventSeed={guidedStarterEventSeed('healthFailed', {
          subject: { kind: 'environment', environmentId: props.environmentId, machineId: props.healthSetup.controllerMachineId },
          controllerMachineId: props.healthSetup.controllerMachineId,
          domain: { domainId: checkSetup.item.domain.id, targetLinkId: checkSetup.item.domain.targetLinkId },
        })}
      /> : null}
      {unavailableDockerDesktop && domains.result.status === 'empty' || adding && items.length === 0 ? null : <DeploymentTabState
        result={domains.result}
        testID="project-deployments.environment.domains"
        errorTitle={t('projects.deployments.domainsErrorTitle')}
        emptyTitle={t('projects.deployments.domainsEmpty')}
      />}
      {domains.hasPreviousPage || domains.hasNextPage ? (
        <View style={styles.paging}>
          {domains.hasPreviousPage ? (
            <SectionActionButton
              testID="project-deployments.environment.domains.previous"
              title={t('projects.deployments.pagePrevious')}
              icon="caret-left"
              onPress={domains.previousPage}
            />
          ) : null}
          {domains.hasNextPage ? (
            <SectionActionButton
              testID="project-deployments.environment.domains.next"
              title={t('projects.deployments.pageNext')}
              icon="caret-right"
              onPress={domains.nextPage}
            />
          ) : null}
        </View>
      ) : null}
    </ItemGroup>
  );
}

/**
 * Where a new address points first: Compose's primary service, unless it is one of the Environment's databases; then
 * the one app among the known services. A public address never starts on a database (PAGE-ACCEPT-100 D7).
 */
function initialDomainService(content: EnvironmentContent, known: readonly string[]): string | null {
  const { definition } = content;
  const primary = (definition.kind === 'stored' ? definition.primaryService : definition.compose?.primaryService) ?? null;
  const databases = new Set(content.template?.data?.map((data) => data.service) ?? []);
  if (primary && !databases.has(primary)) return primary;
  const apps = known.filter((name) => !databases.has(name));
  return apps.length === 1 ? apps[0]! : null;
}

/** The Compose services the definition selects; an empty selection (every service) names none, so Service stays typed. */

function composeServices(content: EnvironmentContent): readonly string[] {
  const { definition } = content;
  const selected = definition.kind === 'stored' ? definition.services : definition.compose?.services;
  return selected && selected.length > 0 ? selected : NO_SERVICES;
}

/** The credentials an address's own content asks for (basic auth, your certificate) that no binding supplies yet. */
function missingCredentials(item: DomainItem, bound: ReadonlySet<string>): readonly DomainCredentialRole[] {
  const needed: DomainCredentialRole[] = [
    ...(item.content.basicAuth ? ['basicAuth' as const] : []),
    ...(item.content.tls?.kind === 'custom' ? ['certificateChain' as const, 'privateKey' as const] : []),
  ];
  return needed.filter(role => !bound.has(credentialKey(item.domain.id, role)));
}

/** The exact address and the revisions a Remove or Check again is admitted against. */
function domainOperands(environmentId: string, editing: DeploymentDomainEditing, item: DomainItem) {
  return {
    environmentId,
    domainId: item.domain.id,
    expectedRevision: editing.environmentRevision,
    expectedDomainRevision: item.domain.revision,
  };
}

/**
 * Add a domain (lab r3 `domains/add`): the address, then where it leads — service, container port and path on one
 * line on wide screens — then the page Happier checks from outside. Add domain stays off until the address can work.
 */
function DomainAddForm(
  props: Readonly<{
    phone: boolean;
    busy: boolean;
    taken: readonly string[];
    recordedIngress?: DeploymentEnvironmentContentV1['ingress'];
    provider?: DeploymentTargetLinkContentV1 | null;
    inspect?: DomainIngressInspection;
    /** The definition's selected Compose services; empty means Service is typed. */
    services: readonly string[];
    /** The service a new address starts on (never a database); null leaves Service to the person. */
    initialService: string | null;
    /** The Machine the Environment's own route (Caddy) serves from. */
    machine: string;
    /** Ports the Environment declares per service; a service without one keeps Port typed. */
    routeExports: readonly RouteExport[];
    /** Basic auth and your own certificate need a credential chosen on the address afterwards. */
    credentials: boolean;
    /** The last add's outcome, drawn above the form's actions. */
    notice: React.ReactNode;
    onCancel: () => void;
    /** The native DNS check of this exact draft (verify Action, preview mode); absent where the route is not native. */
    checkDns?: (content: DeploymentDomainContentV1) => Promise<DeploymentDomainDnsReadinessV1>;
    onAdd: (content: DeploymentDomainContentV1) => void | Promise<void>;
  }>,
) {
  const [hostname, setHostname] = React.useState('');
  const [service, setService] = React.useState(() => props.services.length === 0 || props.services.includes(props.initialService ?? '')
    ? props.initialService ?? '' : '');
  // The starting service's one declared port fills Port, as choosing that service does.
  const [port, setPort] = React.useState(() => {
    const ports = props.routeExports.filter(item => item.service === service);
    return ports.length === 1 ? String(ports[0]!.containerPort) : '';
  });
  const [path, setPath] = React.useState('');
  const [checkPath, setCheckPath] = React.useState('');
  const [checkStatus, setCheckStatus] = React.useState('');
  const [redirectTo, setRedirectTo] = React.useState('');
  const [certificate, setCertificate] = React.useState<'managed' | 'custom'>('managed');
  const [basicAuthUser, setBasicAuthUser] = React.useState('');
  const servicePorts = React.useMemo(() => [...new Set(props.routeExports
    .filter(item => item.service === service).map(item => item.containerPort))], [props.routeExports, service]);
  // Declared services can arrive after the form opens; an empty Service then takes the starting one.
  React.useEffect(() => {
    if (props.initialService && props.services.includes(props.initialService))
      setService(current => current === '' ? props.initialService! : current);
  }, [props.initialService, props.services]);
  // Declared ports can arrive after the form opens; an empty Port then takes the service's one port.
  React.useEffect(() => {
    if (servicePorts.length === 1) setPort(current => current === '' ? String(servicePorts[0]) : current);
  }, [servicePorts]);
  const [ingressMode, setIngressMode] = React.useState(props.recordedIngress?.kind === 'cloudflareTunnel' ? 'cloudflare' : 'environment');
  const provider = props.provider !== undefined;
  const needsZone = props.provider?.providerEnvironment?.kind === 'script';
  const principal = props.provider?.credentialPrincipal;
  const linkedZone = needsZone ? principal?.kind === 'account' && principal.target.kind === 'account'
    && props.provider?.providerIdentity ? { credentialRef: principal.target.account, accountId: props.provider.providerIdentity.providerAccountId } : null : undefined;
  const needsSelection = !provider && (props.recordedIngress?.kind === 'cloudflareTunnel' || ingressMode === 'cloudflare');
  const { selection: ingress, zone, fields: ingressFields } = useDeploymentDomainIngressFields({
    hostname: hostname.trim().toLowerCase(), busy: props.busy, inspect: props.inspect, enabled: needsSelection || needsZone, linkedZone,
  });
  const host = hostname.trim().toLowerCase();
  const containerPort = Number(port);
  const portValid = /^\d+$/.test(port) && containerPort >= 1 && containerPort <= 65535;
  const routePath = path.trim();
  const healthCheck = DeploymentDomainHealthCheckV1Schema.safeParse({ path: checkPath.trim(), expectStatus: Number(checkStatus) });
  const duplicate = props.taken.includes(host);
  const pathValid = routePath === '' || routePath.startsWith('/');
  const redirect = redirectTo.trim();
  const user = basicAuthUser.trim();
  const ready = host.length > 0 && !duplicate && !props.busy && (provider ? !needsZone || !!zone
    : service.trim().length > 0 && portValid && pathValid && healthCheck.success && (!needsSelection || !!ingress));
  // A disabled Add domain names the first field it still needs (zone and tunnel choices say so in their own rows).
  const missingField = props.busy || duplicate ? null : host.length === 0 ? t('projects.deployments.domainFieldHost')
    : provider ? null
    : service.trim().length === 0 ? t('projects.deployments.domainFieldService')
    : !portValid ? t('projects.deployments.domainFieldPort')
    : !pathValid ? t('projects.deployments.domainFieldPath')
    : !checkPath.trim() ? t('projects.deployments.domainFieldCheck')
    : !/^\d+$/.test(checkStatus.trim()) ? t('projects.deployments.domainFieldCheckStatus')
    : !healthCheck.success ? t('projects.deployments.domainFieldCheck')
    : null;
  // The one content this form adds, and the one the DNS check inspects.
  const draft = (): DeploymentDomainContentV1 | null => {
    if (host.length === 0 || duplicate) return null;
    if (provider) return needsZone && !zone ? null : { hostname: host, target: { kind: 'provider', ...(zone ? { zone } : {}) } };
    if (!healthCheck.success || !(service.trim().length > 0 && portValid && pathValid && (!needsSelection || !!ingress))) return null;
    return {
      hostname: host,
      target: {
        service: service.trim(),
        containerPort,
        ...(routePath ? { path: routePath } : {}),
        ...(redirect ? { redirectTo: redirect } : {}),
      },
      healthCheck: healthCheck.data,
      ...(needsSelection && ingress ? { ingress } : {}),
      ...(props.credentials && certificate === 'custom' ? { tls: { kind: 'custom' as const } } : {}),
      ...(props.credentials && user ? { basicAuth: { username: user } } : {}),
    };
  };
  const dnsDraft = !provider && props.checkDns ? draft() : null;
  return (
    <InlineAddExpander
      isOpen
      onOpenChange={(next) => {
        if (!next) props.onCancel();
      }}
      title={t('projects.deployments.domainAddTitle')}
      trigger={null}
      onCancel={props.onCancel}
      onSave={() => {
        const content = draft();
        if (ready && content) void props.onAdd(content);
      }}
      saveDisabled={!ready}
      saving={props.busy}
      cancelLabel={t('common.cancel')}
      saveLabel={t('projects.deployments.domainAdd')}
      saveTestID="project-deployments.environment.domains.add.save"
      cancelTestID="project-deployments.environment.domains.add.cancel"
    >
      <View style={styles.form}>
        <FieldItem label={t('projects.deployments.domainFieldHost')}>
          <FieldTextInput
            testID="project-deployments.environment.domains.add.host"
            value={hostname}
            onChangeText={setHostname}
            autoCapitalize="none"
            autoFocus
            accessibilityLabel={t('projects.deployments.domainFieldHost')}
            placeholder="docs.example.com"
            error={duplicate ? t('projects.deployments.domainExists') : null}
          />
        </FieldItem>
        {!provider && !props.recordedIngress ? (
          <>
            <FieldItem label={t('projects.deployments.editors.reachThrough')}>
              <ValueFieldSelect testID="project-deployments.environment.domains.add.ingress.mode" fill
                label={t('projects.deployments.editors.reachThrough')}
                items={[
                  // The place visitors reach, named as the lab does ("Caddy on vps-2 · public"), not the mechanism.
                  { id: 'environment', title: t('projects.deployments.editors.reachCaddy', { machine: props.machine }) },
                  { id: 'cloudflare', title: t('projects.deployments.domainIngressTitle') },
                ]}
                selectedId={ingressMode} onSelect={setIngressMode} disabled={props.busy} />
            </FieldItem>
          </>
        ) : null}
        {ingressFields}
        {!provider ? <>
        <View style={props.phone ? styles.stack : styles.route}>
          <FieldItem label={t('projects.deployments.domainFieldService')} style={props.phone ? undefined : styles.routeService}>
            {props.services.length > 0 ? (
              <ValueFieldSelect testID="project-deployments.environment.domains.add.service" fill
                label={t('projects.deployments.domainFieldService')}
                items={props.services.map(name => ({ id: name, title: name }))}
                selectedId={service || null}
                onSelect={(next) => {
                  setService(next);
                  const ports = props.routeExports.filter(item => item.service === next);
                  if (ports.length === 1) setPort(String(ports[0]!.containerPort));
                }}
                disabled={props.busy} />
            ) : <FieldTextInput
              testID="project-deployments.environment.domains.add.service"
              value={service}
              onChangeText={setService}
              monospace
              autoCapitalize="none"
              accessibilityLabel={t('projects.deployments.domainFieldService')}
              placeholder="web"
            />}
          </FieldItem>
          <FieldItem label={t('projects.deployments.domainFieldPort')} style={props.phone ? undefined : styles.routePort}>
            {/* One declared port is prefilled into the editable field; a menu only when there is a choice. */}
            {servicePorts.length > 1 ? (
              <ValueFieldSelect testID="project-deployments.environment.domains.add.port" fill placeholder={t('common.choose')}
                label={t('projects.deployments.domainFieldPort')}
                items={servicePorts.map(value => ({ id: String(value), title: String(value) }))}
                selectedId={port || null}
                onSelect={setPort}
                disabled={props.busy} />
            ) : <FieldTextInput
              testID="project-deployments.environment.domains.add.port"
              value={port}
              onChangeText={(next) => setPort(next.replace(/[^0-9]/g, ''))}
              monospace
              keyboardType="number-pad"
              accessibilityLabel={t('projects.deployments.domainFieldPort')}
              placeholder="3000"
            />}
          </FieldItem>
          <FieldItem
            label={t('projects.deployments.domainFieldPath')}
            supportingText={t('projects.deployments.domainPathHint')}
            style={props.phone ? undefined : styles.routePath}
          >
            <FieldTextInput
              testID="project-deployments.environment.domains.add.path"
              value={path}
              onChangeText={setPath}
              monospace
              autoCapitalize="none"
              accessibilityLabel={t('projects.deployments.domainFieldPath')}
              placeholder={t('projects.deployments.domainAllPaths')}
            />
          </FieldItem>
        </View>
        <FieldItem
          label={t('projects.deployments.editors.redirect')}
          supportingText={t('projects.deployments.editors.redirectHint')}
        >
          <FieldTextInput
            testID="project-deployments.environment.domains.add.redirect"
            value={redirectTo}
            onChangeText={setRedirectTo}
            monospace
            autoCapitalize="none"
            accessibilityLabel={t('projects.deployments.editors.redirect')}
            placeholder="www.example.com"
          />
        </FieldItem>
        {props.credentials ? (
          <>
            <FieldItem label={t('projects.deployments.editors.certificate')}>
              <SegmentedTabBar<'managed' | 'custom'>
                testIDPrefix="project-deployments.environment.domains.add.certificate"
                accessibilityLabel={t('projects.deployments.editors.certificate')}
                compact
                segmentSizing="content"
                role="radiogroup"
                activeTabId={certificate}
                onSelectTab={setCertificate}
                tabs={[
                  { id: 'managed', label: t('projects.deployments.editors.certificateAutomatic') },
                  { id: 'custom', label: t('projects.deployments.editors.certificateOwn') },
                ]}
              />
            </FieldItem>
            <FieldItem
              label={t('projects.deployments.editors.basicAuthUser')}
              supportingText={t('projects.deployments.editors.basicAuthHint')}
            >
              <FieldTextInput
                testID="project-deployments.environment.domains.add.basicAuth"
                value={basicAuthUser}
                onChangeText={setBasicAuthUser}
                autoCapitalize="none"
                accessibilityLabel={t('projects.deployments.editors.basicAuthUser')}
              />
            </FieldItem>
          </>
        ) : null}
        <FieldItem
          label={t('projects.deployments.domainFieldCheck')}
          supportingText={t('projects.deployments.domainCheckHint')}
        >
          <FieldTextInput
            testID="project-deployments.environment.domains.add.check"
            value={checkPath}
            onChangeText={setCheckPath}
            monospace
            autoCapitalize="none"
            accessibilityLabel={t('projects.deployments.domainFieldCheck')}
          />
        </FieldItem>
        <FieldItem label={t('projects.deployments.domainFieldCheckStatus')}>
          <FieldTextInput
            testID="project-deployments.environment.domains.add.checkStatus"
            value={checkStatus}
            onChangeText={setCheckStatus}
            monospace
            keyboardType="number-pad"
            accessibilityLabel={t('projects.deployments.domainFieldCheckStatus')}
          />
        </FieldItem>
        </> : null}
        {dnsDraft && props.checkDns ? <DomainDnsCheck content={dnsDraft} machine={props.machine} check={props.checkDns} /> : null}
        {missingField ? (
          <Text testID="project-deployments.environment.domains.add.needs" variant="meta" style={styles.needs}>
            {t('projects.deployments.editors.addNeeds', { field: missingField })}
          </Text>
        ) : null}
        {props.notice ? <View testID="project-deployments.environment.domains.add.outcome">{props.notice}</View> : null}
      </View>
    </InlineAddExpander>
  );
}

type DomainDnsPlacement = NonNullable<ReturnType<typeof useDeploymentDomainIngressFields>['dns']>;

/**
 * Add a provider's pending records in Cloudflare: the provider-owned zone picker and TTL, then one reviewed
 * `deployments.domains.dns.create` press. The records themselves come from the provider; nothing is typed here.
 */
function DomainDnsRecordsForm(props: Readonly<{
  hostname: string;
  busy: boolean;
  inspect: DomainIngressInspection;
  notice: React.ReactNode;
  onCancel: () => void;
  onCreate: (dns: DomainDnsPlacement) => void | Promise<void>;
}>) {
  const { dns, fields } = useDeploymentDomainIngressFields({ hostname: props.hostname, busy: props.busy,
    inspect: props.inspect, enabled: true, dnsRecordsOnly: true });
  return (
    <View testID="project-deployments.environment.domains.dns.form">
      <InlineAddExpander
        isOpen
        onOpenChange={(next) => { if (!next) props.onCancel(); }}
        title={t('projects.deployments.editors.domainDnsCloudflareTitle', { host: props.hostname })}
        trigger={null}
        onCancel={props.onCancel}
        onSave={() => { if (dns) void props.onCreate(dns); }}
        saveDisabled={!dns || props.busy}
        saving={props.busy}
        cancelLabel={t('common.cancel')}
        saveLabel={t('projects.deployments.editors.domainDnsCloudflareSave')}
        saveTestID="project-deployments.environment.domains.dns.save"
        cancelTestID="project-deployments.environment.domains.dns.cancel"
      >
        <View style={styles.form}>
          {fields}
          {props.notice}
        </View>
      </InlineAddExpander>
    </View>
  );
}

type DnsCheck = Readonly<{ key: string }> & (
  | Readonly<{ status: 'checking' }>
  | Readonly<{ status: 'checked'; readiness: DeploymentDomainDnsReadinessV1 }>
  | Readonly<{ status: 'failed'; code: string }>
);

/**
 * Whether the draft's name reaches this Machine, checked only when the person asks (SOS-GAP-DOMAINS: no request per
 * keystroke). An answer belongs to the exact draft it checked; editing the address shows the question again.
 */
function DomainDnsCheck(props: Readonly<{
  content: DeploymentDomainContentV1;
  machine: string;
  check: (content: DeploymentDomainContentV1) => Promise<DeploymentDomainDnsReadinessV1>;
}>) {
  const { content, check } = props;
  const key = JSON.stringify(content);
  const [result, setResult] = React.useState<DnsCheck | null>(null);
  const run = React.useCallback(() => {
    setResult({ key, status: 'checking' });
    const settle = (next: DnsCheck) => setResult(previous => previous?.key === key ? next : previous);
    check(content).then(readiness => settle({ key, status: 'checked', readiness }),
      (error: unknown) => settle({ key, status: 'failed', code: readDiagnosticCode(error) }));
  }, [check, content, key]);
  const current = result?.key === key ? result : null;
  const host = content.hostname;
  const vars = { host, machine: props.machine };
  const testID = 'project-deployments.environment.domains.add.dns';
  const again = { label: t('projects.deployments.domainCheckAgain'), onPress: run, testID: `${testID}.action` };
  if (current?.status === 'checking')
    return <SurfaceStateCard testID={`${testID}.checking`} kind="loading" size="line" title={t('projects.deployments.domainDnsUnchecked', vars)} />;
  const state = current?.status === 'failed' ? 'unavailable' : current?.readiness.state ?? 'not_checked';
  switch (state) {
    case 'missing':
      return <SurfaceStateCard testID={`${testID}.missing`} kind="warning" size="line" title={t('projects.deployments.domainDnsMissing', { host })}
        reason={t('projects.deployments.domainDnsMissingBody', { machine: props.machine })} action={again} />;
    case 'not_this_machine':
      return <SurfaceStateCard testID={`${testID}.elsewhere`} kind="warning" size="line" title={t('projects.deployments.domainDnsElsewhere', vars)}
        reason={t('projects.deployments.domainDnsElsewhereBody', { machine: props.machine })} action={again} />;
    case 'ready':
      return <SurfaceStateCard testID={`${testID}.ready`} kind="success" size="line" title={t('projects.deployments.domainDnsReady', vars)} action={again} />;
    case 'unavailable':
      return <SurfaceStateCard testID={`${testID}.unavailable`} kind="unavailable" size="line" title={t('projects.deployments.domainDnsUnavailable', { host })}
        diagnosticCode={current?.status === 'failed' ? current.code : current?.status === 'checked' ? current.readiness.reason ?? undefined : undefined}
        action={again} />;
    default:
      return <SurfaceStateCard testID={`${testID}.unchecked`} kind="empty" size="line" title={t('projects.deployments.domainDnsUnchecked', vars)}
        action={{ label: t('projects.deployments.domainDnsCheck'), onPress: run, testID: `${testID}.action` }} />;
  }
}

function readDiagnosticCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : 'deployment_unavailable';
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.space.s12 },
  needs: { color: theme.colors.text.secondary },
  stack: { gap: theme.space.s12 },
  // Service, port and path share one line on wide screens (lab 1.2 : .8 : 1); phones stack them.
  route: { flexDirection: 'row', gap: theme.space.s12, alignItems: 'flex-start' },
  routeService: { flex: 1.2 },
  routePort: { flex: 0.8 },
  routePath: { flex: 1 },
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
}));
