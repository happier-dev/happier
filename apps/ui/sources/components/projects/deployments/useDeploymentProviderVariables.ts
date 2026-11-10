import * as React from 'react';
import type { DeploymentTargetVariablesReadResultV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeploymentActions } from './deploymentActions';
import { readDeploymentActionError } from './deploymentActionOutcome';

type State = Readonly<{ value: DeploymentTargetVariablesReadResultV1 | null; loading: boolean; failure: string | null }>;
const IDLE: State = Object.freeze({ value: null, loading: false, failure: null });

/** One finite metadata demand for the visible platform Variables panel; no timer or ordinary-read effect. */
export function useDeploymentProviderVariables(input: Readonly<{
    lifetime: ServerAccountScopeLifetime | null; active?: boolean; projectSourceId?: string; environmentId: string; targetLinkId?: string | null;
}>) {
    const scope = React.useMemo(() => ({ lifetime: input.lifetime, projectSourceId: input.projectSourceId,
        environmentId: input.environmentId, targetLinkId: input.targetLinkId }),
    [input.lifetime, input.projectSourceId, input.environmentId, input.targetLinkId]);
    const [read, setRead] = React.useState<Readonly<{ scope: typeof scope; state: State }> | null>(null);
    const flight = React.useRef<AbortController | null>(null);
    const refresh = React.useCallback(async () => {
        if (input.active === false || !scope.lifetime?.isCurrent() || !scope.projectSourceId || !scope.targetLinkId) return;
        flight.current?.abort();
        const controller = new AbortController();
        flight.current = controller;
        setRead(previous => ({ scope, state: { value: previous?.scope === scope ? previous.state.value : null,
            loading: true, failure: null } }));
        try {
            const result = await createDeploymentActions(scope.lifetime, scope.projectSourceId).readObservation({
                environmentId: scope.environmentId, targetLinkId: scope.targetLinkId, variables: true,
            }, { signal: controller.signal });
            if (controller.signal.aborted || !scope.lifetime.isCurrent()) return;
            setRead(previous => ({ scope, state: result.ok && result.providerVariables
                ? { value: result.providerVariables, loading: false, failure: null }
                : { value: previous?.scope === scope ? previous.state.value : null, loading: false,
                    failure: result.ok ? 'unsupported_action' : result.error } }));
        } catch (error) {
            if (controller.signal.aborted || !scope.lifetime.isCurrent()) return;
            const outcome = readDeploymentActionError(error);
            setRead(previous => ({ scope, state: { value: previous?.scope === scope ? previous.state.value : null,
                loading: false, failure: outcome.kind === 'refused' ? outcome.code : 'deployment_unavailable' } }));
        } finally { if (flight.current === controller) flight.current = null; }
    }, [scope, input.active]);
    React.useEffect(() => {
        void refresh();
        const retired = scope.lifetime?.onRetire(() => { flight.current?.abort(); setRead(null); });
        return () => { retired?.dispose(); flight.current?.abort(); };
    }, [scope, refresh]);
    return { ...(read?.scope === scope && scope.lifetime?.isCurrent() ? read.state : IDLE), refresh };
}
