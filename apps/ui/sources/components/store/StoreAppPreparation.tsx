import * as React from 'react';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { renderDeploymentCreationDefaultsRows } from '@/components/projects/deployments/DeploymentCreationDefaultsRows';
import { DeploymentProjectChoiceGroups, useDeploymentProjectChoice } from '@/components/projects/deployments/DeploymentProjectChoice';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

import type {
  StoreAppListingState,
  StoreAppPreparationInput,
  StoreAppCreateChoices,
} from './useStoreAppListing';

type Ready = Extract<StoreAppListingState, { kind: 'ready' }>;
/** The Deploys field's choice for the Account's usual controller; a Machine id is never this word. */
const CONTROLLER_DEFAULT = 'default';
type ReviewProps = Readonly<{
  ready: Ready;
  lifetime: ServerAccountScopeLifetime;
  /** The listing's name for the App; the template's own title when omitted. */
  name?: string;
  /** Explicit Store route choice, captured before the review opens. */
  initialMachine?: QualifiedMachineV1 | null;
  onClose: () => void;
}>;

/** A catalog template's own words; catalog Apps carry no plugin translation bundle, so the fallback is the text. */
export function catalogText(value: DeploymentTemplateV1['title'] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.fallback;
}

/** The App's preparation review (lab publish `addapp/reviewFirstRun`), over the listing that opened it. */
export function showStoreAppPreparation(
  props: ReviewProps & Readonly<{ name: string }>,
): string {
  return Modal.show({ component: StoreAppPreparationModal, props });
}

function StoreAppPreparationModal(
  props: ReviewProps & CustomModalInjectedProps,
) {
  return <StoreAppPreparationReview {...props} />;
}

/**
 * Where it runs, which project lists it and how it deploys, chosen explicitly; Review asks the App owner to
 * prepare exactly that, and shows what it would create. Its refusal and approval are the owner's own outcomes.
 */
