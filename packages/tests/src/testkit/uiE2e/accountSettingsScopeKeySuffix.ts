export type UiE2eAccountSettingsScope = Readonly<{
  serverId: string;
  accountId: string;
}>;

function encodeScopePart(value: string): string {
  return `${value.length}:${value}`;
}

// Keep this aligned with apps/ui/sources/sync/domains/scope/serverAccountScope.ts.
export function accountSettingsScopeKeySuffix(scope: UiE2eAccountSettingsScope): string {
  return `${encodeScopePart(scope.serverId)}${encodeScopePart(scope.accountId)}`;
}
