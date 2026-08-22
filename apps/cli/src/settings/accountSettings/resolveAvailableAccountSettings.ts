import type { AccountSettings } from '@happier-dev/protocol'

import type { StoredCredentials } from '@/persistence'
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot'
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext'
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey'

export async function resolveAvailableAccountSettings(params: Readonly<{
  credentials?: StoredCredentials | null;
}>): Promise<AccountSettings | null> {
  const credentials = params.credentials ?? null
  const active = getActiveAccountSettingsSnapshot()
  if (!credentials) return active?.settings ?? null
  if (active?.scopeKey === resolveAccountSettingsScopeKey(credentials)) return active.settings

  try {
    const ctx = await bootstrapAccountSettingsContext({
      credentials,
      mode: 'fast',
      refresh: 'auto',
    })
    return ctx.settings
  } catch {
    return null
  }
}
