import * as React from 'react';
import { areServerAccountScopesEqual, readServerAccountScopeOwnerLifetime,
    type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { SharePrincipalPresentation } from './shareSheetTypes';

const NO_NAMES: Readonly<Record<string, SharePrincipalPresentation>> = Object.freeze({});

/** Keep the directory row a person chose alongside ref-only draft data, within its Home and Account. */
export function useChosenSharePrincipalPresentations(scope: ServerAccountScope, lifetime?: ServerAccountScopeLifetime) {
    const owner = lifetime ? readServerAccountScopeOwnerLifetime(lifetime) : undefined;
    const [chosen, setChosen] = React.useState<Readonly<{
        scope: ServerAccountScope;
        owner: ServerAccountScopeLifetime | undefined;
        names: Readonly<Record<string, SharePrincipalPresentation>>;
    }> | null>(null);
    const names = chosen && chosen.owner === owner && areServerAccountScopesEqual(chosen.scope, scope) ? chosen.names : NO_NAMES;
    const remember = React.useCallback((principal: SharePrincipalPresentation) => {
        setChosen(current => {
            const previous = current && current.owner === owner && areServerAccountScopesEqual(current.scope, scope) ? current.names : NO_NAMES;
            return previous[principal.key] === principal ? current
                : { scope, owner, names: { ...previous, [principal.key]: principal } };
        });
    }, [owner, scope]);
    return [names, remember] as const;
}
