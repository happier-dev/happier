import type { ActionRequiredAuthority, ActionSurfaces } from './metadata.js';
import { ACTION_INVOKE_ACTION_ID_V1, type ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './executor/types.js';

export const AUTHORITY_CEILING_HEADER_V1 =
  'x-happier-authority-ceiling' as const;

/** A trusted present-person host invocation, never external or Session-supplied authority. */
export function isPresentUserHostInvocation(
  ctx: ActionExecutorContext,
): boolean {
  return (
    (ctx.surface === 'ui' ||
      ctx.surface === 'cli' ||
      ctx.surface === 'voice') &&
    (ctx.authority ?? 'account_automation') === 'present_user' &&
    (!ctx.actionCaller || ctx.actionCaller.kind === 'host') &&
    !ctx.externalActionCredential &&
    !ctx.externalActionExecutionAuthorization &&
    !ctx.rpcSessionAuthorization
  );
}

/**
 * The present person's own Account app press for exactly this Action, admitted
 * once by Home and relayed to its executor. Session, Workflow, terminal and
 * public-API origins never qualify; the binding is read, not re-decided.
 */
export function isHomeAdmittedPresentUserHostInvocation(
  ctx: ActionExecutorContext,
  actionId: ActionId,
): boolean {
  const binding = ctx.externalActionExecutionAuthorization?.binding;
  return (
    !!binding &&
    'authentication' in binding &&
    binding.authentication.kind === 'account' &&
    binding.actionId === actionId &&
    !binding.sessionActionOrigin &&
    !binding.sessionActionSource &&
    !binding.workflowActionOrigin &&
    isPresentUserHostInvocation({
      ...ctx,
      externalActionExecutionAuthorization: undefined,
    })
  );
}

/** The sole producer of invocation authority from verified credential provenance. */
export function resolveInvocationAuthority(
  input: Readonly<{
    credential:
      | 'account'
      | 'terminal'
      | 'api_token'
      | 'plugin'
      | 'agent'
      | 'none';
    surface: keyof ActionSurfaces;
    /** Trusted host proof of a current built-in device-local UI mutation, never caller input. */
    localUiInteraction?: boolean;
    /** The Account host's current Voice preference, never Action input or a caller claim. */
    voiceCanApproveRequests?: boolean;
    actionId?: ActionId;
  }>,
): ActionRequiredAuthority {
  if (
    input.credential === 'account' &&
    (input.surface === 'ui' || input.surface === 'rpc')
  )
    return 'present_user';
  // The enabled Account Voice host represents the person's live request.
  // Confirmation and read-back still belong to the host's designed in-flow adapter.
  if (
    input.credential === 'account' &&
    input.surface === 'voice' &&
    input.voiceCanApproveRequests === true
  )
    return 'present_user';
  if (
    input.credential === 'none' &&
    input.surface === 'ui' &&
    input.localUiInteraction === true
  )
    return 'present_user';
  // A terminal (CLI login credential) is the person's own tool. Agent- or
  // plugin-originated calls carry an explicit per-invocation ceiling instead.
  if (
    input.credential === 'terminal' &&
    (input.surface === 'cli' || input.surface === 'rpc')
  )
    return 'present_user';
  return 'account_automation';
}

/** Private consent for one Plugin Account relay never raises the caller's authority. */
export function isPluginActionInvokeConfirmationV1(context: Pick<ActionExecutorContext,
  'surface' | 'authority' | 'actionCaller' | 'presentUserConfirmation'>): boolean {
  return context.actionCaller?.kind === 'plugin' && context.authority === 'account_automation'
    && (context.surface === 'ui' || context.surface === 'voice' || context.surface === 'plugin')
    && context.presentUserConfirmation?.actionId === ACTION_INVOKE_ACTION_ID_V1;
}
