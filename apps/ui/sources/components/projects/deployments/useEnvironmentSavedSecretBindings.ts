import * as React from 'react';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useSavedSecretCatalog, type SavedSecretPrivateCreationApprovalOptions } from '@/components/secrets/useSavedSecretCatalog';
import type { useEnvironmentSecretBindingsEditor } from './useEnvironmentSecretBindingsEditor';

type Editor = ReturnType<typeof useEnvironmentSecretBindingsEditor>;
type SecretSource = Parameters<Editor['applyBulk']>[0][string];
type Sources = Readonly<Record<string, SecretSource>>;
export type EnvironmentSavedSecretBindingResult = Readonly<{ ok: true; sources: Sources }>
    | Readonly<{ ok: false; error: string; sources: Sources }>;
export type EnvironmentSavedSecretBindingOptions = Readonly<{
    scope: AccountSettingsScope | null;
    scopeKey: unknown;
    editor: Editor;
    readOnly?: boolean;
    isCurrent?: () => boolean;
}>;

type CreationStatus = 'idle' | 'creating' | 'waitingApproval' | 'binding';

/** Mount only in the demanded Variables editor. Saved Secrets own creation;
 * K1's editor owns the local draft, whose parent alone invokes bindings.set. */
export function useEnvironmentSavedSecretBindings(options: EnvironmentSavedSecretBindingOptions) {
    const catalog = useSavedSecretCatalog({ scope: options.readOnly ? null : options.scope, includeMaterial: false });
    const scope = React.useMemo(() => ({}), [options.scopeKey, options.scope?.serverId, options.scope?.accountId]);
    const current = React.useRef({ options, catalog, scope });
    current.current = { options, catalog, scope };
    const flight = React.useRef<Readonly<{ scope: typeof scope; controller: AbortController }> | null>(null);
    const [state, setState] = React.useState<Readonly<{ scope: typeof scope; status: CreationStatus }> | null>(null);
    const available = !options.readOnly && options.isCurrent?.() !== false;
    const status = available && state?.scope === scope ? state.status : 'idle';
    React.useEffect(() => () => {
        if (flight.current?.scope === scope) flight.current.controller.abort();
    }, [scope, available]);

    function isCurrent() {
        const now = current.current;
        return now.scope === scope && !now.options.readOnly && now.options.isCurrent?.() !== false;
    }
    async function run(
        effect: (input: Readonly<{ editor: Editor; create(name: string, value: string): Promise<SecretSource | null>;
            sources: Record<string, SecretSource>; signal: AbortSignal }>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>>,
        selections: Sources, approval?: SavedSecretPrivateCreationApprovalOptions,
    ): Promise<EnvironmentSavedSecretBindingResult> {
        const sources: Record<string, SecretSource> = Object.assign(Object.create(null), selections);
        const failed = (error: string) => ({ ok: false as const, error, sources });
        const now = current.current;
        if (!isCurrent() || !now.catalog.personalMutationsAvailable) return failed('unavailable');
        if (flight.current?.scope === scope) return failed('action_in_progress');
        if (approval?.signal?.aborted) return failed('canceled');
        const controller = new AbortController();
        const abort = () => controller.abort();
        approval?.signal?.addEventListener('abort', abort, { once: true });
        flight.current = { scope, controller };
        const publish = (next: CreationStatus) => {
            if (current.current.scope === scope && flight.current?.controller === controller) setState({ scope, status: next });
        };
        try {
            const create = async (name: string, value: string): Promise<SecretSource | null> => {
                if (!isCurrent() || controller.signal.aborted) return null;
                publish('creating');
                // Reuse the existing Action approval continuation and its abort
                // lifetime, including while the HTTP boundary is still pending.
                const ref = await now.catalog.personalMutations.create({ name, value }, {
                    ...approval, signal: controller.signal,
                    onApprovalPending(registration) { publish('waitingApproval'); approval?.onApprovalPending(registration); },
                });
                return ref ? { kind: 'secret', ref, resourceRevision: 1 } : null;
            };
            const result = await effect({ editor: now.options.editor, create, sources, signal: controller.signal });
            if (controller.signal.aborted) return failed('canceled');
            if (!isCurrent()) return failed('unavailable');
            return { ...result, sources };
        } catch {
            return failed(controller.signal.aborted ? 'canceled' : 'creation_failed');
        } finally {
            approval?.signal?.removeEventListener('abort', abort);
            if (flight.current?.controller === controller) { publish('idle'); flight.current = null; }
        }
    }
    function createAndBind(input: Readonly<{ name: string; value: string; phase: 'build' | 'runtime' | 'both';
        originalIdentity?: string }>, approval?: SavedSecretPrivateCreationApprovalOptions) {
        return run(async ({ editor, create, sources, signal }) => {
            const checked = editor.validateVariable({ ...input, source: { kind: 'value', value: input.value } });
            if (!checked.ok) return checked;
            const source = await create(input.name, input.value);
            if (!source) return { ok: false, error: 'creation_failed' };
            sources[input.name] = source;
            if (signal.aborted || !isCurrent()) return { ok: false, error: 'unavailable' };
            setState({ scope, status: 'binding' });
            return editor.setVariable({ name: input.name, phase: input.phase, source,
                ...(input.originalIdentity === undefined ? {} : { originalIdentity: input.originalIdentity }) });
        }, {}, approval);
    }
    function applyBulk(selections: Sources = {}, approval?: SavedSecretPrivateCreationApprovalOptions) {
        return run(async ({ editor, create, sources, signal }) => {
            const checked = editor.validateBulk(selections);
            if (!checked.ok) return checked;
            for (const row of editor.bulk ?? []) {
                if (row.source !== null || row.classification === 'plain' || Object.hasOwn(sources, row.name)) continue;
                const source = await create(row.name, row.value);
                if (!source) return { ok: false, error: 'creation_failed' };
                sources[row.name] = source;
                if (signal.aborted || !isCurrent()) return { ok: false, error: 'unavailable' };
            }
            if (signal.aborted || !isCurrent()) return { ok: false, error: 'unavailable' };
            setState({ scope, status: 'binding' });
            return editor.applyBulk(sources);
        }, selections, approval);
    }
    return { status, busy: status !== 'idle', createAndBind, applyBulk,
        cancel: () => { if (flight.current?.scope === scope) flight.current.controller.abort(); } };
}
