import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { buildTelemetrySamplingVariablesV1, resolveTelemetryCollectorSelectionV1 } from '@happier-dev/deployments';
import type { DeploymentBindingsSetResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import {
  DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1,
  DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1,
  isMachineRoleActiveV1,
} from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { useMachineRolesEditor } from '@/components/machines/security/useMachineRolesEditor';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import { showStoreAppPreparation } from '@/components/store/StoreAppPreparation';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readProjectDeploymentDefaults } from '@/sync/api/projects/projectDeploymentDefaults';
import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineListForServer } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getPreferredLanguage, t } from '@/text';
import type { DeploymentUiBindingsInput, DeploymentUiTelemetryInput, DeploymentUiTelemetryResult } from './deploymentActions';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentRefusalRecovery } from './deploymentPresentation';
import { readDeploymentActionError } from './deploymentActionOutcome';
import { readDeploymentFailureRecovery } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentTelemetryBrief } from './useDeploymentTelemetryBrief';
import { createDeploymentReadTransport, type PublicCollectorDomainPage } from './deploymentReadTransport';
import type { TelemetryCaptureReads } from './telemetryCaptureReads';
import { formatTelemetryCapabilityStatus } from './telemetryCapabilityStatus';
import { useOpenTelemetryRegressionWorkflow } from './useOpenTelemetryRegressionWorkflow';

export type DeploymentTelemetrySheetInput = Readonly<{
  detail: DeploymentEnvironmentDetailV1;
  lifetime: ServerAccountScopeLifetime;
  environmentName: string;
  appAuthoredSampling?: boolean;
  readCaptureStatus?: TelemetryCaptureReads['status'];
  /** The Environment's `setTelemetry` Action callback (deploymentActions), at the revision this sheet read. */
  setTelemetry: (input: DeploymentUiTelemetryInput) => Promise<DeploymentUiTelemetryResult>;
  setBindings: (input: DeploymentUiBindingsInput) => Promise<DeploymentBindingsSetResultV1>;
  /** The Action settled: the Environment re-reads its revision and the tab says what applies next. */
  onSaved: (result: Extract<SaveResult, { ok: true }>) => void;
  onApproval?: (artifactId: string) => void;
}>;

const NO_MACHINES: readonly never[] = Object.freeze([]);
type SaveResult = DeploymentUiTelemetryResult | DeploymentBindingsSetResultV1;
type Refusal = Readonly<{ error: string; details?: unknown; failureCause?: ActionExecuteFailure['failureCause'] }>;

function refusalText(error: string | null): string | null {
  if (error === null) return null;
  if (
    error === 'collector_required' ||
    error === 'telemetry_role_inactive' ||
    error === 'machine_unavailable'
  ) {
    return t(`deploymentTelemetry.sheet.refused.${error}`);
  }
  return t('deploymentTelemetry.sheet.refused.other');
}

/**
 * The Environment's one telemetry sheet (P7 J1): the collector and three independent capability choices,
 * saved through `deployments.environments.telemetry.set`. Requests and queries is the collector itself:
 * turning it off clears the collector. The host Action owns placement, role and deletion refusals.
 */
