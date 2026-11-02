import type { ExternalActionExecutionAuthorizationBindingV1 } from './externalActionApi.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CoordinationMessageRefV1Schema } from '../discussions/messageRefs.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { SessionMessageAccountActorV1Schema, deriveSessionMessageAuthorAccountIdV1 } from '../sessions/messages/sessionMessageAccountActorV1.js';
import { SessionInputAdmissionReceiptV1Schema, SessionInputAuthoritySchema } from '../sessions/messages/sessionInputAdmission.js';

/** Content-free host projection of one admitted cause. Never execution or approval authority. */
export const ActionRequestAttributionV1Schema = lazyZodSchema(() => z.strictObject({
  requestRef: z.string().check(z.minLength(1)),
  requester: z.nullable(z.strictObject({
    serverId: SessionMessageRefV1Schema.shape.session.shape.serverId,
    accountId: SessionMessageAccountActorV1Schema.shape.accountId,
  })),
  persona: SessionMessageRefV1Schema.shape.session,
  origin: z.nullable(CoordinationMessageRefV1Schema),
}));
export type ActionRequestAttributionV1 = Readonly<z.infer<typeof ActionRequestAttributionV1Schema>>;

/** Host attribution identifies the cause, not authority. Unknown people never become the Bot owner. */
export function isSharedRequesterActionV1(context: Readonly<{
  actionRequestAttributionV1?: ActionRequestAttributionV1; runtimeAccountId?: string;
}>): boolean {
  const cause = context.actionRequestAttributionV1;
  return Boolean(cause && context.runtimeAccountId
    && (!cause.requester || cause.requester.accountId !== context.runtimeAccountId));
}

/** Copy at a custody boundary so later queued inputs cannot rewrite an earlier cause. */
export function materializeActionRequestAttributionV1(value: unknown): ActionRequestAttributionV1 {
  const result = ActionRequestAttributionV1Schema.parse(value);
  if (result.requester) Object.freeze(result.requester);
  Object.freeze(result.persona);
  if (result.origin) {
    Object.freeze(result.origin.kind === 'session' ? result.origin.session : result.origin.discussion);
    Object.freeze(result.origin);
  }
  return Object.freeze(result);
}

/** Only call with the authenticated transport receipt, never authored message metadata. */
export function deriveSessionInputActionRequestAttributionV1(params: Readonly<{
  requestRef: string | null;
  /** Absent on a legacy Home which cannot qualify a newly derived cause. */
  persona: ActionRequestAttributionV1['persona'] | null;
  messageRole: unknown;
  inputAdmissionReceipt: unknown;
  /** Only settled protected custody; authored top-level projection claims are ignored. */
  inputAuthority?: unknown;
  origin: ActionRequestAttributionV1['origin'];
}>): ActionRequestAttributionV1 | undefined {
  const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(params.inputAdmissionReceipt);
  if (!params.requestRef || !receipt.success) return undefined;
  if (receipt.data.issuer === 'authenticatedMachine' && params.messageRole === 'user') {
    const authority = SessionInputAuthoritySchema.safeParse(params.inputAuthority);
    if (authority.success && authority.data.actionRequestAttributionV1) {
      return materializeActionRequestAttributionV1(authority.data.actionRequestAttributionV1);
    }
  }
  if (!params.persona) return undefined;
  const accountId = deriveSessionMessageAuthorAccountIdV1(params);
  return materializeActionRequestAttributionV1({
    requestRef: params.requestRef,
    requester: accountId ? { serverId: params.persona.serverId, accountId } : null,
    persona: params.persona,
    origin: params.origin,
  });
}

export function readAuthenticatedActionRequesterAccountIdV1(binding: ExternalActionExecutionAuthorizationBindingV1): string | null {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    ? binding.accountId : null;
}
