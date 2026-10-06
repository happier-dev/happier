import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DELEGATION_SETTING_DECLARATIONS_V1, readAccountSettingDeclarationV1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { SettingsDeclarationActionInputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { ActionExecutorDeps, SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';

import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

/** Account declarations reuse the incumbent Settings read/CAS owner; device settings never write here. */
export function createCliSettingsDeclarationAction(params: Readonly<{
  credentials?: StoredCredentials;
  serverHttpBaseUrl?: string;
}>): NonNullable<ActionExecutorDeps['settingsDeclarationAction']> {
  const execute: NonNullable<ActionExecutorDeps['settingsDeclarationAction']> = async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    if (actionId === 'settings.list') {
      const { pageId } = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
      const items: SettingsDeclarationDescriptorV1[] = Object.values(DELEGATION_SETTING_DECLARATIONS_V1)
        .filter(declaration => !pageId || declaration.pageId === pageId)
        .map(declaration => ({ anchor: declaration.anchor, pageId: declaration.pageId,
          title: ACCOUNT_SETTING_DEFINITIONS[declaration.storage.key].description,
          storageScope: declaration.storage.scope, readable: true, writable: true, sensitive: false }));
      return { items };
    }
    const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
    const declaration = readAccountSettingDeclarationV1(parsed.anchor);
    if (!declaration || actionId === 'settings.invoke') return clientActionUnavailable(actionId);
    if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    const key = declaration.storage.key;
    if (actionId === 'settings.set') {
      const requested = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
      const value = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(requested.value);
      if (!value.success) return { ok: false, errorCode: 'invalid_setting_value', error: 'invalid_setting_value' };
      const result = await updateAccountSettingsV2WithRetry({ credentials: params.credentials,
        mutation: AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key, value: value.data }] }), signal: context.signal });
      if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') {
        return { ok: false, errorCode: `account_settings_${result.status}`, error: `account_settings_${result.status}`, details: result };
      }
      return { anchor: declaration.anchor, value: value.data };
    }
    const current = await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking', refresh: 'force' });
    context.signal?.throwIfAborted();
    if (current.source === 'none' || !current.rawSettings) return { ok: false, errorCode: 'account_settings_content_unavailable', error: 'account_settings_content_unavailable' };
    return { anchor: declaration.anchor, value: accountSettingsParse(current.rawSettings)[key] };
  };
  return args => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute(args)) : execute(args);
}
