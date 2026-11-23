import {
  WorkspaceSyncSourceRoutingV1Schema,
  type WorkspaceSyncSourceRoutingV1,
} from '@happier-dev/protocol/socketRpc';
import { isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { WorkspaceSyncSourceStandingAdmission } from '@/daemon/sessionEncryption/requesterSessionCustody';

/**
 * The one builder for the context a requester SOURCE presents to its TARGET.
 * Creation projects it from the live Home-admitted ingress. After a daemon
 * restart, recovery rebuilds it from the standing admission that creation
 * retained, with the existing Home grant check as its currentness at use.
 * The standing form carries only what creation signed: the same request,
 * SOURCE Machine, requester Account and TARGET folder.
 */
export function buildRequesterTargetPhaseContext(
  input:
    | Readonly<{
        kind: 'admitted';
        ingress: RpcHandlerContext;
        routing: WorkspaceSyncSourceRoutingV1;
      }>
    | Readonly<{
        kind: 'standing';
        admission: WorkspaceSyncSourceStandingAdmission;
        verifyMachineAdmissionCurrent: () => Promise<boolean>;
      }>,
): RpcHandlerContext {
  if (input.kind === 'admitted') {
    return {
      ...input.ingress,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse(
        input.routing,
      ),
    };
  }
  const { authorization, routing } = input.admission;
  const source = routing.sourceContext;
  if (!source)
    throw Object.assign(
      new Error('The admitted Sync source context is unavailable'),
      { code: 'project_requester_authority_unavailable' },
    );
  return {
    machineAdmission: source.machineAdmission,
    verifyMachineAdmissionCurrent: input.verifyMachineAdmissionCurrent,
    callerAuthority: source.callerAuthority,
    ...(source.sessionActionOrigin
      ? { sessionActionOrigin: source.sessionActionOrigin }
      : {}),
    ...(source.callerInputConstraints
      ? { callerInputConstraints: source.callerInputConstraints }
      : {}),
    callerInputAuthorization: authorization,
    ...(routing.originalActionEnvelope
      ? { originalActionEnvelope: routing.originalActionEnvelope }
      : {}),
    workspaceSyncSourceRouting: routing,
  };
}

/** What a relationship-write creation retains for its later TARGET calls; nothing for other Actions. */
export function projectRequesterStandingAdmission(
  context: RpcHandlerContext | undefined,
): WorkspaceSyncSourceStandingAdmission | undefined {
  const authorization = context?.callerInputAuthorization;
  const routing = context?.workspaceSyncSourceRouting;
  if (
    !authorization ||
    !routing?.sourceContext ||
    !isWorkspaceSyncRelationshipWriteActionId(authorization.binding.actionId)
  )
    return undefined;
  return {
    authorization: {
      v: 1,
      token: authorization.token,
      binding: authorization.binding,
    },
    routing,
  };
}
