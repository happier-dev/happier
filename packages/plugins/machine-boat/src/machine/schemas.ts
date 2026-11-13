import * as mini from 'zod/mini';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const sandboxId = defineProtocolString({ pattern: '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$' });
const snapshotName = defineProtocolString({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' });
const size = defineProtocolUnion([
  defineProtocolLiteral('small'), defineProtocolLiteral('default'),
  defineProtocolLiteral('large'), defineProtocolLiteral('xlarge'),
]);

export const BoatLaunchV1Schema = defineProtocolObject({
  size,
  source: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('blank') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('named-snapshot'), name: snapshotName }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('fork'), sandboxId }, closed),
  ]),
}, closed);

export const BoatResourceV1Schema = defineProtocolObject({ sandboxId }, closed);
export const BoatAcquireOperationV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('acquire'),
  idempotencyKey: defineProtocolString({ minLength: 1, maxLength: 255 }),
  sandboxId: sandboxId.optional(),
}, closed);
export const BoatDeleteOperationV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('delete'),
  operationId: defineProtocolString({ pattern: '^bdop_[a-f0-9]{32}$' }),
  sandboxId,
}, closed);
export const BoatNativeOperationV1Schema = defineProtocolUnion([
  BoatAcquireOperationV1Schema,
  BoatDeleteOperationV1Schema,
]);

export type BoatLaunchV1 = ProtocolSchemaOutput<typeof BoatLaunchV1Schema>;
export type BoatResourceV1 = ProtocolSchemaOutput<typeof BoatResourceV1Schema>;
export type BoatAcquireOperationV1 = ProtocolSchemaOutput<typeof BoatAcquireOperationV1Schema>;
export type BoatDeleteOperationV1 = ProtocolSchemaOutput<typeof BoatDeleteOperationV1Schema>;
export type BoatNativeOperationV1 = ProtocolSchemaOutput<typeof BoatNativeOperationV1Schema>;

// Safe, actionable copy for documented account/setup refusals; never reflect a vendor message.
// https://docs.boat.dev/api-keys/scopes and https://docs.boat.dev/long-running-tasks/auto-stop
const setupMessages: Readonly<Record<string, string>> = {
  native_api_key_action_forbidden: 'This Boat API key is missing a required permission. Create a key with the permissions in the connect checklist.',
  native_api_key_sandbox_forbidden: 'This Boat API key cannot access this sandbox or its environment. Update the key scope or choose an authorized sandbox.',
  native_api_key_expired: 'This Boat API key has expired. Connect a new key.',
  native_trial_auto_stop_required: 'Boat trial accounts require a native auto-stop timer of at most two hours. Reconnect or retry with a supported Boat configuration.',
};
export function boatSetupMessage(code: string): string | undefined {
  return Object.hasOwn(setupMessages, code) ? setupMessages[code] : undefined;
}

export class BoatNativeError extends Error {
  constructor(readonly code: string, readonly nativeCause?: MachineProvisionerNativeCauseV1) {
    super(boatSetupMessage(code) ?? code);
    this.name = 'BoatNativeError';
  }
}

const admissionRefusalCodes: readonly string[] = [
  'native_request_failed', 'native_authorization_failed', 'native_rate_limited', 'native_not_found',
  'native_idempotency_mismatch', 'native_daily_limit_reached', 'native_limit_reached',
  'native_member_limit_reached', 'native_machine_class_plan_required',
  'native_trial_machine_class_not_allowed', 'native_trial_auto_stop_required',
];

export function isBoatAdmissionRefusalCode(code: string): boolean {
  return admissionRefusalCodes.includes(code) || boatSetupMessage(code) !== undefined;
}

export function parseBoatValue<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, code = 'native_response_invalid'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BoatNativeError(code);
  return parsed.data;
}

export const BoatPublicKeySchema = mini.string().check(mini.regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/));
