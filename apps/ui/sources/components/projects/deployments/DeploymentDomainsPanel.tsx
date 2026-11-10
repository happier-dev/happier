import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentDomainContentV1, DeploymentEnvironmentContentV1, DeploymentTargetLinkContentV1 } from '@happier-dev/deployment-protocol/v1';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
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
import { useDeploymentEnvironmentDomains, useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { DeploymentDomainRow, type DomainCredentialRole, type DomainItem } from './DeploymentDomainRow';

type DomainActions = Pick<
  ReturnType<typeof createDeploymentActions>,
  'addDomain' | 'removeDomain' | 'verifyDomain'
> & Partial<Pick<ReturnType<typeof createDeploymentActions>, 'setBindings'>>
  & Readonly<{ inspectPlatformTarget?: DomainIngressInspection }>;
type EnvironmentContent = DeploymentEnvironmentContentV1;
type RouteExport = Readonly<{ service: string; containerPort: number }>;
const NO_SERVICES: readonly string[] = Object.freeze([]);
const NO_EXPORTS: readonly RouteExport[] = Object.freeze([]);
const NO_BOUND: ReadonlySet<string> = new Set();
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
  const { editing } = props;
  const [adding, setAdding] = React.useState(false);
  const [checkSetup, setCheckSetup] = React.useState<Readonly<{
    item: DomainItem; anchorRef: React.RefObject<View | null>;
  }> | null>(null);
  const refresh = domains.refresh;
  const onSettled = React.useCallback(() => {
    editing?.onChanged();
    void refresh();
  }, [editing, refresh]);
  const { running, outcome, press } = useDeploymentChangePress(editing?.review ?? null, onSettled);
  // The Environment record (one shared lease with the page) names its services, their declared ports and which
  // Domain credentials are already bound; it is read only where this viewer can edit.
  const record = useDeploymentEnvironmentRecord(props.controller, editing ? props.environmentId : null, props.demand);
  const environment = record.snapshot.value;
  const content: EnvironmentContent | null = environment?.content ?? null;
  const services = React.useMemo(() => content ? composeServices(content) : NO_SERVICES, [content]);
  const routeExports = content?.ownServer?.serviceExports ?? NO_EXPORTS;
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
  const canAdd = editing !== null && editing !== undefined && editing.targetLink !== null;
  const addAction = canAdd && !adding ? (
    <SectionActionButton
      testID="project-deployments.environment.domains.add"
      title={t('projects.deployments.domainAdd')}
      icon="plus"
      onPress={() => setAdding(true)}
    />
  ) : undefined;
  return (
    <ItemGroup
      testID="project-deployments.environment.domains"
      title={t('projects.deployments.tabDomains')}
      titleAccessory={
        items.length > 0 ? (
          <ManagedSectionCount count={items.length} />
        ) : undefined
      }
      description={t('projects.deployments.domainsDescription')}
      action={addAction}
    >
      {outcome && editing ? (
        <DeployOutcomeBanner
          outcome={outcome}
          pending={outcome.kind === 'approval' && editing.review.pendingId === outcome.artifactId}
          machine={editing.machine}
          onOpenReview={editing.review.open}
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
          onCancel={() => setAdding(false)}
          onAdd={async (content) => {
            const link = editing.targetLink!;
            const added = await press(() => editing.actions.addDomain({
              environmentId: props.environmentId,
              expectedRevision: editing.environmentRevision,
              targetLinkId: link.id,
              expectedTargetLinkRevision: link.revision,
              content,
            }));
            if (added) setAdding(false);
          }}
        />
      ) : null}
      {items.map(item => (
        <DeploymentDomainRow
          key={item.domain.id}
          item={item}
          accountId={props.controller.scope.accountId}
          demand={props.demand}
          disabled={running}
          onVerify={editing ? () => { void press(() => editing.actions.verifyDomain(domainOperands(props.environmentId, editing, item))); } : undefined}
          onRemove={editing ? () => { void press(() => editing.actions.removeDomain(domainOperands(props.environmentId, editing, item))); } : undefined}
          onConfigureChecks={editing && props.healthSetup ? anchorRef => setCheckSetup({ item, anchorRef }) : undefined}
          missingCredentials={setBindings && content ? missingCredentials(item, bound) : undefined}
          onChooseCredential={setBindings && content ? (role) => { void chooseCredential(item, role); } : undefined}
        />
      ))}
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
      {adding && items.length === 0 ? null : <DeploymentTabState
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
    onCancel: () => void;
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
  const [checkPath, setCheckPath] = React.useState('/');
  const [redirectTo, setRedirectTo] = React.useState('');
  const [certificate, setCertificate] = React.useState<'managed' | 'custom'>('managed');
  const [basicAuthUser, setBasicAuthUser] = React.useState('');
  const servicePorts = React.useMemo(() => [...new Set(props.routeExports
    .filter(item => item.service === service).map(item => item.containerPort))], [props.routeExports, service]);
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
  const probePath = checkPath.trim();
  const duplicate = props.taken.includes(host);
  const pathValid = routePath === '' || routePath.startsWith('/');
  const probeValid = probePath.startsWith('/');
  const redirect = redirectTo.trim();
  const user = basicAuthUser.trim();
  const ready = host.length > 0 && !duplicate && !props.busy && (provider ? !needsZone || !!zone
    : service.trim().length > 0 && portValid && pathValid && probeValid && (!needsSelection || !!ingress));
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
        if (!ready) return;
        if (provider) {
          void props.onAdd({ hostname: host, target: { kind: 'provider', ...(zone ? { zone } : {}) } });
          return;
        }
        void props.onAdd({
          hostname: host,
          target: {
            service: service.trim(),
            containerPort,
            ...(routePath ? { path: routePath } : {}),
            ...(redirect ? { redirectTo: redirect } : {}),
          },
          healthCheck: { path: probePath, expectStatus: 200 },
          ...(needsSelection && ingress ? { ingress } : {}),
          ...(props.credentials && certificate === 'custom' ? { tls: { kind: 'custom' as const } } : {}),
          ...(props.credentials && user ? { basicAuth: { username: user } } : {}),
        });
      }}
      saveDisabled={!ready}
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
              <ValueFieldSelect testID="project-deployments.environment.domains.add.service"
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
            {servicePorts.length > 0 ? (
              <ValueFieldSelect testID="project-deployments.environment.domains.add.port"
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
        </> : null}
      </View>
    </InlineAddExpander>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.space.s12 },
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
