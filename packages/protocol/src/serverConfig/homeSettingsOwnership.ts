/** Registry keys whose Home-side values belong to the governance policy document. */
export const HOME_AUTH_METHOD_ENABLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
    key_challenge: 'HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED',
    email_password: 'HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED',
    mtls: 'HAPPIER_FEATURE_AUTH_MTLS__ENABLED',
});
export const HOME_ANONYMOUS_SIGNUP_KEY = 'AUTH_ANONYMOUS_SIGNUP_ENABLED';
export const HOME_STORAGE_POLICY_KEY = 'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY';
export const HOME_KEYLESS_ACCOUNTS_KEY = 'HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED';

const governanceKeys: ReadonlySet<string> = new Set([
    ...Object.values(HOME_AUTH_METHOD_ENABLE_KEYS),
    HOME_ANONYMOUS_SIGNUP_KEY, HOME_STORAGE_POLICY_KEY, HOME_KEYLESS_ACCOUNTS_KEY,
]);

export function isHomeGovernanceSettingKey(key: string): boolean {
    return governanceKeys.has(key);
}

/** AM-12: these registry groups are rehosted on Sign-in providers, with the same settings writer. */
export function isHomeSignInPlatformSetting(entry: Readonly<{ group?: string }>): boolean {
    return entry.group === 'workos' || entry.group === 'github' || entry.group === 'oauth';
}
