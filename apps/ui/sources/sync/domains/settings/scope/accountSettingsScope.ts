import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '../../scope/serverAccountScope';

export type AccountSettingsScope = ServerAccountScope;

export const createAccountSettingsScope = createServerAccountScope;

export function areAccountSettingsScopesEqual(
    a: AccountSettingsScope | null | undefined,
    b: AccountSettingsScope | null | undefined,
): boolean {
    return areServerAccountScopesEqual(a, b);
}

export function accountSettingsScopeKeySuffix(scope: AccountSettingsScope): string {
    return serverAccountScopeKeySuffix(scope);
}
