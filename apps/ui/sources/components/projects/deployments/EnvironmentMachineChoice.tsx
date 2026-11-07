import * as React from 'react';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useDeviceType } from '@/utils/platform/responsive';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { prepareMachineSetupSoftwareApplyInput } from '@/components/settings/machines/managed/machineSetupSoftware';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * A Machine setting as a value and a menu of this Home's Machines (the link sheet's same select); choosing one is
 * the change. A Machine away right now stays choosable and says so.
 */
export function EnvironmentMachineChoice(
  props: Readonly<{
    testID: string;
    serverId: string;
    icon: React.ReactNode;
    title: string;
    currentMachineId: string | null;
    fallback: string;
    subtitle?: string;
    showDivider?: boolean;
    defaultChoice?: Readonly<{ title: string; onChoose: () => void }>;
    disabled: boolean;
    onChoose: (machineId: string) => void;
  }>,
) {
  const all = useMachineListForServer(props.serverId);
  const phone = useDeviceType() === 'phone';
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo((): DropdownMenuItem[] => {
    const machines = all ?? [];
    // A Machine still being read has no name to choose by; the current one keeps the page's name for it.
    const known = props.currentMachineId === null || machines.some((machine) => machine.id === props.currentMachineId);
    const missing: DropdownMenuItem[] = known ? [] : [{ id: props.currentMachineId!, title: props.fallback, checked: true }];
    return [...(props.defaultChoice ? [{ id: '', title: props.defaultChoice.title }] : []), ...missing, ...machines.flatMap((machine) => {
      const current = machine.id === props.currentMachineId;
      const name = getSettledMachineDisplayName(machine, machines) ?? (current ? props.fallback : null);
      return name ? [{
        id: machine.id,
        testID: `${props.testID}.${machine.id}`,
        title: name,
        subtitle: isMachineOnline(machine) ? undefined : t('projects.deployments.machineAway'),
        checked: current,
      }] : [];
    })];
  }, [all, props.currentMachineId, props.defaultChoice, props.fallback, props.testID]);
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={(next) => setOpen(next && !props.disabled)}
      items={items}
      selectedId={props.currentMachineId ?? (props.defaultChoice ? '' : null)}
      onSelect={(machineId) => {
        setOpen(false);
        if (props.disabled) return;
        if (machineId === '' && props.defaultChoice) { props.defaultChoice.onChoose(); return; }
        if (machineId !== props.currentMachineId) props.onChoose(machineId);
      }}
      itemTrigger={{
        title: props.title,
        subtitle: props.subtitle,
        icon: props.icon,
        showSelectedSubtitle: false,
        detailFormatter: (selected) => selected?.title ?? props.fallback,
        // A field select is wider than a short value: on a phone it always sits beneath its label.
        itemProps: { accessoryLayout: phone ? 'stacked' : 'adaptive', disabled: props.disabled, showDivider: props.showDivider },
      }}
    />
  );
}

/**
 * The Docker host software a Machine needs before it runs a Compose Environment: the bundled recipe's own
 * selection (`happier.machine.recipes` / `docker-engine`), planned by the existing Machine setup Plan.
 */
export const DEPLOY_HOST_DOCKER_ITEM = { kind: 'softwareRecipe', selection: {
  ref: { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' }, inputs: {},
} } as const satisfies MachinePresetItemV1;

export type DeployHostReadiness = 'ready' | 'needsSetup' | 'unknown';

/**
 * What the Plan says about this Machine's Docker recipe: `satisfied` passes its checks, `drifted` needs setup.
 * Anything else (unchecked, unsupported, a failed Plan) stays unknown, never ready.
 */
export function readDeployHostReadiness(prepared: MachineSetupPreparedApply, machineId: string): DeployHostReadiness {
  if (!prepared.ok) return 'unknown';
  const target = ('targets' in prepared.input ? prepared.input.targets : [prepared.input]).find((entry) => entry.machineId === machineId);
  const facts = prepared.facts.find((entry) => entry.machineId === machineId);
  if (!target || !facts) return 'unknown';
  const status = facts.support.find((row) => {
    const source = target.sources[row.sourceIndex];
    const item = source?.setup.items?.[row.itemIndex];
    return item?.kind === 'softwareRecipe' && item.selection.ref.pluginId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.pluginId
      && item.selection.ref.recipeId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.recipeId;
  })?.status;
  return status === 'satisfied' ? 'ready' : status === 'drifted' ? 'needsSetup' : 'unknown';
}

const frontDoor = createFrontDoorActionExecute();

/**
 * Plans the chosen Machine's Docker host setup once per choice (no polling), through the same Software
 * preparation Store and Machine setup use, so the review and its Apply input keep the Machine's other setup.
 */
export function useDeployHostReadiness(lifetime: ServerAccountScopeLifetime | null, machineId: string | null) {
  const [state, setState] = React.useState<Readonly<{ machineId: string; prepared: MachineSetupPreparedApply }> | null>(null);
  React.useEffect(() => {
    if (!lifetime || !machineId) return;
    const controller = new AbortController();
    const serverId = lifetime.scope.serverId;
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? serverId;
    const settle = (prepared: MachineSetupPreparedApply) => {
      if (!controller.signal.aborted && lifetime.isCurrent()) setState({ machineId, prepared });
    };
    prepareMachineSetupSoftwareApplyInput({ executeAction: frontDoor, context: { surface: 'ui', serverId,
      expectedAccountId: lifetime.scope.accountId, signal: controller.signal }, homeId, machineId,
    targets: [{ homeId, machineId }], selectedMachineId: machineId, setup: { items: [DEPLOY_HOST_DOCKER_ITEM] },
    isCurrent: () => !controller.signal.aborted && lifetime.isCurrent() })
      .then(settle, () => settle({ ok: false, errorCode: 'managed_request_failed', error: 'managed_request_failed' }));
    return () => controller.abort();
  }, [lifetime, machineId]);
  const prepared = machineId !== null && state?.machineId === machineId ? state.prepared : null;
  return { prepared, readiness: prepared && machineId ? readDeployHostReadiness(prepared, machineId) : null };
}
