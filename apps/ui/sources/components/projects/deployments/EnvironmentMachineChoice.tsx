import * as React from 'react';
import type { MachinePresetItemV1, MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupCombinedPlanResultV1, MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { prepareMachineSetupSoftwareApplyInput, readMachineSetupSoftwareCurrentPlan } from '@/components/settings/machines/managed/machineSetupSoftware';
import { readMachineSetupRecipeInputState } from '@/components/settings/machines/managed/machineSetupRecipeInputsModel';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

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
  const activeReview = reviewState?.current === current ? reviewState : null;
  const prepared = activeReview?.prepared ?? (current?.result.ok === false ? current.result : null);
  const readiness = prepared && machineId ? readDeployHostReadiness(prepared, machineId) : currentReadiness;
  const editable = current?.result.ok === true && readiness !== 'ready';
  const projection = usePluginUiProjectionCurrentness({ machineId, serverId: lifetime?.scope.serverId,
    enabled: editable, sections: HOST_RECIPE_SECTIONS });
  const inputs = React.useMemo(() => current ? readMachineSetupRecipeInputState(current.setup, projection.pluginUiProjection) : null,
    [current, projection.pluginUiProjection]);
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
  return { prepared, readiness,
    setup: editable && current ? current.setup : null, inputProjection: editable ? projection.pluginUiProjection : null,
    setSetup, canReview, reviewing, review };
}
