import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ConnectedAccountAttemptResponseSchema, ConnectedAccountDaemonCommandSchema, type ConnectedAccountAttemptResponse } from '../connect/connectedAccountDaemonRpcV1.js';
import { DaemonTerminalLaunchIntentSchema } from './terminal.js';
import { DaemonTerminalCloseResponseSchema } from './terminal.js';

export const AGENT_SIGN_IN_PREPARE_RPC_METHOD = 'daemon.agents.signIn.prepare';
export const AGENT_SIGN_IN_STATUS_RPC_METHOD = 'daemon.agents.signIn.status';

export const AgentSignInStatusRequestSchema = lazyZodSchema(() => z.object({ agentId: z.string().trim().min(1) }).strict());
export const AgentSignInPrepareRequestSchema = lazyZodSchema(() => AgentSignInStatusRequestSchema.extend({
  method: z.enum(['native', 'connected']).optional(),
  serviceId: z.string().trim().min(1).optional(),
  launchId: z.enum(['primary', 'device_code']).optional(),
}).strict());
export const AgentSignInStatusResponseSchema = lazyZodSchema(() => z.object({
  status: z.enum(['signedIn', 'signedOut', 'unknown']),
  accountLabel: z.string().nullable(),
  checkedAt: z.number(),
  nativeLogin: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  connectedServices: z.array(z.object({ serviceId: z.string(), title: z.string() }).strict()),
}).strict());
export const AgentSignInPrepareResponseSchema = lazyZodSchema(() => z.union([
  z.object({ method: z.literal('native'), launch: DaemonTerminalLaunchIntentSchema }).strict(),
  z.object({ method: z.literal('connected'), command: ConnectedAccountDaemonCommandSchema }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['agent_login_unsupported', 'connected_service_unsupported']), error: z.string() }).strict(),
]));
export const MachinesAgentsSignInStartInputSchema = lazyZodSchema(() => AgentSignInPrepareRequestSchema.omit({ launchId: true }).extend({ machineId: z.string().trim().min(1) }).strict());
export const MachinesAgentsSignInStatusInputSchema = lazyZodSchema(() => AgentSignInStatusRequestSchema.extend({ machineId: z.string().trim().min(1) }).strict());
export const MachinesAgentsSignInCancelInputSchema = lazyZodSchema(() => MachinesAgentsSignInStatusInputSchema.extend({ terminalId: z.string().min(1) }).strict());
export const MachinesAgentsSignInCancelOutputSchema = lazyZodSchema(() => z.union([
  DaemonTerminalCloseResponseSchema,
  z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).strict(),
]));
export const MachinesAgentsSignInStartOutputSchema = lazyZodSchema(() => z.union([
  z.object({ terminalKey: z.string().min(1), terminalId: z.string().min(1) }).strict(),
  ConnectedAccountAttemptResponseSchema,
  z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).strict(),
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
