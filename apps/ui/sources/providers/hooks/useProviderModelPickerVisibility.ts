import * as React from 'react';
import { resolveProviderModelPickerVisibility, type ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { useRetireProviderStateOnAccountChange } from './accountLifetimeRetirement';

/**
 * The Account-wide "Show in model picker" choice for one Provider connection (plan R1, D8): the
 * stored override, else the default its contribution kind implies, and its writer.
 */
export type ProviderModelPickerVisibility = Readonly<{
    shown: boolean;
    /** Which kind default applies, so a row can say why the source is on or off. */
    defaultReason: 'direct' | 'manyModels' | 'local';
    busy: boolean;
    setShown: (shown: boolean) => void;
    error: unknown;
    reviewCurrentState: () => Promise<void>;
}>;

/**
 * Seam owned by plan unit R1 (`modelPickerVisibilityByConnectionId` and its kind-default policy).
 * The caller supplies its declared contribution kind. The captured Account Action owns writes;
 * without a stored connection and declaration the hook never guesses a default or uses a machine.
 */
export function useProviderModelPickerVisibility(connectionId: string | null, owner?: Readonly<{
    kind: ProviderModelPickerSourceKind;
    serverId?: string | null;
}>): ProviderModelPickerVisibility | null {
    const serverId = owner?.serverId;
    const catalog = useProviderCatalogForServer(serverId);
    const [operation, setOperation] = React.useState<Readonly<{
        scope: object;
        busy: boolean;
        error: unknown;
    }> | null>(null);
    const pendingScope = React.useRef<object | null>(null);
    const retire = React.useCallback(() => {
        pendingScope.current = null;
        setOperation(null);
    }, []);
    const accountLifetime = useRetireProviderStateOnAccountChange(retire);
    const { setProviderModelPickerVisibility, ready } = useProviderActionClient(serverId ?? null, accountLifetime);
    const scope = React.useMemo(() => ({ accountLifetime, connectionId, serverId }), [accountLifetime, connectionId, serverId]);
    const currentScope = React.useRef<typeof scope | null>(scope);
    currentScope.current = scope;
    React.useEffect(() => {
        currentScope.current = scope;
        return () => { if (currentScope.current === scope) currentScope.current = null; };
    }, [scope]);
    const reviewCurrentState = React.useCallback(async () => {
        if (currentScope.current === scope && accountLifetime?.isCurrent()) {
            await refreshProviderCatalog(accountLifetime.scope);
        }
    }, [accountLifetime, scope]);
    const setShown = React.useCallback((shown: boolean) => {
        if (!connectionId || !ready || !accountLifetime?.isCurrent()
            || currentScope.current !== scope || pendingScope.current === scope) return;
        pendingScope.current = scope;
        setOperation({ scope, busy: true, error: null });
        void (async () => {
            try {
                await setProviderModelPickerVisibility({ serverId: serverId ?? accountLifetime.scope.serverId, connectionId, shown });
                if (currentScope.current === scope && accountLifetime.isCurrent()) {
                    setOperation({ scope, busy: false, error: null });
                }
            } catch (error) {
                if (currentScope.current === scope && accountLifetime.isCurrent()) {
                    setOperation({ scope, busy: false, error });
                }
            } finally {
                if (pendingScope.current === scope) pendingScope.current = null;
            }
        })();
    }, [accountLifetime, connectionId, ready, scope, serverId, setProviderModelPickerVisibility]);
    if (!connectionId || !owner || !catalog?.data?.connections.some(connection => connection.id === connectionId)) return null;
    const policy = resolveProviderModelPickerVisibility({ connectionId, kind: owner.kind,
        modelPickerVisibilityByConnectionId: catalog.data.modelPickerVisibilityByConnectionId });
    return { shown: policy.shown, defaultReason: policy.defaultReason,
        busy: !ready || (operation?.scope === scope && operation.busy),
        error: operation?.scope === scope ? operation.error : null, setShown, reviewCurrentState };
}
