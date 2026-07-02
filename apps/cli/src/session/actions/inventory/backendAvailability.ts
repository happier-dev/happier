import type { AccountSettings } from '@happier-dev/protocol';

export function isBackendEnabled(
  accountSettings: AccountSettings | null,
  targetKeys: readonly string[],
): boolean {
  const enabledByTargetKey = accountSettings?.backendEnabledByTargetKey;
  if (!enabledByTargetKey) return true;
  for (const targetKey of targetKeys) {
    if (enabledByTargetKey[targetKey] === false) return false;
    if (enabledByTargetKey[targetKey] === true) return true;
  }
  return true;
}
