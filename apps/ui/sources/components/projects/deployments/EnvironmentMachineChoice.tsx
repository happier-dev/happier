import * as React from 'react';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { prepareMachineSetupSoftwareApplyInput, readMachineSetupSoftwareCurrentPlan } from '@/components/settings/machines/managed/machineSetupSoftware';
import { readMachineSetupRecipeInputState } from '@/components/settings/machines/managed/machineSetupRecipeInputsModel';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { buildDeployHostCheckTargetV1, DEPLOY_HOST_DOCKER_ITEM, readDeployHostRecipe, readDeployHostReadiness, type DeployHostReadiness } from '@happier-dev/protocol/deployments/deployHostReadiness';

import { readDeploymentActionError } from './deploymentActionOutcome';

function readHostReadinessFailure(error: unknown) {
  const outcome = readDeploymentActionError(error);
  const code = outcome.kind === 'refused' && outcome.code !== 'unknown_error' ? outcome.code : 'managed_request_failed';
  return outcome.kind === 'refused' && outcome.failure ? outcome.failure : { ok: false as const, errorCode: code, error: code };
}

const frontDoor = createFrontDoorActionExecute();
const HOST_RECIPE_SECTIONS = Object.freeze(['familiesById.machineRecipes']);
type HostCurrentState = Readonly<{ lifetime: ServerAccountScopeLifetime; machineId: string;
  result: Awaited<ReturnType<typeof readMachineSetupSoftwareCurrentPlan>>; readiness: DeployHostReadiness;
  setup: MachineSetupV1 }>;

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
    const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent();
    const target = { homeId, machineId };
    const readPlan = async (planTarget: Parameters<typeof readMachineSetupSoftwareCurrentPlan>[0]['targets'][number]) => {
      const plan = await readMachineSetupSoftwareCurrentPlan({ executeAction: frontDoor,
        context: { surface: 'ui', serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal },
        ...target, targets: [planTarget], selectedMachineId: machineId, isCurrent });
      if (!plan.ok) return plan;
      const row = plan.plan.targets.find(row => row.homeId === homeId && row.machineId === machineId);
      if (!row) return { ok: false as const, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
      return 'status' in row
        ? { ok: false as const, errorCode: row.errorCode, error: row.errorCode, details: { reason: row.reason } }
        : plan;
    };
    const settle = (result: HostCurrentState['result'], readiness: DeployHostReadiness = 'unknown') => {
      if (!isCurrent()) return;
      setState({ lifetime, machineId, result, readiness,
        setup: { items: [result.ok ? readDeployHostRecipe(result.plan, machineId)?.item ?? DEPLOY_HOST_DOCKER_ITEM : DEPLOY_HOST_DOCKER_ITEM] } });
    };
    async function observe() {
      const current = await readPlan(target);
      const checkTarget = current.ok && buildDeployHostCheckTargetV1(current.plan, target);
      const observed = checkTarget ? await readPlan(checkTarget) : current;
      if (!observed.ok) settle(observed);
      else settle(current, readDeployHostReadiness(observed.plan, machineId));
    }
    void observe().catch(error => settle(readHostReadinessFailure(error)));
    return () => { controller.abort(); reviewController.current?.abort(); };
  }, [lifetime, machineId]);
  const current = state?.machineId === machineId && state.lifetime === lifetime ? state : null;
  const currentReadiness = current?.readiness ?? null;
  const activeReview = reviewState?.current === current ? reviewState : null;
  const prepared = activeReview?.prepared ?? (current?.result.ok === false ? current.result : null);
  const readiness = prepared && machineId ? readDeployHostReadiness(prepared, machineId) : currentReadiness;
  const editable = current?.result.ok === true && currentReadiness === 'needsSetup' && readiness !== 'ready';
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
    } catch (error) { next = readHostReadinessFailure(error); }
    if (isCurrent()) setReviewState({ current, pending: false, prepared: next });
  };
  return { prepared, readiness,
    setup: editable && current ? current.setup : null, inputProjection: editable ? projection.pluginUiProjection : null,
    setSetup, canReview, reviewing, review };
}
