import { createHostReviewedChildPortV1, retainManagedOpaquePresetCustodianAdmissionV1, type ActionExecutorContext,
  type ActionExecuteResult, type HostReviewedChildPortV1, type ManagedOpaquePresetCustodianAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
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
  const policy = params.custody === undefined ? { action, role: binding.role, surface: params.context.surface }
    : retainManagedOpaquePresetCustodianAdmissionV1({ action, role: binding.role, surface: params.context.surface }, {
      parent: params.parent, context: params.context, admission: params.custody,
    });
  if (policy === null) {
    // A supplied opaque custody admission is mandatory. Reuse the host
    // issuer's typed refusal rather than falling through to requester policy.
    return createHostReviewedChildPortV1({ actionId: params.parent.actionId, input: params.parent.input,
      context: params.context, reviewAdmitted: true });
  }
  return createHostReviewedChildPortV1({ actionId: params.parent.actionId, input: params.parent.input,
    context: params.context, reviewAdmitted: true,
    plan: { children: [{ action, role: binding.role }] },
    // The parent Action cannot list an encrypted declaration child until the
    // custodian opens it. This authenticated declaration admits only its
    // exact selected role, under the already-admitted parent.
    policies: [policy],
    execute: async (body, context) => {
      const input = body && typeof body === 'object' && !Array.isArray(body)
        && 'action' in body && 'input' in body ? (body as Readonly<{ input: unknown }>).input : body;
      return await params.execute(input, context);
    },
  });
}
