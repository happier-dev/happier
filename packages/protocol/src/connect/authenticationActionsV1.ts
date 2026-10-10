import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  ConnectedAccountAuthenticationCommandSchemas as commands,
  ConnectedAccountAttemptResponseSchema,
  ConnectedAccountPendingAttemptsResponseSchema,
  ConnectedAccountRevokeResponseV1Schema,
} from './connectedAccountDaemonRpcV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

const machine = { machineId: z.string().trim().min(1).max(256) };
export const CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS = {
  'connectedServices.authentication.beginConnect': commands.beginConnect.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.beginReconnect': commands.beginReconnect.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.continueConnect': commands.continueConnect.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.submitManual': commands.submitManual.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.completeOAuth': commands.completeOAuth.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.pollDevice': commands.pollDevice.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.resumeDevice': commands.resumeDevice.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.reconcile': commands.reconcile.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.cancel': commands.cancel.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.read': commands.read.omit({ operation: true }).extend(machine),
  'connectedServices.authentication.pending.list': z.object({ ...machine, service: asProtocolZod(PluginContributionIdentityV1Schema) }).strict(),
} as const;
const pendingResponse = lazyZodSchema(() => z.union([
  ConnectedAccountPendingAttemptsResponseSchema,
  // Reuse the incumbent strict control refusal shapes.
  ConnectedAccountRevokeResponseV1Schema.options[0],
  ConnectedAccountRevokeResponseV1Schema.options[1],
]));
export const CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_OUTPUT_SCHEMAS = {
  'connectedServices.authentication.beginConnect': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.beginReconnect': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.continueConnect': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.submitManual': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.completeOAuth': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.pollDevice': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.resumeDevice': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.reconcile': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.cancel': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.read': ConnectedAccountAttemptResponseSchema,
  'connectedServices.authentication.pending.list': pendingResponse,
} as const;

/** Provider diagnostics, authorization URLs and device codes stay on the live continuation. */
export function projectConnectedAccountAuthenticationObservation(value: unknown): unknown {
  const parsed = ConnectedAccountAttemptResponseSchema.safeParse(value);
  if (!parsed.success) return { redacted: true };
  const result = parsed.data;
  return { status: result.status,
    ...('attemptId' in result && result.attemptId ? { attemptId: result.attemptId } : {}),
    ...('code' in result ? { code: result.code } : {}),
    ...(result.status === 'connected' ? { account: result.account } : {}),
  };
}
