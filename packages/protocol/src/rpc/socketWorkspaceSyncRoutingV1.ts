import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ActionRequiredAuthoritySchema } from '../actions/metadata.js';
import { CallerInputConstraintsV1Schema } from '../auth/callerInputConstraintsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { AgentPermissionIntentV1Schema } from '../runtime/permissionIntentV1.js';
import { SessionInputCausalPermissionAuthorityV1Schema } from '../sessions/messages/sessionInputCausalPermissionAuthorityV1.js';
import { ActionRequestAttributionV1Schema } from '../actions/actionRequestAttributionSchemaV1.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machines/machineAccessV1.js';

export const SessionActionRpcOriginV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  caller: AgentStartSessionCallerV1Schema,
  sourceTurnId: z.string().check(z.trim(), z.minLength(1)),
  sourceInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  callerPermissionMode: zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema)),
  causalPermissionAuthority: zMini.optional(zMini.nullable(SessionInputCausalPermissionAuthorityV1Schema)),
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  /** The source Session host's Agent-start admission, decided once with the requester's policy before Home signed this origin. */
  agentStartAdmission: z.optional(z.strictObject({
    workDepth: z.number().check(z.int(), z.nonnegative()),
    workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  })),
  requestId: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionActionRpcOriginV1 = Readonly<z.infer<typeof SessionActionRpcOriginV1Schema>>;

/** Exact private source workspace phase routing; the Home verifies the child socket before forwarding. */
export const WorkspaceSyncSourceContextV1Schema = lazyZodSchema(() => z.strictObject({
  machineAdmission: SocketRpcMachineAdmissionContextV1Schema,
  callerAuthority: ActionRequiredAuthoritySchema,
  sessionActionOrigin: z.optional(SessionActionRpcOriginV1Schema),
  callerInputConstraints: zMini.optional(CallerInputConstraintsV1Schema),
  callerPermissionMode: zMini.optional(zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  causalPermissionAuthority: zMini.optional(zMini.nullable(SessionInputCausalPermissionAuthorityV1Schema)),
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
}));
export type WorkspaceSyncSourceContextV1 = Readonly<z.infer<typeof WorkspaceSyncSourceContextV1Schema>>;
/** Target custody has its own phase binding; the moved Session need not live on this child. */
export const WorkspaceSyncTargetRoutingV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  phase: z.enum(['preflight', 'prepare', 'release', 'inspect', 'dependencies', 'remove']),
  operationId: z.string().check(z.trim(), z.minLength(1)),
  accountServerId: z.string().check(z.trim(), z.minLength(1)),
  targetMachineId: z.string().check(z.trim(), z.minLength(1)),
  targetRootPath: z.string().check(z.trim(), z.minLength(1)),
  targetContext: WorkspaceSyncSourceContextV1Schema,
}));
export type WorkspaceSyncTargetRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncTargetRoutingV1Schema>>;
