import * as React from 'react';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readWorkflowRunRolePrefill } from '@/sync/domains/workflows/workflowRunListActions';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

const EMPTY_OVERRIDES: readonly RoleOverrideV1[] = Object.freeze([]);

/** Seed the review from the accepted-run reader; contextual Start retains it in its pending owner. */
export function useWorkflowRunRolePrefill(sourceArtifactId: string | null | undefined, custody?: Readonly<{
    overrides?: readonly RoleOverrideV1[];
    onChange?: (overrides: readonly RoleOverrideV1[]) => void;
}>) {
    const onChangeRef = React.useRef(custody?.onChange);
    onChangeRef.current = custody?.onChange;
    const retained = custody?.overrides !== undefined;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const addressedLifetime = useWorkflowAccountLifetime();
    const lifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const scope = lifetime?.scope ?? null;
    const identity = JSON.stringify([scope?.serverId, scope?.accountId, sourceArtifactId]);
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        identity: string; status: 'ready' | 'loading' | 'failed'; overrides: readonly RoleOverrideV1[];
        lifetime: ActiveServerAccountScopeLifetime | null;
    }>>({ identity, lifetime, status: sourceArtifactId ? 'loading' : 'ready', overrides: EMPTY_OVERRIDES });
    React.useEffect(() => {
        if (retained) return;
        if (!sourceArtifactId) {
            setState({ identity, lifetime, status: 'ready', overrides: EMPTY_OVERRIDES });
            return;
        }
        if (!lifetime) {
            setState({ identity, lifetime, status: 'failed', overrides: EMPTY_OVERRIDES });
            return;
        }
        const abort = new AbortController();
        const retirement = lifetime.onRetire(() => abort.abort());
        setState({ identity, lifetime, status: 'loading', overrides: EMPTY_OVERRIDES });
        void readWorkflowRunRolePrefill({ sourceArtifactId, accountId: lifetime.scope.accountId, signal: abort.signal, accountLifetime: lifetime })
            .then((overrides) => {
                if (!abort.signal.aborted && lifetime.isCurrent()) {
                    const value = overrides ?? EMPTY_OVERRIDES;
                    setState({ identity, lifetime, status: 'ready', overrides: value });
                    onChangeRef.current?.(value);
                }
            }, () => {
                if (!abort.signal.aborted && lifetime.isCurrent()) setState({ identity, lifetime, status: 'failed', overrides: EMPTY_OVERRIDES });
            });
        return () => { abort.abort(); retirement.dispose(); };
    }, [attempt, identity, lifetime, retained, sourceArtifactId]);
    const onChange = React.useCallback((overrides: readonly RoleOverrideV1[]) => {
        if (!lifetime?.isCurrent()) return;
        if (onChangeRef.current) onChangeRef.current(overrides);
        else setState({ identity, lifetime, status: 'ready', overrides });
    }, [identity, lifetime]);
    const current = state.identity === identity && state.lifetime === lifetime;
    return { overrides: custody?.overrides ?? (current ? state.overrides : EMPTY_OVERRIDES),
        status: retained ? 'ready' as const : current ? state.status : sourceArtifactId ? 'loading' as const : 'ready' as const,
        onChange, retry };
}