export function StoreAppPreparationReview(
  props: ReviewProps & Partial<Pick<CustomModalInjectedProps, 'setChrome'>>,
) {
  const { theme } = useUnistyles();
  const { ready, lifetime, onClose } = props;
  const { serverId, accountId } = lifetime.scope;
  const name =
    props.name ?? catalogText(ready.app.title) ?? ready.item.summary.title;
  const allMachines = useMachineListForServer(serverId, true);
  // A Machine runs an App through its installation; one without an installation cannot be chosen.
  const machines = React.useMemo(
    () =>
      (allMachines ?? []).filter((machine) => Boolean(machine.installationId)),
    [allMachines],
  );
  const projectChoice = useDeploymentProjectChoice({ lifetime });
  const sources = projectChoice.sources;
  const [machineId, setMachineId] = React.useState<string | null>(() =>
    props.initialMachine && areServerProfileIdentifiersEquivalent(props.initialMachine.serverId, serverId)
      ? props.initialMachine.machineId : null);
  const [controllerId, setControllerId] = React.useState<string | null>(null);
  const [controllerMenuOpen, setControllerMenuOpen] = React.useState(false);
  const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [prepared, setPrepared] =
    React.useState<DeploymentPublishPrepareResultV1 | null>(null);
  const [refusal, setRefusal] = React.useState<Readonly<{ code: string; step: 'prepare' | 'create' }> | null>(null);
  // The Environment's own choices, with the existing create form's starting values: no name, not production,
  // managers deploy (DeploymentEnvironmentDraft).
  const [environmentName, setEnvironmentName] = React.useState('');
  const [domainHostnames, setDomainHostnames] = React.useState<Readonly<Record<string, string>>>({});
  const domainChoices = React.useMemo(() => {
    const bindings: NonNullable<StoreAppCreateChoices['domainBindings']> = [];
    let invalid = false;
    for (const domain of prepared?.template.domains ?? []) {
      const hostname = domainHostnames[domain.key] ?? '';
      if (!hostname) {
        if (domain.required) invalid = true;
        continue;
      }
      bindings.push({ templateDomainId: domain.key, hostname });
    }
    return { bindings, invalid };
  }, [domainHostnames, prepared]);
  const [production, setProduction] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const router = useRouter();
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([serverId, accountId, ready.templateRef]),
    serverId,
    onExecuted: () => {},
  });
  const approvalReview = useInPlaceApprovalReview({
    approvalId: approval.approvalId,
    approvalPending: approval.approvalPending,
    serverId,
  });

  // Only a Machine the presence owner says can take a request is choosable; the rest say why in its words.
  const presenceNowMs = useMachinePresenceNowMs(machines);
  const selectable = React.useMemo(
    () => new Set(machines
      .filter((machine) => resolveMachinePickerPresence(machine, presenceNowMs, lifetime.scope).selectable)
      .map((machine) => machine.id)),
    [lifetime.scope, machines, presenceNowMs],
  );
  const chosen = machines.find((machine) => machine.id === machineId && selectable.has(machine.id)) ?? null;
  // A fleet can hold many Machines: one field, choosable ones first, each other one disabled with its presence line.
  const machineItems = React.useMemo(
    (): DropdownMenuItem[] =>
      [...machines]
        .sort((left, right) => Number(selectable.has(right.id)) - Number(selectable.has(left.id)))
        .map((machine) => ({
          id: machine.id,
          testID: `store.app.prepare.machine.${machine.id}`,
          title: getMachineDisplayName(machine, machines),
          ...(selectable.has(machine.id)
            ? {}
            : { disabled: true, subtitle: describeMachinePresenceLine(machine, presenceNowMs, undefined, lifetime.scope).label }),
          checked: machine.id === machineId,
        })),
    [lifetime.scope, machineId, machines, presenceNowMs, selectable],
  );
  const nameOf = React.useCallback(
    (id: string) => {
      const machine = (allMachines ?? []).find((entry) => entry.id === id);
      return machine ? getMachineDisplayName(machine, allMachines ?? []) : id;
    },
    [allMachines],
  );
  const missing = !chosen
    ? t('capabilities.store.appPage.chooseMachine')
    : projectChoice.missing;

  const review = React.useCallback(async () => {
    if (pending || !chosen?.installationId || missing) return;
    const project: Pick<StoreAppPreparationInput, 'projectSourceId' | 'sourceRevision' | 'newProject'> | null = projectChoice.selection;
    if (!project) return;
    const input: StoreAppPreparationInput = {
      machineId: chosen.id,
      installationId: chosen.installationId,
      ...project,
      ...(controllerId
        ? { explicit: { controllerMachineId: controllerId } }
        : {}),
    };
    setPending(true);
    setRefusal(null);
    const outcome = await ready.prepare(input);
    setPending(false);
    if ('kind' in outcome && outcome.kind === 'prepared') {
      setPrepared(outcome);
      return;
    }
    if ('kind' in outcome && outcome.kind === 'approval_request_created') {
      approval.requestApproval(outcome.artifactId);
      return;
    }
    if ('ok' in outcome) setRefusal({ code: outcome.errorCode, step: 'prepare' });
  }, [
    approval,
    chosen,
    controllerId,
    missing,
    pending,
    projectChoice.selection,
    ready,
  ]);

  const create = React.useCallback(async () => {
    if (!prepared || creating || !environmentName.trim() || domainChoices.invalid) return;
    setCreating(true);
    setRefusal(null);
    const outcome = await ready.create(prepared, {
      name: environmentName.trim(),
      protection: production ? 'production' : 'nonProduction',
      deployerMode: 'managers',
      ...(domainChoices.bindings.length ? { domainBindings: domainChoices.bindings } : {}),
    });
    setCreating(false);
    if ('environmentId' in outcome) {
      onClose();
      const href = ready.environmentHref(outcome);
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true) fireAndForget(result, { tag: 'StoreAppPreparation.created' });
      return;
    }
    if ('kind' in outcome && outcome.kind === 'approval_request_created') {
      approval.requestApproval(outcome.artifactId);
      return;
    }
    if ('ok' in outcome) setRefusal({ code: outcome.errorCode, step: 'create' });
  }, [approval, creating, domainChoices, environmentName, onClose, prepared, production, ready, router]);
  const createMissing = !environmentName.trim()
    ? t('capabilities.store.appPage.nameEnvironment')
    : domainChoices.invalid ? t('capabilities.store.appPage.domainRequired') : null;

  const footer = prepared ? (
    <MachineSetupReviewFooter
      onCancel={() => {
        setPrepared(null);
        setRefusal(null);
      }}
      cancelLabel={t('capabilities.store.appPage.back')}
      cancelTestID="store.app.prepare.back"
      note={t('capabilities.store.appPage.prepareDescription')}
      primary={{
        label: t('capabilities.store.appPage.install'),
        testID: 'store.app.prepare.confirm',
        loading: creating,
        disabled: creating || createMissing !== null || approval.approvalPending,
        ...(createMissing ? { accessibilityHint: createMissing } : {}),
        onPress: () => {
          void create();
        },
      }}
    />
  ) : (
    <MachineSetupReviewFooter
      onCancel={onClose}
      cancelTestID="store.app.prepare.cancel"
      note={t('capabilities.store.appPage.prepareDescription')}
      primary={{
        label: t('capabilities.store.appPage.review'),
        testID: 'store.app.prepare.review',
        loading: pending,
        disabled: pending || missing !== null || approval.approvalPending,
        ...(missing ? { accessibilityHint: missing } : {}),
        onPress: () => {
          void review();
        },
      }}
    />
  );
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: t('capabilities.store.appPage.prepareTitle', { name }),
      subtitle: null,
      footer,
      phonePresentation: 'sheet' as const,
      // The card keeps its height and its body scrolls, so a step that adds rows (New project, the prepared
      // review) extends downward instead of re-centring the card upward.
      scrollHost: 'body' as const,
      dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
    }),
    [footer, name],
  );
  useModalCardChrome(props.setChrome, chrome);

  const domainServiceCounts = new Map<string, number>();
  for (const domain of prepared?.template.domains ?? []) {
    domainServiceCounts.set(domain.service, (domainServiceCounts.get(domain.service) ?? 0) + 1);
  }

  const environmentChoices = (
    <ItemGroup title={t('projects.deployments.newEnvironment')}>
      <Item
        title={t('projects.deployments.name')}
        accessoryLayout="stacked"
        rightElement={
          <FieldTextInput
            testID="store.app.prepare.environmentName"
            value={environmentName}
            onChangeText={setEnvironmentName}
            accessibilityLabel={t('projects.deployments.name')}
            placeholder={t('projects.deployments.namePlaceholder')}
          />
        }
        showChevron={false}
      />
      {prepared?.template.domains.map((domain) => {
        const service = domainServiceCounts.get(domain.service)! > 1
          ? `${domain.service}:${domain.containerPort}`
          : domain.service;
        const label = prepared.template.domains.length === 1
          ? t('capabilities.store.appPage.domainAddress')
          : t('capabilities.store.appPage.domainAddressFor', { service });
        const helper = t('capabilities.store.appPage.domainDnsHint', {
          route: t('capabilities.store.appPage.addressBody', { service: domain.service, port: domain.containerPort }),
        });
        return (
          <Item
            key={domain.key}
            title={label}
            accessoryLayout="stacked"
            rightElement={
              <FieldItem label={null} supportingText={helper}>
                <FieldTextInput
                  testID={`store.app.prepare.domain.${domain.key}`}
                  value={domainHostnames[domain.key] ?? ''}
                  onChangeText={(hostname) => setDomainHostnames((current) => ({ ...current, [domain.key]: hostname }))}
                  accessibilityLabel={label}
                  accessibilityHint={helper}
                  placeholder={t('capabilities.store.appPage.domainPlaceholder')}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </FieldItem>
            }
            showChevron={false}
          />
        );
      })}
      <Item
        testID="store.app.prepare.who"
        title={t('projects.deployments.whoTitle')}
        subtitle={t('projects.deployments.whoManagers')}
        mode="info"
      />
      <Item
        testID="store.app.prepare.production"
        title={t('projects.deployments.production')}
        subtitle={t('projects.deployments.productionHint')}
        rightElement={<Switch value={production} onValueChange={setProduction} />}
        onPress={() => setProduction((current) => !current)}
        showChevron={false}
      />
    </ItemGroup>
  );

  const phase = prepared ? (
    <>
    <ItemGroup
      testID="store.app.prepare.prepared"
      title={t('capabilities.store.appPage.preparedTitle')}
      description={t('capabilities.store.appPage.preparedDescription')}
    >
      <Item
        mode="info"
        icon={
          <Icon
            name="cube"
            size={ICON_SIZE.md}
            color={theme.colors.text.secondary}
          />
        }
        title={t('capabilities.store.appPage.createOn', {
          machine: nameOf(prepared.machine.machineId),
        })}
        subtitle={
          prepared.project.newProject
            ? t('capabilities.store.appPage.inNewProject', {
                name: prepared.project.newProject.name,
              })
            : t('capabilities.store.appPage.inProject', {
                project:
                  sources.rows.find(
                    (row) => row.id === prepared.project.projectSourceId,
                  )?.name ??
                  prepared.project.projectSourceId ??
                  '',
              })
        }
      />
      {prepared.template.firstRunSetup ? (
        <Item
          mode="info"
          icon={
            <Icon
              name="user-circle"
              size={ICON_SIZE.md}
              color={theme.colors.text.secondary}
            />
          }
          title={t('capabilities.store.appPage.firstRunTitle')}
          subtitle={t('capabilities.store.appPage.firstRunBody')}
        />
      ) : null}
      {prepared.template.domains.map((domain) => (
        <Item
          key={domain.key}
          mode="info"
          icon={
            <Icon
              name="globe"
              size={ICON_SIZE.md}
              color={theme.colors.text.secondary}
            />
          }
          title={t('capabilities.store.appPage.addressTitle')}
          subtitle={t('capabilities.store.appPage.addressBody', {
            service: domain.service,
            port: domain.containerPort,
          })}
        />
      ))}
      {renderDeploymentCreationDefaultsRows({
        defaults: prepared.creationDefaults,
        machineName: nameOf,
        iconColor: theme.colors.text.secondary,
        testID: 'store.app.prepare.defaults',
      })}
    </ItemGroup>
    {prepared.template.firstRunSetup ? (
      <AttentionBanner
        testID="store.app.prepare.firstRunWarning"
        title={t('capabilities.store.appPage.firstRunWarningTitle')}
        description={t('capabilities.store.appPage.firstRunWarningBody')}
      />
    ) : null}
    {environmentChoices}
    </>
  ) : (
    <>
      <ItemGroup
        title={t('capabilities.store.appPage.whereTitle')}
        description={t('capabilities.store.appPage.whereDescription', { name })}
      >
        {machines.length === 0 ? (
          <SurfaceStateCard
            testID="store.app.prepare.noMachine"
            kind="empty"
            size="line"
            title={t('capabilities.store.appPage.noMachine')}
          />
        ) : null}
        {machines.length > 0 ? (
          <DropdownMenu
            testID="store.app.prepare.machine"
            open={machineMenuOpen}
            onOpenChange={setMachineMenuOpen}
            search={machineItems.length > 8}
            searchPlaceholder={t('capabilities.store.softwarePage.machineLabel')}
            items={machineItems}
            selectedId={machineId ?? ''}
            onSelect={(id) => {
              setMachineMenuOpen(false);
              if (id && selectable.has(id)) setMachineId(id);
            }}
            itemTrigger={{
              title: t('capabilities.store.softwarePage.machineLabel'),
              placeholder: t('capabilities.store.softwarePage.chooseMachine'),
            }}
          />
        ) : null}
      </ItemGroup>
      <DeploymentProjectChoiceGroups
        model={projectChoice}
        testIDPrefix="store.app.prepare.project"
        description={t('capabilities.store.appPage.projectDescription')}
        newProjectHint={t('capabilities.store.appPage.projectNewHint')}
      />
      {machines.length > 0 ? (
        <ItemGroup
          title={t('capabilities.store.appPage.deploysTitle')}
          description={t('capabilities.store.appPage.deploysDescription')}
        >
          <DropdownMenu
            testID="store.app.prepare.controller"
            open={controllerMenuOpen}
            onOpenChange={setControllerMenuOpen}
            items={[
              {
                id: CONTROLLER_DEFAULT,
                title: t('capabilities.store.appPage.controllerDefault'),
                checked: controllerId === null,
              },
              ...machines.map((machine): DropdownMenuItem => ({
                id: machine.id,
                title: getMachineDisplayName(machine, machines),
                checked: machine.id === controllerId,
              })),
            ]}
            selectedId={controllerId ?? CONTROLLER_DEFAULT}
            onSelect={(id) => {
              setControllerMenuOpen(false);
              setControllerId(id && id !== CONTROLLER_DEFAULT ? id : null);
            }}
            itemTrigger={{
              title: t('capabilities.store.appPage.controllerLabel'),
              showSelectedSubtitle: false,
            }}
          />
        </ItemGroup>
      ) : null}
    </>
  );

  const notices = (
    <>
      {approval.approvalPending ? (
        <ActionApprovalPendingNotice
          testID="store.app.prepare.approval"
          presentation="banner"
          message={t('capabilities.store.appPage.approvalWaiting')}
          description={t('capabilities.store.appPage.approvalDescription')}
          onOpenApproval={approvalReview.reopen}
        />
      ) : null}
      {refusal ? (
        <SurfaceStateCard
          testID="store.app.prepare.refused"
          kind="error"
          size="line"
          title={refusal.step === 'create'
            ? t('projects.deployments.createFailedTitle')
            : t('capabilities.store.appPage.refused', { name })}
          diagnosticCode={refusal.code}
        />
      ) : null}
    </>
  );

  return (
    // A form: each section's title and description sit above its fields, and selects show their value.
    <ItemList presentation="page" keyboardShouldPersistTaps="handled">
      {notices}
      {phase}
      {/* Without card chrome (an embedding host), the decision ends the body. */}
      {props.setChrome ? null : footer}
    </ItemList>
  );
}
