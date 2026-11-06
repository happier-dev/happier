import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ConnectedAccountAttemptResponseSchema, ConnectedAccountDaemonCommandSchema, type ConnectedAccountAttemptResponse } from '../connect/connectedAccountDaemonRpcV1.js';
import { DaemonTerminalLaunchIntentSchema } from './terminal.js';
import { DaemonTerminalCloseResponseSchema } from './terminal.js';

export const AGENT_SIGN_IN_PREPARE_RPC_METHOD = 'daemon.agents.signIn.prepare';
export const AGENT_SIGN_IN_STATUS_RPC_METHOD = 'daemon.agents.signIn.status';

export const AgentSignInStatusRequestSchema = lazyZodSchema(() => z.strictObject({ agentId: z.string().check(z.trim(), z.minLength(1)) }));
export const AgentSignInPrepareRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSignInStatusRequestSchema, {
  method: z.optional(z.enum(['native', 'connected'])),
  serviceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  launchId: z.optional(z.enum(['primary', 'device_code'])),
})));
export const AgentSignInStatusResponseSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['signedIn', 'signedOut', 'unknown']),
  accountLabel: z.optional(z.nullable(z.string())),
  signInScope: z.optional(z.enum(['machineOwner', 'member', 'sharedAgent'])),
  checkedAt: z.number(),
  nativeLogin: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  connectedServices: z.array(z.strictObject({ serviceId: z.string(), title: z.string() })),
}));
export const AgentSignInPrepareResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ method: z.literal('native'), launch: DaemonTerminalLaunchIntentSchema }),
  z.strictObject({ method: z.literal('connected'), command: ConnectedAccountDaemonCommandSchema }),
  z.strictObject({ ok: z.literal(false), errorCode: z.enum(['agent_login_unsupported', 'connected_service_unsupported']), error: z.string() }),
]));
export const MachinesAgentsSignInStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(AgentSignInPrepareRequestSchema, { launchId: true }), { machineId: z.string().check(z.trim(), z.minLength(1)) })));
export const MachinesAgentsSignInStatusInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSignInStatusRequestSchema, { machineId: z.string().check(z.trim(), z.minLength(1)) })));
export const MachinesAgentsSignInCancelInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachinesAgentsSignInStatusInputSchema, { terminalId: z.string().check(z.minLength(1)) })));
export const MachinesAgentsSignInCancelOutputSchema = lazyZodSchema(() => z.union([
  DaemonTerminalCloseResponseSchema,
  z.strictObject({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
]));
export const MachinesAgentsSignInStartOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ terminalKey: z.string().check(z.minLength(1)), terminalId: z.string().check(z.minLength(1)) }),
  ConnectedAccountAttemptResponseSchema,
  z.strictObject({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
]));
export type AgentSignInPrepareRequest = z.output<typeof AgentSignInPrepareRequestSchema>;
export type AgentSignInPrepareResponse = z.output<typeof AgentSignInPrepareResponseSchema>;
export type AgentSignInStatusResponse = z.output<typeof AgentSignInStatusResponseSchema>;
export type MachinesAgentsSignInStartInput = z.output<typeof MachinesAgentsSignInStartInputSchema>;
export type MachinesAgentsSignInStatusInput = z.output<typeof MachinesAgentsSignInStatusInputSchema>;
export type MachinesAgentsSignInCancelInput = z.output<typeof MachinesAgentsSignInCancelInputSchema>;
export type MachinesAgentsSignInCancelOutput = z.output<typeof MachinesAgentsSignInCancelOutputSchema>;
// Retain the Connected Account owner's readonly response contract at this adapter seam.
export type MachinesAgentsSignInStartOutput =
  | Exclude<z.output<typeof MachinesAgentsSignInStartOutputSchema>, { status: string }>
  | ConnectedAccountAttemptResponse;

export function machineAgentSignInTerminalKey(machineId: string, agentId: string): string {
  return `provider-login:${machineId}:${agentId}`;
}
