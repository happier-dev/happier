import type { AccountSettings } from '@happier-dev/protocol'

import type { Credentials } from '@/persistence'
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot'
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext'

export async function resolveAvailableAccountSettings(params: Readonly<{
  credentials?: Credentials | null;
}>): Promise<AccountSettings | null> {
  const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null
  if (activeSettings) return activeSettings

  const credentials = params.credentials ?? null
  if (!credentials) return null

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
