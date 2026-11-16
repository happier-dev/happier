import { createHostReviewedChildPortV1, readHostAdmittedReviewedChildPlanV1, readHostAdmittedReviewedParentV1, retainManagedOpaquePresetCustodianAdmissionV1, type ActionExecutorContext,
  type ActionExecuteResult, type HostReviewedChildPortV1, type ManagedOpaquePresetCustodianAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareHostReviewedChildPolicyV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleApproval';
import { readMachineProvisionerActionRolesV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/**
 * Issues one locally opened preset role beneath the already admitted root
 * Action. The declaration and child policy stay in-process; only the normal
 * child Action invocation can observe the resulting private proof.
 */
export function createManagedOpaquePresetReviewedChildPortV1(params: Readonly<{
  parent: Readonly<{ actionId: string; input: unknown }>;
  context: ActionExecutorContext;
  /** Host-only admission retained from the exact opaque machine response. */
  custody?: ManagedOpaquePresetCustodianAdmissionV1;
  launch: ValidatedLaunchSnapshotV1;
  provisioner: MachineProvisionerContributionV1;
  localId: string;
  role: string;
  execute(input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>): HostReviewedChildPortV1 | null {
  const binding = readMachineProvisionerActionRolesV1(params.provisioner)
    .find(candidate => candidate.action === params.localId && candidate.role === params.role);
  if (!binding || !params.context.surface) return null;
  const action = { pluginId: params.launch.provider.pluginId, localId: params.localId };
  const child = { action, role: binding.role };
  // An admitted parent that listed this child already prepared and reviewed
  // it; consume that decision. Only a child the parent could not list before
  // the custodian opened it is decided here, by the canonical policy owner.
  const listed = readHostAdmittedReviewedChildPlanV1(params.context.hostReviewedChild, child);
  // A person-approved parent's internal steps inherit that approval (owner
  // ruling 2026-11-15): the policy owner then answers the child's own Require.
  const parentApproved = readHostAdmittedReviewedParentV1(params.context.hostReviewedChild)?.actionId === params.parent.actionId;
  const prepared = listed ? null : prepareHostReviewedChildPolicyV1(child, params.context, undefined, parentApproved);
  const decided = listed ? listed.policy
    : prepared && prepared.requiredActionIds.length === 0 ? { ...child, surface: params.context.surface } : null;
  const custodyAdmitted = params.custody === undefined
    || retainManagedOpaquePresetCustodianAdmissionV1({ ...child, surface: params.context.surface }, {
      parent: params.parent, context: params.context, admission: params.custody,
    }) !== null;
  if (!custodyAdmitted || !listed && !decided) {
    // A supplied opaque custody admission is mandatory. An unlisted opened
    // child has no later review that could hold the requester's Ask, so
    // explicit Require (or an unresolvable policy) refuses before any native
    // effect. Reuse the host issuer's typed refusal.
    return createHostReviewedChildPortV1({ actionId: params.parent.actionId, input: params.parent.input,
      context: params.context, reviewAdmitted: true,
      ...(custodyAdmitted && prepared ? { refusedPolicy: prepared } : {}) });
  }
  return createHostReviewedChildPortV1({ actionId: params.parent.actionId, input: params.parent.input,
    context: params.context, reviewAdmitted: true,
    // The listed child keeps the parent's exact prepared entry. Otherwise the
    // authenticated opened declaration admits only its exact selected role.
    plan: { children: [listed?.child ?? child] },
    ...(decided ? { policies: [decided] } : {}),
    execute: async (body, context) => {
      const input = body && typeof body === 'object' && !Array.isArray(body)
        && 'action' in body && 'input' in body ? (body as Readonly<{ input: unknown }>).input : body;
      return await params.execute(input, context);
    },
  });
}
