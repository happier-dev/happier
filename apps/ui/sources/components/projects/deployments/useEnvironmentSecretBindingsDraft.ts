import * as React from 'react';
import type { DeploymentEnvironmentDetailV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { applyEnvironmentSecretBindingsPatchV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { HappyError } from '@/utils/errors/errors';
import { useEnvironmentSecretBindingsEditor } from './useEnvironmentSecretBindingsEditor';
import type { createDeploymentActions } from './deploymentActions';

export type EnvironmentBindingsCommit = ReturnType<typeof createDeploymentActions>['setBindings'];

export type EnvironmentSecretBindingsDraftOptions = Readonly<{
    environmentId: string;
    lifetime: ServerAccountScopeLifetime | null;
    snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>;
    setBindings: EnvironmentBindingsCommit | null;
    managedIdentities?: ReadonlySet<string>;
}>;

type Scope = Readonly<{ lifetime: ServerAccountScopeLifetime | null; environmentId: string }>;
type Draft = Readonly<{ scope: Scope; base: DeploymentEnvironmentDetailV1; bindings: readonly EnvironmentSecretBindingV1[] }>;
const EMPTY_BINDINGS: readonly EnvironmentSecretBindingV1[] = Object.freeze([]);
function refuse(code: string): never { throw new HappyError(code, false, { code }); }

/** The existing Environment read owns data; this hook owns only uncommitted edits. */
export function useEnvironmentSecretBindingsDraft(options: EnvironmentSecretBindingsDraftOptions) {
    const lifetime = options.lifetime;
    const flight = React.useRef<Readonly<{ scope: Scope; controller: AbortController;
        promise: ReturnType<EnvironmentBindingsCommit> }> | null>(null);
    const subscribe = React.useCallback((listener: () => void) => {
        const watch = lifetime?.onRetire(() => {
            const pending = flight.current;
            if (pending?.scope.lifetime === lifetime) { flight.current = null; pending.controller.abort(); }
            listener();
        });
        return () => watch?.dispose();
    }, [lifetime]);
    const readCurrent = React.useCallback(() => lifetime?.isCurrent() === true, [lifetime]);
    const isCurrent = React.useSyncExternalStore(subscribe, readCurrent, readCurrent);
    const detail = isCurrent && options.snapshot.value?.environment.id === options.environmentId ? options.snapshot.value : null;
    const scope = React.useMemo(() => ({ lifetime, environmentId: options.environmentId }), [lifetime, options.environmentId]);
    const [draftState, setDraft] = React.useState<Draft | null>(null);
    const scoped = isCurrent && draftState?.scope === scope ? draftState : null;
    const dirty = scoped !== null && !sameStrictJsonValue(scoped.bindings, scoped.base.content.bindings);
    // Retain an acknowledged save until the opened Environment receives its echo.
    const draft = scoped && (dirty || detail === null || detail.environment.revision < scoped.base.environment.revision) ? scoped : null;
    const base = draft?.base ?? detail;
    const bindings = draft?.bindings ?? detail?.content.bindings ?? EMPTY_BINDINGS;
    const conflict = dirty && detail !== null && scoped !== null
        && (detail.environment.revision > scoped.base.environment.revision
            || detail.environment.revision === scoped.base.environment.revision
                && !sameStrictJsonValue(detail.content, scoped.base.content));
    const [savingScope, setSavingScope] = React.useState<Scope | null>(null);
    const saving = isCurrent && savingScope === scope;
    const canEdit = isCurrent && options.snapshot.status === 'ready' && detail?.environment.capabilities.manageBindings === true;
    const current = React.useRef({ options, scope, base, bindings, dirty, conflict, canEdit });
    current.current = { options, scope, base, bindings, dirty, conflict, canEdit };
    const editor = useEnvironmentSecretBindingsEditor({ bindings, scopeKey: scope, readOnly: !canEdit || saving,
        environmentOwner: detail?.environment.owner ?? base?.environment.owner,
        isCurrent: () => readCurrent() && flight.current?.scope !== scope,
        managedIdentities: options.managedIdentities,
        onChangeBindings(next) {
            const now = current.current;
            if (now.scope !== scope || !now.canEdit || !lifetime?.isCurrent() || !now.base) return;
            setDraft({ scope, base: now.base, bindings: next });
        } });
    React.useEffect(() => {
        setDraft(previous => previous?.scope === scope && isCurrent ? previous : null);
        setSavingScope(previous => previous === scope && isCurrent ? previous : null);
        return () => {
            const pending = flight.current;
            if (pending?.scope === scope) { flight.current = null; pending.controller.abort(); }
        };
    }, [scope, isCurrent]);

    function cancel() {
        if (current.current.scope !== scope) return;
        const pending = flight.current;
        if (pending?.scope === scope) { flight.current = null; pending.controller.abort(); }
        setSavingScope(null);
        setDraft(null);
        editor.cancelBulk();
    }
    function save(): Promise<Awaited<ReturnType<EnvironmentBindingsCommit>> | null> {
        const now = current.current;
        const rejected = (code: string) => Promise.reject(new HappyError(code, false, { code }));
        if (now.scope !== scope || !lifetime?.isCurrent()) return rejected('action_account_scope_changed');
        if (!now.dirty) return Promise.resolve(null);
        if (now.conflict) return rejected('deployment_conflict');
        if (now.options.snapshot.status !== 'ready' || !now.base) return rejected(now.options.snapshot.failure?.code ?? 'deployment_unavailable');
        if (!now.canEdit) return rejected('deployment_access_denied');
        if (editor.bulk !== null) return rejected('deployment_invalid');
        if (!now.options.setBindings) return rejected('client_required');
        const existing = flight.current;
        if (existing?.scope === scope) return existing.promise;
        const controller = new AbortController();
        const original = now.base;
        const previous = new Map(original.content.bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
        const next = new Set(now.bindings.map(environmentSecretBindingIdentityV1));
        const set = now.bindings.filter(binding => !sameStrictJsonValue(previous.get(environmentSecretBindingIdentityV1(binding)), binding));
        const remove = original.content.bindings.filter(binding => !next.has(environmentSecretBindingIdentityV1(binding)))
            .map(({ source: _source, ...identity }) => identity);
        const patch = { set, remove };
        const committed = { ...original.content, bindings: applyEnvironmentSecretBindingsPatchV1(original.content.bindings, patch) };
        const requested = original.environment;
        const commit = now.options.setBindings;
        const promise = Promise.resolve().then(async () => {
            controller.signal.throwIfAborted();
            if (current.current.scope !== scope || !lifetime.isCurrent()) refuse('action_account_scope_changed');
            const admitted = current.current;
            if (admitted.options.snapshot.status !== 'ready') refuse(admitted.options.snapshot.failure?.code ?? 'deployment_unavailable');
            if (admitted.conflict) refuse('deployment_conflict');
            if (!admitted.canEdit) refuse('deployment_access_denied');
            const result = await commit({ environmentId: requested.id, expectedRevision: requested.revision,
                ...patch }, { signal: controller.signal });
            if (current.current.scope !== scope || !lifetime.isCurrent()) refuse('action_account_scope_changed');
            controller.signal.throwIfAborted();
            if (result.ok && result.environmentId !== requested.id) refuse('deployment_conflict');
            if (result.ok && flight.current?.controller === controller) {
                setDraft({ scope, base: { ...original, environment: { ...requested, revision: result.revision }, content: committed },
                    bindings: committed.bindings });
                editor.cancelBulk();
            }
            return result;
        }).finally(() => {
            if (flight.current?.controller !== controller) return;
            flight.current = null;
            if (current.current.scope === scope) setSavingScope(null);
        });
        flight.current = { scope, controller, promise };
        setSavingScope(scope);
        return promise;
    }
    return { editor, dirty, conflict, saving, canEdit,
        canSave: canEdit && options.setBindings !== null && dirty && !conflict && !saving && editor.bulk === null,
        status: isCurrent ? options.snapshot.status : 'idle' as const,
        failure: isCurrent ? options.snapshot.failure : null, cancel, save };
}
