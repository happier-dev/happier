import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER = 'x-happier-action-execution-authorization';
export const EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER = 'x-happier-action-machine-signature';
/** The existing controller-signed child packet, never a second credential. */
export const EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER = 'x-happier-action-deployment-child';
/** Installation-signed facts about one admitted host child; never child content. */
export const EXTERNAL_ACTION_REVIEWED_CHILD_HEADER = 'x-happier-action-reviewed-child';
export const EXTERNAL_ACTION_EFFECT_ACTION_HEADER = 'x-happier-action-effect';
export const EXTERNAL_ACTION_RESOLVED_TARGET_HEADER = 'x-happier-action-target';
export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1 = '/v1/actions/:actionId/execution-authorization';
export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1 = '/v1/actions/:actionId/execution-authorization/verify';
export const MANAGED_POLICY_PROOF_HEADER = 'x-happier-managed-policy-proof';

/** HTTP framing only: signatures and admission still bind the original request body. */
export const EXTERNAL_ACTION_HTTP_BODY_HEADER_V1 = 'x-happier-action-body';
/** POST transport of a signed logical GET; the V1 proof frame is unchanged. */
export const EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 = 'get-v1';
const externalActionHttpAuthorizationHeaders = {
  executionAuthorization: EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  machineSignature: EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  effectActionId: EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  target: EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  deploymentChild: EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
  reviewedChild: EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
  // Installed-controller policy requests embed the original Action authorization, beyond header limits.
  managedPolicyProof: MANAGED_POLICY_PROOF_HEADER,
} as const;
export const EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1: readonly string[] = Object.values(externalActionHttpAuthorizationHeaders);
const ExternalActionHttpBodyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authorization: z.union([z.strictObject({
    executionAuthorization: z.string().check(z.minLength(1)),
    machineSignature: z.string().check(z.minLength(1)),
    effectActionId: z.string().check(z.minLength(1)),
    target: z.string().check(z.minLength(1)),
    deploymentChild: z.optional(z.string().check(z.minLength(1))),
    reviewedChild: z.optional(z.string().check(z.minLength(1))),
  }), z.strictObject({ managedPolicyProof: z.string().check(z.minLength(1)) })]),
  body: z.optional(z.unknown()),
}));

export type ExternalActionHttpBodyV1 = z.infer<typeof ExternalActionHttpBodyV1Schema>;

/** Signed requests carry potentially large root/child proofs in JSON, never in HTTP headers. */
export function encodeExternalActionHttpBodyV1(headers: Readonly<Record<string, unknown>>, body: unknown): ExternalActionHttpBodyV1 | null {
  const authorization = Object.fromEntries(Object.entries(externalActionHttpAuthorizationHeaders)
    .flatMap(([field, header]) => headers[header] === undefined ? [] : [[field, headers[header]]]));
  const frame = ExternalActionHttpBodyV1Schema.safeParse({ v: 1, authorization,
    ...(body === undefined ? {} : { body }) });
  return frame.success ? frame.data : null;
}

/** Restore only the closed proof vocabulary before route validation and authentication. */
export function decodeExternalActionHttpBodyV1(value: unknown): Readonly<{
  headers: Readonly<Record<string, string>>; body: unknown | undefined;
}> | null {
  const frame = ExternalActionHttpBodyV1Schema.safeParse(value);
  if (!frame.success) return null;
  const headers: Record<string, string> = {};
  for (const [field, header] of Object.entries(externalActionHttpAuthorizationHeaders)) {
    const proof: unknown = Reflect.get(frame.data.authorization, field);
    if (typeof proof === 'string') headers[header] = proof;
  }
  return { headers, body: frame.data.body };
}