export function DeploymentTelemetrySheet(
  props: DeploymentTelemetrySheetInput & CustomModalInjectedProps,
) {
  const { detail, lifetime } = props;
  const { opening: openingRegression, open: openRegressionWorkflow } = useOpenTelemetryRegressionWorkflow(lifetime, detail.environment);
  const openRegression = async () => {
    if (await openRegressionWorkflow()) props.onClose();
  };
  const environment = detail.environment;
  const allMachines =
    useMachineListForServer(lifetime.scope.serverId) ?? NO_MACHINES;
  // Only Machines whose Telemetry role is on can collect; the Action refuses any other.
  const collectors = React.useMemo(
    () =>
      allMachines.filter((machine) =>
        isMachineRoleActiveV1(
          machine.metadata,
          DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1,
          DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1,
        ),
      ),
    [allMachines],
  );
  const setUp = Boolean(environment.telemetryMachineId);
  const canManage = environment.capabilities.manageBindings;
  const selection = resolveTelemetryCollectorSelectionV1({ environment, targetLinks: detail.targetLinks });
  const offerTeamCollector = selection.kind === 'collector_required' && selection.recovery === 'deploy_collector';
  const [collectorId, setCollectorId] = React.useState<string | null>(environment.telemetryMachineId ?? null);
  React.useEffect(() => {
    if (setUp || !canManage || environment.owner.kind === 'team') return;
    const cancellation = new AbortController();
    const retirement = lifetime.onRetire(() => cancellation.abort());
    void readProjectDeploymentDefaults(lifetime, environment.projectSourceId, cancellation.signal).then(({ preferences }) => {
      if (cancellation.signal.aborted) return;
      const proposed = resolveTelemetryCollectorSelectionV1({
        environment, targetLinks: detail.targetLinks, projectDefaultMachineId: preferences.telemetryMachineId,
      });
      if (proposed.kind === 'selected') setCollectorId(selected => selected ?? proposed.machineId);
    }, () => {
      // Without a readable Project default, the picker still lets the person choose explicitly.
    });
    return () => { cancellation.abort(); retirement.dispose(); };
  }, [setUp, canManage, environment, detail.targetLinks, lifetime]);
  const initial = resolveDeploymentTelemetryCapabilitiesV1(
    detail.content.telemetry,
  );
  const [requests, setRequests] = React.useState(true);
  const [exceptions, setExceptions] = React.useState(initial.exceptions);
  const [appLlmCost, setAppLlmCost] = React.useState(initial.appLlmCost);
  const [metrics, setMetrics] = React.useState(initial.metrics);
  const { readCaptureStatus } = props;
  const [capabilityLastSampleAt, setCapabilityLastSampleAt] = React.useState<
    Awaited<ReturnType<TelemetryCaptureReads['status']>>['capabilityLastSampleAt']
  >();
  React.useEffect(() => {
    if (!readCaptureStatus) return;
    const cancellation = new AbortController();
    const retirement = lifetime.onRetire(() => cancellation.abort());
    void readCaptureStatus(cancellation.signal).then(status => {
      if (!cancellation.signal.aborted) setCapabilityLastSampleAt(status.capabilityLastSampleAt);
    }, () => {
      // Settings remain editable when collector status is unavailable.
    });
    return () => { cancellation.abort(); retirement.dispose(); };
  }, [lifetime, readCaptureStatus]);

  const capabilitySubtitle = (
    description: string, capability: keyof NonNullable<typeof capabilityLastSampleAt>, enabled: boolean,
  ) => {
    const at = requests && enabled && collectorId === environment.telemetryMachineId
      ? capabilityLastSampleAt?.[capability]
      : undefined;
    if (at === undefined) return description;
    return [description, formatTelemetryCapabilityStatus(at)].join('\n');
  };
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const [publicDomainChoice, setPublicDomainChoice] = React.useState<{
    machineId: string;
    domain?: DeploymentUiTelemetryInput['publicCollectorDomain'];
  } | null>(null);
  const needsPublicDomain = publicDomainChoice !== null && publicDomainChoice.machineId === collectorId;
  const publicCollectorDomain = needsPublicDomain ? publicDomainChoice.domain : undefined;
  // The previous collector deletes what it kept when it is replaced or turned off: one in-place confirmation.
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const accountMode = useAccountEncryptionMode();
  const name = (machineId: string | null | undefined) => {
    if (!machineId) return null;
    const machine = allMachines.find((candidate) => candidate.id === machineId);
    return machine
      ? getMachineDisplayName(machine, allMachines)
      : t('projects.deployments.aMachine');
  };
  const ready = !requests || (collectorId !== null && (!needsPublicDomain || publicCollectorDomain !== undefined));
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setRefusal(null);
      setConfirmingDelete(false);
    };
  const submit = async (press: () => Promise<SaveResult | null>) => {
    if (saving || !canManage) return;
    setSaving(true);
    setRefusal(null);
    try {
      const result = await press();
      if (result === null) return;
      if (result.ok) {
        props.onClose();
        props.onSaved(result);
        if ('state' in result && result.state === 'wrangler_required') {
          const destinations = result.destinations.map(destination =>
            `${t(`deploymentTelemetry.tabs.${destination.type}`)} · ${destination.name}`);
          Modal.alert(t('deploymentTelemetry.sheet.wranglerTitle'),
            [t('deploymentTelemetry.sheet.wranglerBody'), ...destinations].join('\n'));
        }
        return;
      }
      if (result.error === 'telemetry_deletion_confirmation_required') {
        setConfirmingDelete(true);
      } else if (result.error === 'collector_public_domain_required' && collectorId) {
        setPublicDomainChoice({ machineId: collectorId });
      } else setRefusal(result);
    } catch (error) {
      const outcome = readDeploymentActionError(error);
      if (outcome.kind === 'approval') {
        props.onClose();
        props.onApproval?.(outcome.artifactId);
      } else if (outcome.kind === 'refused') {
        setRefusal({ error: outcome.code, details: outcome.failure?.details, failureCause: outcome.failure?.failureCause });
      }
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    if (!ready) return;
    void submit(() => props.setTelemetry({
      collector: requests && collectorId ? { machineId: collectorId } : null,
      ...(requests ? { capabilities: { metrics, appLlmCost, exceptions } } : {}),
      ...(requests && publicCollectorDomain ? { publicCollectorDomain } : {}),
      ...(confirmingDelete ? { confirmDelete: true as const } : {}),
    }));
  };
  const sampleVariable = (key: string) => detail.content.bindings.find(binding =>
    binding.purpose === 'variable' && binding.phase === 'runtime' && binding.name === key);
  const sampler = sampleVariable('OTEL_TRACES_SAMPLER');
  const samplerArg = sampleVariable('OTEL_TRACES_SAMPLER_ARG');
  const samplingInVariables = [sampler, samplerArg].some(binding =>
    binding?.purpose === 'variable' && binding.managedBy !== 'telemetry');
  const ratio = samplerArg?.purpose === 'variable' && samplerArg.source.kind === 'value'
    ? Number(samplerArg.source.value)
    : null;
  const samplingDetail = samplingInVariables
    ? t('deploymentTelemetry.sheet.samplingVariables')
    : ratio === null
      ? t('deploymentTelemetry.sheet.samplingUnset')
      : t('deploymentTelemetry.sheet.samplingSet', {
          percent: new Intl.NumberFormat(getPreferredLanguage(), { style: 'percent', maximumFractionDigits: 2 }).format(ratio),
        });
  const appliedSampling = props.appAuthoredSampling ? t('deploymentTelemetry.sheet.samplingAuthored') : null;
  const samplingSubtitle = appliedSampling && (samplingInVariables || ratio !== null)
    ? `${appliedSampling}\n${samplingDetail}`
    : appliedSampling ?? samplingDetail;
  const editSampling = () => submit(async () => {
    const entered = await Modal.prompt(t('deploymentTelemetry.sheet.sampling'), t('deploymentTelemetry.sheet.samplingPrompt'), {
      inputType: 'numeric', defaultValue: ratio === null ? undefined : String(ratio * 100),
      confirmText: t('common.save'),
    });
    if (entered === null) return null;
    const percent = Number(entered.trim().replace(',', '.'));
    if (!entered.trim() || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      Modal.alert(t('deploymentTelemetry.sheet.sampling'), t('deploymentTelemetry.sheet.samplingPrompt'));
      return null;
    }
    return await props.setBindings({
      environmentId: environment.id, expectedRevision: environment.revision, remove: [],
      set: Object.entries(buildTelemetrySamplingVariablesV1(percent / 100)).map(([name, value]) => ({
        name, purpose: 'variable', phase: 'runtime', managedBy: 'telemetry', source: { kind: 'value', value },
      })),
    });
  });
  const collectorName = name(collectorId);
  const footer = (
    <ModalCardFooterActions
      cancel={{
        onPress: props.onClose,
        disabled: saving,
        testID: 'project-deployments.telemetry.cancel',
      }}
    >
      <RoundButton
        testID="project-deployments.telemetry.save"
        size="normal"
        title={
          confirmingDelete
            ? t('deploymentTelemetry.sheet.deleteAndSave')
            : t('deploymentTelemetry.sheet.save')
        }
        loading={saving}
        disabled={saving || !ready || !canManage}
        onPress={save}
      />
    </ModalCardFooterActions>
  );
  React.useEffect(() => {
    props.setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => props.setChrome?.(null), [props.setChrome]);
  const refused = refusalText(refusal?.error ?? null);
  const rejectedMachineId = refusal?.error === 'telemetry_role_inactive'
    && refusal.details && typeof refusal.details === 'object' && 'machineId' in refusal.details
    ? refusal.details.machineId : null;
  const roleOffMachineId = rejectedMachineId ?? (collectorId && !collectors.some(machine => machine.id === collectorId) ? collectorId : null);
  const roleOffMachine = canManage && requests ? allMachines.find(machine => machine.id === roleOffMachineId) : undefined;
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View
        testID="project-deployments.telemetry.sheet-body"
        style={deploymentSheetStyles.body}
      >
        <Text style={deploymentSheetStyles.lead}>
          {t('deploymentTelemetry.sheet.purpose')}
        </Text>
        {canManage ? null : (
          <SurfaceStateCard
            testID="project-deployments.telemetry.no-access"
            size="line"
            kind="unavailable"
            title={t('deploymentTelemetry.sheet.noAccess')}
          />
        )}
        <ItemGroup
          title={t('deploymentTelemetry.sheet.collector')}
          description={
            environment.owner.kind === 'team'
              ? t('deploymentTelemetry.sheet.team')
              : collectors.length === 0
                ? t('deploymentTelemetry.sheet.noCollector')
                : t('deploymentTelemetry.sheet.collectorDescription')
          }
        >
          <SessionMachineField
            testID="project-deployments.telemetry.collector"
            serverId={lifetime.scope.serverId}
            machines={collectors}
            machineId={collectorId}
            machineName={collectorName}
            title={t('deploymentTelemetry.sheet.machine')}
            awayMachinesChoosable
            disabled={saving || !canManage || !requests}
            onSelectMachine={(machine) => change(setCollectorId)(machine.id)}
          />
          {roleOffMachine ? (
            <CollectorRoleRecovery key={roleOffMachine.id} machine={roleOffMachine} environment={environment} onDraftOpened={props.onClose}
              machineName={getMachineDisplayName(roleOffMachine, allMachines)} lifetime={lifetime}
              disabled={saving} onEnabled={() => setRefusal(null)} />
          ) : null}
          {offerTeamCollector && requests && canManage ? (
            <Item
              testID="project-deployments.telemetry.deploy-collector"
              title={t('deploymentTelemetry.sheet.deployCollector')}
              disabled={saving}
              onPress={() => {
                props.onClose();
                showStoreAppPreparation({
                  selection: { sourceId: 'happier.deployment.templates/data-services', itemId: 'telemetry-collector' },
                  lifetime, projectSourceId: environment.projectSourceId,
                  name: t('deploymentTelemetry.sheet.deployCollector'),
                });
              }}
            />
          ) : null}
          {setUp && canManage ? (
            <Item
              testID="project-deployments.telemetry.rotate"
              title={t('deploymentTelemetry.sheet.rotate')}
              subtitle={t('deploymentTelemetry.sheet.rotateDescription')}
              disabled={saving}
              onPress={() => { void submit(() => props.setTelemetry({ rotate: true })); }}
            />
          ) : null}
        </ItemGroup>
        {canManage && requests && needsPublicDomain && collectorId ? (
          <ItemGroup title={t('deploymentTelemetry.sheet.collectorPublicDomain')}>
            <CollectorPublicDomainPicker key={collectorId} lifetime={lifetime} machineId={collectorId}
              serverId={environment.serverId} selected={publicCollectorDomain?.domainId}
              disabled={saving} onSelect={domain => setPublicDomainChoice({ machineId: collectorId, domain })} />
          </ItemGroup>
        ) : null}
        <ItemGroup title={t('deploymentTelemetry.sheet.record')}>
          <Item
            testID="project-deployments.telemetry.requests"
            title={t('deploymentTelemetry.sheet.requests')}
            subtitle={t('deploymentTelemetry.sheet.requestsDescription')}
            disabled={saving || !canManage}
            rightElement={
              <Switch
                testID="project-deployments.telemetry.requests.switch"
                value={requests}
                onValueChange={change(setRequests)}
                disabled={saving || !canManage}
              />
            }
          />
          <Item
            testID="project-deployments.telemetry.exceptions"
            title={t('deploymentTelemetry.sheet.exceptions')}
            subtitle={capabilitySubtitle(t('deploymentTelemetry.sheet.exceptionsDescription'), 'exceptions', exceptions)}
            disabled={saving || !canManage || !requests}
            rightElement={
              <Switch
                value={requests && exceptions}
                onValueChange={change(setExceptions)}
                disabled={saving || !canManage || !requests}
              />
            }
          />
          <Item
            testID="project-deployments.telemetry.llm"
            title={t('deploymentTelemetry.sheet.llm')}
            subtitle={capabilitySubtitle(t('deploymentTelemetry.sheet.llmDescription'), 'appLlmCost', appLlmCost)}
            disabled={saving || !canManage || !requests}
            rightElement={
              <Switch
                value={requests && appLlmCost}
                onValueChange={change(setAppLlmCost)}
                disabled={saving || !canManage || !requests}
              />
            }
          />
          <Item
            testID="project-deployments.telemetry.metrics"
            title={t('deploymentTelemetry.sheet.metrics')}
            subtitle={capabilitySubtitle(t('deploymentTelemetry.sheet.metricsDescription'), 'metrics', metrics)}
            disabled={saving || !canManage || !requests}
            rightElement={
              <Switch
                value={requests && metrics}
                onValueChange={change(setMetrics)}
                disabled={saving || !canManage || !requests}
              />
            }
          />
          {requests && !offerTeamCollector ? (
            <Item
              testID="project-deployments.telemetry.sampling"
              title={t('deploymentTelemetry.sheet.sampling')}
              subtitle={samplingSubtitle}
              subtitleLines={appliedSampling ? 0 : undefined}
              detail={canManage && !samplingInVariables ? ratio === null ? t('deploymentTelemetry.sheet.samplingLower') : t('common.edit') : undefined}
              disabled={saving || !canManage || samplingInVariables}
              onPress={canManage && !samplingInVariables ? () => { void editSampling(); } : undefined}
            />
          ) : null}
        </ItemGroup>
        {/* Regression is not a stored choice (P7 J3): it opens the prefilled Workflow, whose Save and arm are its opt-in. */}
        {setUp ? (
          <ItemGroup title={t('deploymentTelemetry.sheet.afterDeploy')}>
            <Item
              testID="project-deployments.telemetry.regression"
              title={t('deploymentTelemetry.sheet.regression')}
              subtitle={t('deploymentTelemetry.sheet.regressionDescription')}
              detail={t('deploymentTelemetry.sheet.regressionAction')}
              disabled={saving || openingRegression}
              onPress={() => { void openRegression(); }}
            />
          </ItemGroup>
        ) : null}
        {confirmingDelete ? (
          <SurfaceStateCard
            testID="project-deployments.telemetry.confirm-delete"
            size="line"
            kind="warning"
            title={t('deploymentTelemetry.sheet.confirmDeleteTitle')}
            reason={t('deploymentTelemetry.sheet.confirmDelete', {
              machine:
                name(environment.telemetryMachineId) ??
                t('projects.deployments.aMachine'),
            })}
          />
        ) : null}
        {refused ? (
          <SurfaceStateCard
            testID="project-deployments.telemetry.refused"
            size="line"
            kind="unavailable"
            title={refused}
            diagnosticCode={refusal?.error}
            reason={refusal && refused === t('deploymentTelemetry.sheet.refused.other')
              ? readDeploymentRefusalRecovery(refusal.error, refusal.details, undefined, refusal.failureCause?.errorCode,
                { failureCause: refusal.failureCause })?.remedy
                ?? readDeploymentFailureRecovery(refusal.error, refusal.details).remedy : undefined}
          />
        ) : null}
        {/* D30: raw telemetry stays on the collector; native issue metadata is Account data, said by Account mode. */}
        {requests && exceptions && collectorName ? (
          <Text
            testID="project-deployments.telemetry.kept"
            style={deploymentSheetStyles.lead}
          >
            {accountMode === 'plain'
              ? t('deploymentTelemetry.sheet.keptPlain', {
                  machine: collectorName,
                })
              : t('deploymentTelemetry.sheet.keptEncrypted', {
                  machine: collectorName,
                })}
          </Text>
        ) : null}
        {props.setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

function CollectorRoleRecovery({ machine, machineName, lifetime, environment, disabled, onEnabled, onDraftOpened }: Readonly<{
  machine: Machine;
  machineName: string;
  lifetime: ServerAccountScopeLifetime;
  disabled: boolean;
  environment: DeploymentEnvironmentDetailV1['environment'];
  onEnabled: () => void;
  onDraftOpened: () => void;
}>) {
  const now = useMachinePresenceNowMs(React.useMemo(() => [machine], [machine]));
  const roles = useMachineRolesEditor({ scope: lifetime.scope, machine, machineName, online: isMachineOnline(machine, now) });
  const { openBrief, openingBrief } = useDeploymentTelemetryBrief(lifetime, environment);
  if (roles.list.status !== 'ready' || !roles.list.roles.some(role => role.id === DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1)) return null;
  if (roles.shownActive.has(DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1)) return null;
  if (!roles.canManage) return <Item
    testID="project-deployments.telemetry.ask-role-owner"
    title={t('deploymentTelemetry.sheet.askRoleOwner')}
    disabled={disabled || openingBrief}
    onPress={async () => {
      const { serverId } = lifetime.scope;
      const opened = await openBrief(() => ({
        kind: 'collector_role_recovery',
        environment: { serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
        sourceScope: { serverId, machineId: machine.id },
        roleId: DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1,
      }));
      if (opened) onDraftOpened();
    }}
  />;
  return <Item
    testID="project-deployments.telemetry.enable-role"
    title={t('deploymentTelemetry.sheet.enableRole')}
    subtitle={roles.readOnlyReason ?? machineName}
    disabled={disabled || roles.busy || roles.readOnlyReason !== null}
    onPress={async () => {
      if (await roles.setRole(DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, true)) onEnabled();
    }}
  />;
}

function CollectorPublicDomainPicker({ lifetime, serverId, machineId, selected, disabled, onSelect }: Readonly<{
  lifetime: ServerAccountScopeLifetime;
  serverId: string;
  machineId: string;
  selected?: string;
  disabled: boolean;
  onSelect(domain: NonNullable<DeploymentUiTelemetryInput['publicCollectorDomain']>): void;
}>) {
  const [query, setQuery] = React.useState<{ cursor?: string; app?: NonNullable<PublicCollectorDomainPage['app']> }>({});
  const [page, setPage] = React.useState<PublicCollectorDomainPage | null>(null);
  const [failure, setFailure] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    const cancellation = new AbortController();
    const retirement = lifetime.onRetire(() => cancellation.abort());
    void createDeploymentReadTransport(lifetime).listPublicCollectorDomains(lifetime.scope,
      { serverId, machineId, ...query }, { signal: cancellation.signal }).then(result => {
      if (cancellation.signal.aborted) return;
      setLoading(false);
      setFailure(!result.ok);
      if (result.ok) setPage(previous => ({ ...result.value, items: [...(previous?.items ?? []), ...result.value.items] }));
    });
    return () => { cancellation.abort(); retirement.dispose(); };
  }, [lifetime, serverId, machineId, query]);
  const load = (cursor?: string) => {
    setLoading(true);
    setFailure(false);
    setQuery({ cursor, ...(page?.app ? { app: page.app } : {}) });
  };
  const app = page?.app;
  return (
    <>
      {page && app ? page.items.map(domain => (
        <Item key={domain.domainId} testID={`project-deployments.telemetry.public-domain.${domain.domainId}`}
          title={domain.endpoint} selected={selected === domain.domainId} accessibilityRole="radio" showChevron={false}
          disabled={disabled} onPress={() => onSelect({ environmentId: app.environmentId,
            targetLinkId: app.targetLinkId, domainId: domain.domainId })} />
      )) : null}
      {loading ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} /> : null}
      {failure ? <SurfaceStateCard size="line" kind="unavailable" title={t('projects.deployments.domainsErrorTitle')}
        action={{ label: t('common.retry'), onPress: () => load(query.cursor) }} /> : null}
      {!loading && !failure && page?.nextCursor ? (
        <Item title={t('common.next')} disabled={disabled} onPress={() => load(page.nextCursor ?? undefined)} />
      ) : null}
      {!loading && !failure && page?.items.length === 0 && page.nextCursor === null ? (
        <SurfaceStateCard size="line" kind="empty" title={t('deploymentTelemetry.sheet.collectorPublicDomainEmpty')} />
      ) : null}
    </>
  );
}

export function showDeploymentTelemetrySheet(
  input: DeploymentTelemetrySheetInput,
) {
  showDeploymentSheet({
    component: DeploymentTelemetrySheet,
    props: input,
    title: t('deploymentTelemetry.sheet.title', {
      name: input.environmentName,
    }),
    testID: 'project-deployments.telemetry.sheet',
  });
}
