import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { resolveTelemetryCollectorSelectionV1 } from '@happier-dev/deployments';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import {
  DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1,
  DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1,
  isMachineRoleActiveV1,
} from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import type { DeploymentUiTelemetryInput, DeploymentUiTelemetryResult } from './deploymentActions';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';

export type DeploymentTelemetrySheetInput = Readonly<{
  detail: DeploymentEnvironmentDetailV1;
  lifetime: ServerAccountScopeLifetime;
  environmentName: string;
  /** The Environment's `setTelemetry` Action callback (deploymentActions), at the revision this sheet read. */
  setTelemetry: (input: DeploymentUiTelemetryInput) => Promise<DeploymentUiTelemetryResult>;
  /** The Action settled: the Environment re-reads its revision and the tab says what applies next. */
  onSaved: (result: Extract<DeploymentUiTelemetryResult, { ok: true }>) => void;
}>;

const NO_MACHINES: readonly never[] = Object.freeze([]);
type Refusal = Exclude<
  Extract<DeploymentUiTelemetryResult, { ok: false }>['error'],
  'telemetry_deletion_confirmation_required'
>;

function refusalText(error: Refusal | null): string | null {
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
  const [collectorId, setCollectorId] = React.useState<string | null>(() => {
    if (environment.telemetryMachineId) return environment.telemetryMachineId;
    const proposed = resolveTelemetryCollectorSelectionV1({
      environment,
      targetLinks: detail.targetLinks.map((row) => ({
        targetLink: row.targetLink,
      })),
    });
    return proposed.kind === 'selected' ? proposed.machineId : null;
  });
  const saved = resolveDeploymentTelemetryCapabilitiesV1(
    detail.content.telemetry,
  );
  // A first setup starts from the lab's proposal (errors and model calls on, metrics at the next deploy off).
  const initial =
    setUp || detail.content.telemetry
      ? saved
      : { metrics: false, appLlmCost: true, exceptions: true };
  const [requests, setRequests] = React.useState(true);
  const [exceptions, setExceptions] = React.useState(initial.exceptions);
  const [appLlmCost, setAppLlmCost] = React.useState(initial.appLlmCost);
  const [metrics, setMetrics] = React.useState(initial.metrics);
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
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
  const canManage = environment.capabilities.manageBindings;
  const ready = !requests || collectorId !== null;
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setRefusal(null);
      setConfirmingDelete(false);
    };
  const save = async () => {
    if (saving || !ready || !canManage) return;
    setSaving(true);
    setRefusal(null);
    try {
      const result = await props.setTelemetry({
        collector: requests && collectorId ? { machineId: collectorId } : null,
        ...(requests
          ? { capabilities: { metrics, appLlmCost, exceptions } }
          : {}),
        ...(confirmingDelete ? { confirmDelete: true as const } : {}),
      });
      if (result.ok) {
        props.onClose();
        props.onSaved(result);
        return;
      }
      if (result.error === 'telemetry_deletion_confirmation_required')
        setConfirmingDelete(true);
      else setRefusal(result.error);
    } catch {
      setRefusal('deployment_unavailable');
    } finally {
      setSaving(false);
    }
  };
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
        onPress={() => {
          void save();
        }}
      />
    </ModalCardFooterActions>
  );
  React.useEffect(() => {
    props.setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => props.setChrome?.(null), [props.setChrome]);
  const refused = refusalText(refusal);
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
        </ItemGroup>
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
            subtitle={t('deploymentTelemetry.sheet.exceptionsDescription')}
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
            subtitle={t('deploymentTelemetry.sheet.llmDescription')}
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
            subtitle={t('deploymentTelemetry.sheet.metricsDescription')}
            disabled={saving || !canManage || !requests}
            rightElement={
              <Switch
                value={requests && metrics}
                onValueChange={change(setMetrics)}
                disabled={saving || !canManage || !requests}
              />
            }
          />
        </ItemGroup>
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
