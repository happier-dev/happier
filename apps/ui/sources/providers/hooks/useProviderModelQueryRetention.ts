import * as React from 'react';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { releaseProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';

type RetainedQuery = Readonly<{ scope: ServerAccountScope; credentialKey: string; queryKey: string }>;

export function useProviderModelQueryRetention(scope: ServerAccountScope | null, credentialKey: string | null, queryKey: string): void {
    const previous = React.useRef<RetainedQuery | null>(null);
    React.useEffect(() => {
        const retained = previous.current;
        if (retained && scope && retained.credentialKey === credentialKey && retained.queryKey === queryKey
            && serverAccountScopeKeySuffix(retained.scope) === serverAccountScopeKeySuffix(scope)) return;
        previous.current = scope && credentialKey ? { scope, credentialKey, queryKey } : null;
        if (retained) releaseProviderModelProjectionSnapshot(retained.scope, retained.credentialKey, retained.queryKey);
        // Deliberately no unmount cleanup: reopening this query paints its retained data immediately.
    }, [scope, credentialKey, queryKey]);
}
