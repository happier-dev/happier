import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CoordinationMessageRefV1Schema } from '../discussions/messageRefs.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { SessionMessageAccountActorV1Schema, deriveSessionMessageAuthorAccountIdV1 } from '../sessions/messages/sessionMessageAccountActorV1.js';
import { SessionInputAdmissionReceiptV1Schema, SessionInputAuthoritySchema } from '../sessions/messages/sessionInputAdmission.js';
import type { ExternalActionExecutionAuthorizationBindingV1 } from './externalActionApi.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { ActionId } from './actionIds.js';
import { isHomeAdmittedPresentUserHostInvocation, isPresentUserHostInvocation, readInitiatingActionCallerV1 } from './invocationAuthority.js';

/** Authenticated requester identity is independent of terminal consent authority. */
export function readAuthenticatedActionRequesterAccountIdV1(binding: ExternalActionExecutionAuthorizationBindingV1): string | null {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    ? binding.accountId : null;
}

/** Qualified authenticated person, independent of the eventual executing persona. */
export const ActionRequestRequesterV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: SessionMessageRefV1Schema.shape.session.shape.serverId,
  accountId: SessionMessageAccountActorV1Schema.shape.accountId,
}));

/** Private historical actor references; display names remain with their existing content owners. */
export const ActionActorV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ actorKind: z.literal('person'), accountId: ActionRequestRequesterV1Schema.shape.accountId }),
  z.strictObject({ actorKind: z.literal('agent'), sessionId: SessionMessageRefV1Schema.shape.session.shape.sessionId,
    onBehalfOf: z.optional(ActionRequestRequesterV1Schema) }),
  z.strictObject({ actorKind: z.literal('workflow'), runId: z.string().check(z.minLength(1)),
    automationId: z.optional(z.string().check(z.minLength(1))), onBehalfOf: z.optional(ActionRequestRequesterV1Schema) }),
]));
export type ActionActorV1 = Readonly<z.infer<typeof ActionActorV1Schema>>;

/** Capture only host-authenticated provenance at the operation/effect owner's admission boundary. */
export function deriveActionActorV1(context: ActionExecutorContext, actionId: ActionId,
  witnessedApproval?: Readonly<Pick<NonNullable<ActionExecutorContext['presentUserApproval']>, 'decidingAccountId'>>): ActionActorV1 | undefined {
  const approval = witnessedApproval ?? context.presentUserApproval;
  if (approval) {
    const approver = approval.decidingAccountId;
    return approver ? { actorKind: 'person', accountId: approver } : undefined;
  }
  const original = context.approvedActionReplay?.origin;
  const caller = readInitiatingActionCallerV1(original?.caller ?? context.actionCaller);
  const requester = context.actionRequestAttributionV1 ? context.actionRequestAttributionV1.requester
    : caller?.kind === 'workflowRun' ? caller.authenticatedStarterV1?.requester : undefined;
  const onBehalfOf = requester ? { onBehalfOf: { ...requester } } : {};
  if (caller?.kind === 'session') return { actorKind: 'agent', sessionId: caller.sessionId, ...onBehalfOf };
  if (caller?.kind === 'workflowRun') return { actorKind: 'workflow', runId: caller.runId, ...onBehalfOf };
  if (caller?.kind === 'automationRun') return { actorKind: 'workflow', runId: caller.runId,
    automationId: caller.automationId, ...onBehalfOf };
  if (!caller || caller.kind === 'host') {
    const confirmation = context.presentUserConfirmation?.actionId === actionId ? context.presentUserConfirmation.accountId : undefined;
    const binding = context.externalActionExecutionAuthorization?.binding;
    const accountId = confirmation ?? (isHomeAdmittedPresentUserHostInvocation(context, actionId) && binding
      ? readAuthenticatedActionRequesterAccountIdV1(binding)
      : isPresentUserHostInvocation(context) ? context.runtimeAccountId : undefined);
    if (accountId) return { actorKind: 'person', accountId };
  }
  return undefined;
}

/** Content-free host projection of one admitted cause. Never execution or approval authority. */
export const ActionRequestAttributionV1Schema = lazyZodSchema(() => z.strictObject({
  requestRef: z.string().check(z.minLength(1)),
  requester: z.nullable(ActionRequestRequesterV1Schema),
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
