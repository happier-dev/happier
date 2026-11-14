import * as React from 'react';
import type { DeploymentEnvironmentDetailV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { environmentSecretBindingIdentityV1, projectEnvironmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { applyEnvironmentSecretBindingsPatchV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { HappyError } from '@/utils/errors/errors';
import { randomUUID } from '@/platform/randomUUID';
import { useEnvironmentSecretBindingsEditor } from './useEnvironmentSecretBindingsEditor';
import type { createDeploymentActions } from './deploymentActions';

type BindingsAction = ReturnType<typeof createDeploymentActions>['setBindings'];
export type EnvironmentBindingsCommit = (
    input: Parameters<BindingsAction>[0],
    operation: Parameters<BindingsAction>[1],
    base: DeploymentEnvironmentDetailV1,
) => ReturnType<BindingsAction>;

export type EnvironmentSecretBindingsDraftOptions = Readonly<{
    environmentId: string;
    lifetime: ServerAccountScopeLifetime | null;
    snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>;
    setBindings: EnvironmentBindingsCommit | null;
    managedIdentities?: ReadonlySet<string>;
    /** Preview blueprints share the variable editor, but persist through Environment update. */
    bindingTarget?: 'previewTemplate';
    readOnly?: boolean;
}>;

type Scope = Readonly<{ lifetime: ServerAccountScopeLifetime | null; environmentId: string; bindingTarget?: 'previewTemplate' }>;
type ProviderChoice = 'useOurs' | 'keepTheirs';
type ProviderChoices = ReadonlyMap<string, ProviderChoice>;
const NO_PROVIDER_CHOICES: ProviderChoices = new Map();
type Draft = Readonly<{ scope: Scope; base: DeploymentEnvironmentDetailV1; bindings: readonly EnvironmentSecretBindingV1[]; providerChoices?: ProviderChoices }>;
const EMPTY_BINDINGS: readonly EnvironmentSecretBindingV1[] = Object.freeze([]);
function bindingsOf(detail: DeploymentEnvironmentDetailV1 | null, target?: 'previewTemplate'): readonly EnvironmentSecretBindingV1[] {
    return target === 'previewTemplate' ? detail?.content.previewTemplate?.bindingBlueprints ?? EMPTY_BINDINGS
        : detail?.content.bindings ?? EMPTY_BINDINGS;
}
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
    const scope = React.useMemo(() => ({ lifetime, environmentId: options.environmentId, bindingTarget: options.bindingTarget }), [lifetime, options.environmentId, options.bindingTarget]);
    const [draftState, setDraft] = React.useState<Draft | null>(null);
    const scoped = isCurrent && draftState?.scope === scope ? draftState : null;
    const dirty = scoped !== null && (!sameStrictJsonValue(scoped.bindings, bindingsOf(scoped.base, options.bindingTarget))
        || (scoped.providerChoices ?? NO_PROVIDER_CHOICES).size > 0);
    // Retain an acknowledged save until the opened Environment receives its echo.
    const draft = scoped && (dirty || detail === null || detail.environment.revision < scoped.base.environment.revision) ? scoped : null;
    const base = draft?.base ?? detail;
    const bindings = draft?.bindings ?? bindingsOf(detail, options.bindingTarget);
    const providerChoices = draft?.providerChoices ?? NO_PROVIDER_CHOICES;
    const conflict = dirty && detail !== null && scoped !== null
        && (detail.environment.revision > scoped.base.environment.revision
            || detail.environment.revision === scoped.base.environment.revision
                && !sameStrictJsonValue(detail.content, scoped.base.content));
    const [savingScope, setSavingScope] = React.useState<Scope | null>(null);
    const saving = isCurrent && savingScope === scope;
    const canEdit = !options.readOnly && isCurrent && options.snapshot.status === 'ready' && (options.bindingTarget === 'previewTemplate'
        ? detail?.environment.capabilities.role === 'manager' && detail.content.previewTemplate !== undefined
        : detail?.environment.capabilities.manageBindings === true);
    const current = React.useRef({ options, scope, base, bindings, providerChoices, dirty, conflict, canEdit });
    current.current = { options, scope, base, bindings, providerChoices, dirty, conflict, canEdit };
    const editor = useEnvironmentSecretBindingsEditor({ bindings, scopeKey: scope, readOnly: !canEdit || saving,
        environmentOwner: detail?.environment.owner ?? base?.environment.owner,
        isCurrent: () => readCurrent() && flight.current?.scope !== scope,
        managedIdentities: options.managedIdentities,
        onChangeBindings(next) {
            const now = current.current;
            if (now.scope !== scope || !now.canEdit || !lifetime?.isCurrent() || !now.base) return;
            setDraft({ scope, base: now.base, bindings: next, providerChoices: now.providerChoices });
        } });
    React.useEffect(() => {
        setDraft(previous => previous?.scope === scope && isCurrent ? previous : null);
        setSavingScope(previous => previous === scope && isCurrent ? previous : null);
        return () => {
            const pending = flight.current;
            if (pending?.scope === scope) { flight.current = null; pending.controller.abort(); }
        };
    }, [scope, isCurrent]);

    function chooseProviderVariable(key: string, choice: ProviderChoice) {
        const now = current.current;
        if (now.scope !== scope || !now.canEdit || !lifetime?.isCurrent() || !now.base || flight.current) return;
        setDraft({ scope, base: now.base, bindings: now.bindings, providerChoices: new Map([...now.providerChoices, [key, choice]]) });
    }
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
        const originalBindings = bindingsOf(original, now.options.bindingTarget);
        const previous = new Map(originalBindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
        const next = new Set(now.bindings.map(environmentSecretBindingIdentityV1));
        const set = now.bindings.filter(binding => !sameStrictJsonValue(previous.get(environmentSecretBindingIdentityV1(binding)), binding));
        const remove = originalBindings.filter(binding => !next.has(environmentSecretBindingIdentityV1(binding)))
            .map(projectEnvironmentSecretBindingIdentityV1);
        const choiceEntries = [...now.providerChoices];
        const providerVariables = choiceEntries.length ? {
            useOurs: choiceEntries.filter(([, choice]) => choice === 'useOurs').map(([key]) => key),
            keepTheirs: choiceEntries.filter(([, choice]) => choice === 'keepTheirs').map(([key]) => key),
        } : undefined;
        const patch = { set, remove, ...(providerVariables ? { providerVariables } : {}) };
        const savedBindings = applyEnvironmentSecretBindingsPatchV1(originalBindings, patch, randomUUID)
            .filter(binding => binding.purpose !== 'variable' || !providerVariables?.keepTheirs.includes(binding.name));
        const committed = now.options.bindingTarget === 'previewTemplate' && original.content.previewTemplate
            ? { ...original.content, previewTemplate: { ...original.content.previewTemplate,
                bindingBlueprints: savedBindings.filter(binding => binding.purpose === 'variable') } }
            : { ...original.content, bindings: savedBindings };
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
                ...patch }, { signal: controller.signal }, original);
            if (current.current.scope !== scope || !lifetime.isCurrent()) refuse('action_account_scope_changed');
            controller.signal.throwIfAborted();
            if (result.ok && result.environmentId !== requested.id) refuse('deployment_conflict');
            if (result.ok && flight.current?.controller === controller) {
                setDraft({ scope, base: { ...original, environment: { ...requested, ...result.preparedArtifact,
                    revision: result.revision }, content: committed },
                    bindings: savedBindings, providerChoices: new Map(choiceEntries.filter(([key]) =>
                        result.providerVariables?.failures.some(failure => failure.key === key))) });
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
        providerChoices, chooseProviderVariable,
        status: isCurrent ? options.snapshot.status : 'idle' as const,
        failure: isCurrent ? options.snapshot.failure : null, cancel, save };
}
