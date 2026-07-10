export type CommandDaemonAutostartDefault = 'preferLocalTui';

export type CommandDispatchPolicy = Readonly<{
    daemonAutostartDefault?: CommandDaemonAutostartDefault;
}>;

export type CommandDispatchDescriptor<THandler> = Readonly<{
    id: string;
    command: string;
    handler: THandler;
    policy?: CommandDispatchPolicy;
}>;

export type CommandDispatchRegistry<THandler> = Readonly<{
    commands: readonly CommandDispatchDescriptor<THandler>[];
    findByCommand(command: string): CommandDispatchDescriptor<THandler> | null;
}>;

export type CommandSurfaceVisibility = 'default' | 'advanced' | 'internal';

export type CommandSurfaceDescriptor = Readonly<{
    id: string;
    command: string | null;
    rootHelpLabel?: string;
    rootHelpDescription?: string;
    rootHelpDetail?: string;
    allowTmux: boolean;
    visibility?: CommandSurfaceVisibility;
    featureGate?: string;
}>;

export type CommandSurfaceDescriptorInput = Readonly<
    Omit<CommandSurfaceDescriptor, 'id'> & {
        id?: string;
    }
>;

export type CommandSurfaceCatalog = Readonly<{
    commands: readonly CommandSurfaceDescriptor[];
    findByCommand(command: string): CommandSurfaceDescriptor | null;
}>;

function normalizeCommandSurfaceId(entry: CommandSurfaceDescriptorInput): string {
    const explicitId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (explicitId.length > 0) {
        return explicitId;
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    return command.length > 0 ? command : '__default__';
}

export function createCommandDispatchRegistry<THandler>(
    commands: readonly CommandDispatchDescriptor<THandler>[],
): CommandDispatchRegistry<THandler> {
    const frozenCommands = Object.freeze([...commands]);
    return Object.freeze({
        commands: frozenCommands,
        findByCommand(command: string): CommandDispatchDescriptor<THandler> | null {
            return frozenCommands.find((entry) => entry.command === command) ?? null;
        },
    });
}

export function createCommandSurfaceCatalog(
    commands: readonly CommandSurfaceDescriptorInput[],
): CommandSurfaceCatalog {
    const normalizedCommands = Object.freeze(
        commands.map((entry) => Object.freeze({
            ...entry,
            id: normalizeCommandSurfaceId(entry),
        })),
    ) as readonly CommandSurfaceDescriptor[];

    return Object.freeze({
        commands: normalizedCommands,
        findByCommand(command: string): CommandSurfaceDescriptor | null {
            return normalizedCommands.find((entry) => entry.command === command) ?? null;
        },
    });
}
