import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createAccountNoticeInvestigation } from './accountNoticeInvestigation';

const InvestigationContext = React.createContext<ReturnType<typeof createAccountNoticeInvestigation> | null>(null);
const execute = createFrontDoorActionExecute();

/** Account custody outlives Inbox drawers and failure pages; mounting issues no reads. */
function AccountNoticeInvestigationProvider(props: Readonly<{ children: React.ReactNode }>) {
    const scope = useActiveServerAccountScope();
    const owner = React.useMemo(() => {
        const captureCurrent = () => {
            const lifetime = captureActiveServerAccountScopeLifetime();
            return () => lifetime?.isCurrent() === true && areServerAccountScopesEqual(lifetime.scope, scope)
                && areServerAccountScopesEqual(storage.getState().profileScope, scope);
        };
        return createAccountNoticeInvestigation({ scope, execute,
            isCurrent: () => captureCurrent()(), captureCurrent });
    }, [scope?.serverId, scope?.accountId]);
    React.useEffect(() => () => owner.dispose(), [owner]);
    return <InvestigationContext.Provider value={owner}>{props.children}</InvestigationContext.Provider>;
}

/** The shell owns it; isolated Inbox/test roots borrow it or mount the same small owner. */
export function AccountNoticeInvestigationBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(InvestigationContext);
    return existing ? <>{props.children}</> : <AccountNoticeInvestigationProvider>{props.children}</AccountNoticeInvestigationProvider>;
}

export function useOptionalAccountNoticeInvestigation() {
    return React.useContext(InvestigationContext);
}

export function useAccountNoticeInvestigation() {
    const owner = useOptionalAccountNoticeInvestigation();
    if (!owner) throw new Error('Investigate requires AccountNoticeInvestigationBoundary');
    return owner;
}
