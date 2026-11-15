import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

export type ConfirmationContext = Pick<ActionExecutorContext, 'presentUserConfirmation' | 'externalActionExecutionAuthorization' | 'approvedActionReplay'>;

export function carriesNativeConfirmation(actionId: string, context?: ConfirmationContext): boolean {
  return Boolean(context?.externalActionExecutionAuthorization && context.presentUserConfirmation?.inputDigest
    && context.presentUserConfirmation.actionId === actionId);
}
