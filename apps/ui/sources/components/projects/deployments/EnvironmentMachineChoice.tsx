import * as React from 'react';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useDeviceType } from '@/utils/platform/responsive';
import type { MachinePresetItemV1, MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupCombinedPlanResultV1, MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { prepareMachineSetupSoftwareApplyInput, readMachineSetupSoftwareCurrentPlan } from '@/components/settings/machines/managed/machineSetupSoftware';
import { readMachineSetupRecipeInputState } from '@/components/settings/machines/managed/machineSetupRecipeInputs';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
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
 * selection (the protocol's `DOCKER_ENGINE_RECIPE_REF_V1`, which the recipes plugin declares), planned by the existing Machine setup Plan.
 */
export const DEPLOY_HOST_DOCKER_ITEM = { kind: 'softwareRecipe', selection: {
  ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: {},
} } as const satisfies MachinePresetItemV1;

export type DeployHostReadiness = 'ready' | 'needsSetup' | 'unknown';

/**
 * What the Plan says about this Machine's Docker recipe: `satisfied` passes its checks, `drifted` needs setup.
 * Anything else (unchecked, unsupported, a failed Plan) stays unknown, never ready.
 */
type HostPlan = MachineSetupPreparedApply | MachineSetupCombinedPlanResultV1;

function readDeployHostRecipe(result: HostPlan, machineId: string) {
  let plan: Pick<MachineSetupPlanResultV1, 'sources' | 'support'> | undefined;
  if ('ok' in result) {
    if (!result.ok) return undefined;
    const target = ('targets' in result.input ? result.input.targets : [result.input]).find(entry => entry.machineId === machineId);
    const facts = result.facts.find(entry => entry.machineId === machineId);
    if (target && facts) plan = { sources: target.sources, support: facts.support };
  } else {
    const target = result.targets.find(entry => entry.machineId === machineId);
    if (target && 'plan' in target) plan = target.plan;
  }
  if (!plan) return undefined;
  const { sources, support } = plan;
  return support.flatMap(row => {
    const source = sources[row.sourceIndex];
    const item = source?.setup.items?.[row.itemIndex];
    return item && item.kind !== 'app' && item.selection.ref.pluginId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.pluginId
      && item.selection.ref.recipeId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.recipeId ? [{ item, status: row.status }] : [];
  })[0];
}

export function readDeployHostReadiness(result: HostPlan, machineId: string): DeployHostReadiness {
  const status = readDeployHostRecipe(result, machineId)?.status;
  return status === 'satisfied' ? 'ready' : status === 'drifted' ? 'needsSetup' : 'unknown';
}

const frontDoor = createFrontDoorActionExecute();
const HOST_RECIPE_SECTIONS = Object.freeze(['familiesById.machineRecipes']);
type HostCurrentState = Readonly<{ lifetime: ServerAccountScopeLifetime; machineId: string;
  result: Awaited<ReturnType<typeof readMachineSetupSoftwareCurrentPlan>>; setup: MachineSetupV1 }>;

/**
 * Reads current readiness once per choice. Required recipe inputs settle inline before an explicit effects
 * review, through the same Software preparation Store uses; Apply retains that exact reviewed input.
 */
export function useDeployHostReadiness(lifetime: ServerAccountScopeLifetime | null, machineId: string | null) {
  const [state, setState] = React.useState<HostCurrentState | null>(null);
  const [reviewState, setReviewState] = React.useState<Readonly<{ current: HostCurrentState; pending: boolean;
    prepared: MachineSetupPreparedApply | null }> | null>(null);
  const reviewController = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    if (!lifetime || !machineId) return;
    const controller = new AbortController();
    const serverId = lifetime.scope.serverId;
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? serverId;
    const settle = (result: HostCurrentState['result']) => {
      if (!controller.signal.aborted && lifetime.isCurrent()) setState({ lifetime, machineId, result,
        setup: { items: [result.ok ? readDeployHostRecipe(result.plan, machineId)?.item ?? DEPLOY_HOST_DOCKER_ITEM : DEPLOY_HOST_DOCKER_ITEM] } });
    };
    readMachineSetupSoftwareCurrentPlan({ executeAction: frontDoor, context: { surface: 'ui', serverId,
      expectedAccountId: lifetime.scope.accountId, signal: controller.signal }, homeId, machineId,
    targets: [{ homeId, machineId }], selectedMachineId: machineId,
    isCurrent: () => !controller.signal.aborted && lifetime.isCurrent() })
      .then(settle, () => settle({ ok: false, errorCode: 'managed_request_failed', error: 'managed_request_failed' }));
    return () => { controller.abort(); reviewController.current?.abort(); };
  }, [lifetime, machineId]);
  const current = state?.machineId === machineId && state.lifetime === lifetime ? state : null;
  const currentReadiness = current?.result.ok ? readDeployHostReadiness(current.result.plan, current.machineId) : null;
  const editable = current?.result.ok === true && currentReadiness !== 'ready';
  const projection = usePluginUiProjectionCurrentness({ machineId, serverId: lifetime?.scope.serverId,
    enabled: editable, sections: HOST_RECIPE_SECTIONS });
  const inputs = React.useMemo(() => current ? readMachineSetupRecipeInputState(current.setup, projection.pluginUiProjection) : null,
    [current, projection.pluginUiProjection]);
  const activeReview = reviewState?.current === current ? reviewState : null;
  const prepared = activeReview?.prepared ?? (current?.result.ok === false ? current.result : null);
  const reviewing = activeReview?.pending === true;
  const canReview = editable && projection.interactionEnabled && inputs?.valid === true && !reviewing;
  const setSetup = (setup: MachineSetupV1) => {
    if (!current) return;
    reviewController.current?.abort();
    setReviewState(null);
    setState(previous => previous === current ? { ...current, setup } : previous);
  };
  const review = async () => {
    if (!current?.result.ok || !canReview) return;
    reviewController.current?.abort();
    const controller = new AbortController();
    reviewController.current = controller;
    setReviewState({ current, pending: true, prepared: null });
    const serverId = current.lifetime.scope.serverId;
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? serverId;
    const isCurrent = () => !controller.signal.aborted && current.lifetime.isCurrent();
    let next: MachineSetupPreparedApply;
    try {
      next = await prepareMachineSetupSoftwareApplyInput({ executeAction: frontDoor,
        context: { surface: 'ui', serverId, expectedAccountId: current.lifetime.scope.accountId, signal: controller.signal },
        homeId, machineId: current.machineId, targets: [{ homeId, machineId: current.machineId }], selectedMachineId: current.machineId,
        currentPlan: current.result.plan, setup: current.setup, isCurrent });
    } catch { next = { ok: false, errorCode: 'managed_request_failed', error: 'managed_request_failed' }; }
    if (isCurrent()) setReviewState({ current, pending: false, prepared: next });
  };
  return { prepared, readiness: prepared && machineId ? readDeployHostReadiness(prepared, machineId) : currentReadiness,
    setup: editable && current ? current.setup : null, inputProjection: editable ? projection.pluginUiProjection : null,
    setSetup, canReview, reviewing, review };
}
