import * as React from 'react';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { canActivateCurrentUiContextMount, type CurrentUiContextMountedEnrichment, type CurrentUiContextMountedCommand } from './currentUiContextModel';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CurrentUiContextBridge, useOptionalCurrentUiContextReader } from './CurrentUiContextProvider';
import { useModalContentId } from '@/modal/ModalProvider';
import type { ModalCommandBridgeProps } from '@/modal/types';
import { executeMountedCurrentUiContextCommand } from './currentUiContextActionRuntime';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { CurrentUiContextVoiceInvocationOutcome } from './currentUiContextVoiceToolPort';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

type LocalCommandResult = boolean | void | CurrentUiContextVoiceInvocationOutcome;
export type CurrentUiContextMountedCommandExecution = Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'executeForCaller' | 'binding'>;

/** A command retains its original caller while the chosen mounted engine owns delivery and lifetime. */
export type CurrentUiContextCommandInvocation = Readonly<{
    execute(engine: CurrentUiContextMountedCommandExecution,
        ...args: Parameters<CurrentUiContextMountedCommandExecution['execute']>): ReturnType<CurrentUiContextMountedCommandExecution['execute']>;
}>;

function bindCommandInvocation(context: ActionExecutorContext): CurrentUiContextCommandInvocation {
    return { execute: (engine, actionId, input, operation) => {
        const execute = (childId: typeof actionId, childInput: unknown, caller: ActionExecutorContext) =>
            engine.executeForCaller(childId, childInput, caller, operation);
        const signal = operation?.signal ?? context.signal;
        return context.executeOrdinaryChildAction
            ? context.executeOrdinaryChildAction(actionId, input, { serverId: engine.binding?.scope.serverId,
                expectedAccountId: engine.binding?.scope.accountId, signal, execute })
            : execute(actionId, input, { ...context, signal });
    } };
}

export type CurrentUiContextLocalCommand = Readonly<{
    key: string;
    title: string;
    description?: string;
    setting?: Extract<CurrentUiContextMountedCommand, { kind: 'hostLocal' }>['setting'];
    invoke(input: PluginUiJsonValueV1 | undefined, context: ActionExecutorContext,
        invocation: CurrentUiContextCommandInvocation): LocalCommandResult | Promise<LocalCommandResult>;
}>;

type ComposedCommands = NonNullable<CurrentUiContextMountedEnrichment['commands']>;
type CommandComposition = Readonly<{
    authority: ServerAccountScopeLifetime | null;
    execution: CurrentUiContextMountedCommandExecution;
    isCurrent(): boolean;
    register(owner: object, commands: ComposedCommands): () => void;
    focus(owner: object, commands: ComposedCommands, onRetire: () => void): () => void;
}>;
const EMPTY_COMMANDS: ComposedCommands = Object.freeze([]);
const CompositionContext = React.createContext<CommandComposition | null>(null);
const CommandsContext = React.createContext<ComposedCommands>(EMPTY_COMMANDS);

/** Re-provide the same command owner and reader when a host reparents a modal outside AppShell. */
export function useCurrentUiContextCommandBridge() {
    const composition = React.useContext(CompositionContext);
    const reader = useOptionalCurrentUiContextReader();
    return React.useMemo(() => function CommandBridge(props: ModalCommandBridgeProps) {
        return <CompositionContext.Provider value={composition}>
            <CurrentUiContextBridge publisher={null} reader={reader}>
                {props.modalCommands ? <MountedModalCommands {...props.modalCommands} /> : props.children}
            </CurrentUiContextBridge>
        </CompositionContext.Provider>;
    }, [composition, reader]);
}

function MountedModalCommands(props: NonNullable<ModalCommandBridgeProps['modalCommands']>): React.ReactNode {
    const commands = useCurrentUiContextLocalCommands(props.commands, { foregroundOverlay: true });
    return props.render(commands.invoke);
}

