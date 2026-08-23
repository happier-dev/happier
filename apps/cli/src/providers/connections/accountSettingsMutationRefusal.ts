import { createProviderErrorV1 } from '@happier-dev/protocol';

import {
  requireAccountSettingsMutationSuccess,
  type AccountSettingsMutationResult,
  type AccountSettingsMutationSuccess,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

/**
 * Reads one Account-Settings CAS outcome for a Provider connection mutation.
 *
 * `outcomeUnknown` means the machine may have applied the change and Happier
 * could not confirm it. That is a named Provider refusal with its own recovery
 * action, so it is raised as the canonical `ProviderErrorV1` the connection
 * service already normalizes — never collapsed into an untyped transport
 * failure that would send a caller to retry a possibly-applied mutation.
 */
export function requireProviderConnectionAccountSettingsMutationSuccess(
  result: AccountSettingsMutationResult,
  context: Readonly<{ machineId: string; connectionId?: string }>,
): AccountSettingsMutationSuccess {
  if (result.status === 'outcomeUnknown') {
    throw createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
      machineId: context.machineId,
      ...(context.connectionId ? { connectionId: context.connectionId } : {}),
    });
  }
  return requireAccountSettingsMutationSuccess(result);
}
