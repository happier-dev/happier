import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  ConnectedAccountAuthenticationCommandSchemas as commands,
  ConnectedAccountAttemptResponseSchema,
  ConnectedAccountPendingAttemptsResponseSchema,
  ConnectedAccountRevokeResponseV1Schema,
} from './connectedAccountDaemonRpcV1.js';
import { ConnectedAccountServiceIdentityV1Schema } from './qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

const machine = { machineId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))) };
export const CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS = {
  'connectedServices.authentication.beginConnect': z.extend(z.omit(commands.beginConnect, { operation: true }), machine),
  'connectedServices.authentication.beginReconnect': z.extend(z.omit(commands.beginReconnect, { operation: true }), machine),
  'connectedServices.authentication.continueConnect': z.omit(commands.continueConnect, { operation: true }),
  'connectedServices.authentication.submitManual': z.omit(commands.submitManual, { operation: true }),
  'connectedServices.authentication.completeOAuth': z.omit(commands.completeOAuth, { operation: true }),
  'connectedServices.authentication.pollDevice': z.omit(commands.pollDevice, { operation: true }),
  'connectedServices.authentication.resumeDevice': z.omit(commands.resumeDevice, { operation: true }),
  'connectedServices.authentication.reconcile': z.omit(commands.reconcile, { operation: true }),
  'connectedServices.authentication.cancel': z.omit(commands.cancel, { operation: true }),
  'connectedServices.authentication.read': z.omit(commands.read, { operation: true }),
  'connectedServices.authentication.pending.list': z.strictObject({ ...machine, service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema) }),
} as const;
const pendingResponse = lazyZodSchema(() => z.union([
  ConnectedAccountPendingAttemptsResponseSchema,
  // Reuse the incumbent strict control refusal shapes.
  ConnectedAccountRevokeResponseV1Schema._zod.def.options[0],
  ConnectedAccountRevokeResponseV1Schema._zod.def.options[1],
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