/** React composition only: the existing current-context publisher retains the sole command record. */
export function CurrentUiContextCommandsProvider(props: Readonly<{
    authority: ServerAccountScopeLifetime | null;
    active?: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const { execute, executeForCaller, binding } = useMountedActionExecution(props.authority?.scope);
    const execution = React.useMemo(() => ({ execute, executeForCaller, binding }), [execute, executeForCaller, binding]);
    const entries = React.useRef<Map<object, ComposedCommands> | null>(null);
    if (entries.current === null) entries.current = new Map();
    const registry = entries.current;
    const [revision, invalidate] = React.useReducer((current: number) => current + 1, 0);
    const latest = React.useRef(props);
    latest.current = props;
    const mounted = React.useRef(true);
    React.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const register = React.useCallback((owner: object, commands: ComposedCommands) => {
        registry.delete(owner);
        registry.set(owner, commands);
        invalidate();
        return () => { registry.delete(owner); invalidate(); };
    }, [registry]);
    const focused = React.useRef<(() => void) | null>(null);
    const focus = React.useCallback((owner: object, commands: ComposedCommands, onRetire: () => void) => {
        focused.current?.();
        const unregister = register(owner, commands);
        const clear = () => {
            if (focused.current !== clear) return;
            focused.current = null;
            unregister();
            onRetire();
        };
        focused.current = clear;
        return clear;
    }, [register]);
    const composition = React.useMemo<CommandComposition>(() => ({
        authority: props.authority,
        execution,
        isCurrent: () => mounted.current && latest.current.active !== false
            && latest.current.authority === props.authority && props.authority?.isCurrent() === true,
        register,
        focus,
    }), [props.authority, execution, register, focus]);
    const [retired, setRetired] = React.useState<ServerAccountScopeLifetime | null>(null);
    React.useLayoutEffect(() => {
        const authority = props.authority;
        if (!authority) return;
        const subscription = authority.onRetire(() => setRetired(authority));
        return () => subscription.dispose();
    }, [props.authority]);
    const commands = React.useMemo(() => {
        if (!composition.isCurrent() || retired === props.authority) return EMPTY_COMMANDS;
        const combined: ComposedCommands[number][] = [];
        for (const commands of registry.values()) {
            for (const command of commands) combined.push(command);
        }
        return combined;
    }, [composition, registry, revision, props.active, retired]);
    return <CompositionContext.Provider value={composition}>
        <CommandsContext.Provider value={commands}>{props.children}</CommandsContext.Provider>
    </CompositionContext.Provider>;
}

/** The page appends these definitions to its own enrichment; descendants never publish competing mounts. */
export function useCurrentUiContextComposedCommands(): ComposedCommands {
    return React.useContext(CommandsContext);
}

/** Focus selects one field's commands without replacing the current page's entity or commands. */
export function useCurrentUiContextFocusedCommands(contextKey: string): Readonly<{
    activate(commands: ComposedCommands): Promise<boolean>;
    clear(): void;
}> | null {
    const composition = React.useContext(CompositionContext);
    const reader = useOptionalCurrentUiContextReader();
    const publication = React.useMemo(() => {
        if (!composition || !reader) return null;
        const owner = {};
        let current: Readonly<{ commands: ComposedCommands; clear(): void; retirement: AbortController }> | null = null;
        const clear = () => { current?.clear(); };
        const eligible = () => composition.isCurrent() && canActivateCurrentUiContextMount(reader.readCurrentUiContext());
        return {
            clear,
            activate(commands: ComposedCommands): Promise<boolean> {
                if (!eligible()) return Promise.resolve(false);
                if (!current || current.commands !== commands) {
                    clear();
                    const retirement = new AbortController();
                    const unregister = composition.focus(owner, commands, () => { current = null; retirement.abort(); });
                    current = { commands, clear: unregister, retirement };
                }
                const active = current;
                // Publication is pushed by the existing context composer. Callers wait for
                // its public descriptors rather than issuing an Action against private state.
                return new Promise(resolve => {
                    const finish = (accepted: boolean) => {
                        unsubscribe();
                        active.retirement.signal.removeEventListener('abort', cancelled);
                        resolve(accepted);
                    };
                    const cancelled = () => finish(false);
                    const check = () => {
                        if (active.retirement.signal.aborted || !eligible()) { finish(false); return; }
                        const snapshot = reader.readCurrentUiContext();
                        if (commands.every(entry => snapshot?.commands.some(descriptor => {
                            const resolved = reader.resolveCurrentUiCommand(descriptor.id);
                            return resolved?.command === entry.command && !resolved.retirementSignal.aborted;
                        }))) finish(true);
                    };
                    const unsubscribe = reader.subscribe(check);
                    active.retirement.signal.addEventListener('abort', cancelled, { once: true });
                    check();
                });
            },
        };
    }, [composition, reader, contextKey]);
    React.useEffect(() => () => publication?.clear(), [publication]);
    return publication;
}

/** Parameterized host Actions borrow the same mounted record and opaque address. */
export function useCurrentUiContextMountedCommand(command: CurrentUiContextMountedCommand | null, title: string): () => string | null {
    const composition = React.useContext(CompositionContext);
    const reader = useOptionalCurrentUiContextReader();
    React.useLayoutEffect(() => command ? composition?.register(command, [{ title, command }]) : undefined,
        [command, composition, title]);
    return React.useCallback(() => {
        if (!command || !composition?.isCurrent()) return null;
        const descriptor = reader?.readCurrentUiContext()?.commands.find(candidate => {
            const resolved = reader.resolveCurrentUiCommand(candidate.id);
            return resolved?.command === command && !resolved.retirementSignal.aborted;
        });
        return descriptor?.id ?? null;
    }, [command, composition, reader]);
}

/** One declaration lifecycle for mounted host controls and page-owned command publications. */
export function useCurrentUiContextLocalCommandDefinitions(
    commands: readonly CurrentUiContextLocalCommand[],
    isCurrent: () => boolean,
    contextKey?: string,
) {
    const latest = React.useRef(commands);
    React.useLayoutEffect(() => { latest.current = commands; }, [commands]);
    type Definition = Readonly<{
        key: string;
        title: string;
        description?: string;
        setting?: CurrentUiContextLocalCommand['setting'];
        command: CurrentUiContextMountedCommand;
        lifetime: { mounted: boolean };
    }>;
    const previous = React.useRef<Readonly<{ isCurrent: () => boolean; contextKey?: string; rows: readonly Definition[] }> | null>(null);
    const definitionKey = JSON.stringify(commands.map(({ key, title, description, setting }) => ({ key, title, description, setting })));
    const definitions = React.useMemo(() => {
        const prior = previous.current?.isCurrent === isCurrent && previous.current.contextKey === contextKey ? previous.current.rows : [];
        const rows = commands.map(({ key, title, description, setting }) => {
            const kept = prior.find(row => row.key === key && row.title === title && row.description === description
                && (row.setting === setting || row.setting?.anchor === setting?.anchor && areServerAccountScopesEqual(row.setting?.scope, setting?.scope)));
            if (kept) return kept;
            const lifetime = { mounted: false };
            return { key, title, lifetime, ...(description === undefined ? {} : { description }),
                ...(setting === undefined ? {} : { setting }), command: {
                kind: 'hostLocal' as const,
                ...(setting === undefined ? {} : { setting }),
                invoke: async ({ signal, input, context }: Readonly<{ signal: AbortSignal; input?: PluginUiJsonValueV1; context: ActionExecutorContext }>) => {
                    const current = latest.current.find(candidate => candidate.key === key);
                    if (signal.aborted || !lifetime.mounted || !isCurrent() || !current) {
                        return { ok: false as const, code: 'stale_surface' as const };
                    }
                    const applied = await current.invoke(input, context, bindCommandInvocation(context));
                    if (typeof applied === 'object' && applied !== null) return applied;
                    return applied === false ? { ok: false as const, code: 'stale_surface' as const } : { ok: true as const };
                },
            } };
        });
        return { isCurrent, contextKey, rows };
    }, [isCurrent, contextKey, definitionKey]);
    React.useLayoutEffect(() => {
        previous.current = definitions;
        for (const row of definitions.rows) row.lifetime.mounted = true;
        return () => { for (const row of definitions.rows) row.lifetime.mounted = false; };
    }, [definitions]);
    return definitions.rows;
}

export function useCurrentUiContextLocalCommands(commands: readonly CurrentUiContextLocalCommand[], options?: Readonly<{
    foregroundOverlay?: boolean;
    contextKey?: string;
    /** Shared controls in non-page hosts (PluginPageWidgetArea, ProjectAsideDocument) may run the same
     * declaration only when composition is absent. Effects must still delegate their canonical Action
     * admission with the caller context; this grants no authority. Retired/inactive providers never fall back. */
    unbound?: 'local';
}>): Readonly<{
    invoke(key: string, input?: PluginUiJsonValueV1, callerContext?: ActionExecutorContext,
        invocation?: CurrentUiContextCommandInvocation): Promise<boolean>;
}> {
    const composition = React.useContext(CompositionContext);
    const reader = useOptionalCurrentUiContextReader();
    const latest = React.useRef(commands);
    React.useLayoutEffect(() => { latest.current = commands; }, [commands]);
    const isCurrent = React.useCallback(() => composition?.isCurrent() === true, [composition]);
    const definitions = useCurrentUiContextLocalCommandDefinitions(commands, isCurrent, options?.contextKey);
    const modalId = useModalContentId();
    const mountedDefinitions = React.useMemo(() => options?.foregroundOverlay
        ? definitions.map(definition => ({ ...definition, foreground: { modalId } })) : definitions,
    [definitions, options?.foregroundOverlay, modalId]);
    React.useLayoutEffect(() => {
        return composition?.register(definitions, mountedDefinitions);
    }, [composition, definitions, mountedDefinitions]);
    const invoke = React.useCallback(async (key: string, input?: PluginUiJsonValueV1, callerContext?: ActionExecutorContext,
        invocation?: CurrentUiContextCommandInvocation): Promise<boolean> => {
        if (!composition) {
            const local = options?.unbound === 'local' ? latest.current.find(candidate => candidate.key === key) : undefined;
            if (!local) return false;
            const caller = callerContext ?? { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const } };
            const applied = await local.invoke(input, caller, invocation ?? bindCommandInvocation(caller));
            return typeof applied === 'object' && applied !== null ? applied.ok : applied !== false;
        }
        if (!composition.isCurrent()) return false;
        const command = definitions.find(candidate => candidate.key === key)?.command;
        const origin = invocation ?? (callerContext ? bindCommandInvocation(callerContext) : undefined);
        const execute: CurrentUiContextMountedCommandExecution['execute'] = (actionId, actionInput) => origin
            ? origin.execute(composition.execution, actionId, actionInput)
            : composition.execution.execute(actionId, actionInput);
        return (await executeMountedCurrentUiContextCommand({ reader, command, execute, input })).ok;
    }, [composition, definitions, options?.unbound, reader]);
    return React.useMemo(() => ({ invoke }), [invoke]);
}
