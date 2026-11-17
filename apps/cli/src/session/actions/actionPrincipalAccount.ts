import type { ActionExecutorContext } from '@happier-dev/protocol';

/** The Account an executing Action acts for: its admitted binding, else its runtime Account. */
export function readActionPrincipalAccountId(context: Pick<ActionExecutorContext,
  'externalActionExecutionAuthorization' | 'runtimeAccountId'> | undefined): string | undefined {
  return context?.externalActionExecutionAuthorization?.binding.accountId ?? context?.runtimeAccountId ?? undefined;
}
