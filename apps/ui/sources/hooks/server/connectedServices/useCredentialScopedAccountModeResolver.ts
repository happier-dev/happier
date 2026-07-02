import * as React from 'react';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

export type CredentialScopedAccountMode = 'plain' | 'e2ee';

type ScopedAccountMode = Readonly<{
    credentialScope: string;
    mode: CredentialScopedAccountMode;
}>;

type ScopedAccountModePromise = Readonly<{
    credentialScope: string;
    promise: Promise<CredentialScopedAccountMode>;
}>;

export function useCredentialScopedAccountModeResolver(params: Readonly<{
    credentials: AuthCredentials | null | undefined;
    credentialScope: string;
}>): () => Promise<CredentialScopedAccountMode> {
    const { credentials, credentialScope } = params;
    const credentialScopeRef = React.useRef(credentialScope);
    credentialScopeRef.current = credentialScope;
    const accountModeRef = React.useRef<ScopedAccountMode | null>(null);
    const accountModePromiseRef = React.useRef<ScopedAccountModePromise | null>(null);

    React.useEffect(() => {
        accountModeRef.current = null;
        accountModePromiseRef.current = null;
    }, [credentialScope]);

    return React.useCallback(async (): Promise<CredentialScopedAccountMode> => {
        if (!credentials) return 'e2ee';

        const cached = accountModeRef.current;
        if (cached?.credentialScope === credentialScope) return cached.mode;

        const existingPromise = accountModePromiseRef.current;
        if (existingPromise?.credentialScope === credentialScope) {
            return await existingPromise.promise;
        }

        const requestCredentialScope = credentialScope;
        const promise = fetchAccountEncryptionMode(credentials)
            .then((res): CredentialScopedAccountMode => (res.mode === 'plain' ? 'plain' : 'e2ee'))
            .catch((): CredentialScopedAccountMode | null => null)
            .then((mode): CredentialScopedAccountMode => {
                if (mode && credentialScopeRef.current === requestCredentialScope) {
                    accountModeRef.current = { credentialScope: requestCredentialScope, mode };
                }
                return mode ?? 'e2ee';
            })
            .finally(() => {
                const activePromise = accountModePromiseRef.current;
                if (activePromise?.credentialScope === requestCredentialScope && activePromise.promise === promise) {
                    accountModePromiseRef.current = null;
                }
            });

        accountModePromiseRef.current = { credentialScope: requestCredentialScope, promise };
        return await promise;
    }, [credentialScope, credentials]);
}
