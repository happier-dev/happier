import * as React from 'react';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { CurrentUiContextMountedEnrichment, CurrentUiContextMountedCommand } from './currentUiContextModel';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useOptionalCurrentUiContextReader } from './CurrentUiContextProvider';
import { executeMountedCurrentUiContextCommand } from './currentUiContextActionRuntime';

export type CurrentUiContextLocalCommand = Readonly<{
    key: string;
    title: string;
    description?: string;
    setting?: Extract<CurrentUiContextMountedCommand, { kind: 'hostLocal' }>['setting'];
    invoke(): boolean | void | Promise<boolean | void>;
}>;

type ComposedCommands = NonNullable<CurrentUiContextMountedEnrichment['commands']>;
type CommandComposition = Readonly<{
    authority: ServerAccountScopeLifetime | null;
    isCurrent(): boolean;
    register(owner: object, commands: ComposedCommands): () => void;
}>;
const EMPTY_COMMANDS: ComposedCommands = Object.freeze([]);
const CompositionContext = React.createContext<CommandComposition | null>(null);
const CommandsContext = React.createContext<ComposedCommands>(EMPTY_COMMANDS);

/** React composition only: the existing current-context publisher retains the sole command record. */
export function CurrentUiContextCommandsProvider(props: Readonly<{
    authority: ServerAccountScopeLifetime | null;
    active?: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const [entries, setEntries] = React.useState<readonly Readonly<{ owner: object; commands: ComposedCommands }>[]>([]);
    const latest = React.useRef(props);
    latest.current = props;
    const mounted = React.useRef(true);
    React.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const register = React.useCallback((owner: object, commands: ComposedCommands) => {
        setEntries(current => [...current.filter(entry => entry.owner !== owner), { owner, commands }]);
        return () => setEntries(current => current.filter(entry => entry.owner !== owner));
    }, []);
    const composition = React.useMemo<CommandComposition>(() => ({
        authority: props.authority,
        isCurrent: () => mounted.current && latest.current.active !== false
            && latest.current.authority === props.authority && props.authority?.isCurrent() === true,
        register,
    }), [props.authority, register]);
    const [retired, setRetired] = React.useState<ServerAccountScopeLifetime | null>(null);
    React.useLayoutEffect(() => {
        const authority = props.authority;
        if (!authority) return;
        const subscription = authority.onRetire(() => setRetired(authority));
        return () => subscription.dispose();
    }, [props.authority]);
    const commands = React.useMemo(() => composition.isCurrent() && retired !== props.authority
        ? entries.flatMap(entry => entry.commands) : EMPTY_COMMANDS, [composition, entries, props.active, retired]);
    return <CompositionContext.Provider value={composition}>
        <CommandsContext.Provider value={commands}>{props.children}</CommandsContext.Provider>
    </CompositionContext.Provider>;
}

/** The page appends these definitions to its own enrichment; descendants never publish competing mounts. */
export function useCurrentUiContextComposedCommands(): ComposedCommands {
    return React.useContext(CommandsContext);
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
                invoke: async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
                    const current = latest.current.find(candidate => candidate.key === key);
                    if (signal.aborted || !lifetime.mounted || !isCurrent() || !current) {
                        return { ok: false as const, code: 'stale_surface' as const };
                    }
                    const applied = await current.invoke();
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

export function useCurrentUiContextLocalCommands(commands: readonly CurrentUiContextLocalCommand[], options?: Readonly<{ contextKey?: string }>): Readonly<{
    invoke(key: string): Promise<boolean>;
}> {
    const composition = React.useContext(CompositionContext);
    const reader = useOptionalCurrentUiContextReader();
    const { execute } = useMountedActionExecution(composition?.authority?.scope);
    const isCurrent = React.useCallback(() => composition?.isCurrent() === true, [composition]);
    const definitions = useCurrentUiContextLocalCommandDefinitions(commands, isCurrent, options?.contextKey);
    React.useLayoutEffect(() => {
        return composition?.register(definitions, definitions);
    }, [composition, definitions]);
    const invoke = React.useCallback(async (key: string): Promise<boolean> => {
        if (!composition?.isCurrent()) return false;
        const command = definitions.find(candidate => candidate.key === key)?.command;
        return (await executeMountedCurrentUiContextCommand({ reader, command, execute })).ok;
    }, [composition, definitions, execute, reader]);
    return React.useMemo(() => ({ invoke }), [invoke]);
}
