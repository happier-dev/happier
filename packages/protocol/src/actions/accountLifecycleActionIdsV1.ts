
/** Action identity leaf: schema modules and the registry share these constants. */
export const ACCOUNT_DELETE_ACTION_ID_V1 = 'account.delete' as const;
export const HOME_ACCOUNTS_DELETE_ACTION_ID_V1 = 'home.accounts.delete' as const;
export const ACCOUNT_LIFECYCLE_ACTION_IDS = ['account.signOut', 'account.credentials.forgetAll', ACCOUNT_DELETE_ACTION_ID_V1] as const;
