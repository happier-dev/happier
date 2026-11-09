import type { ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { Command } from './types';

type CommandPaletteAction = NonNullable<ActionExecutorDeps['uiCommandPaletteAction']>;
type CommandPaletteActionRequest = Parameters<CommandPaletteAction>[0];

let mountedCatalog: (() => readonly Command[]) | null = null;

/** Binds the existing command builder for this shell's mounted lifetime. */
export function registerCommandPaletteActionCatalog(buildCommands: () => readonly Command[]): () => void {
    mountedCatalog = buildCommands;
    return () => {
        if (mountedCatalog === buildCommands) mountedCatalog = null;
    };
}

/** Re-resolve every command at invocation time; never retain an obsolete callback. */
export async function executeCommandPaletteAction(request: CommandPaletteActionRequest): Promise<ActionExecuteResult> {
    if (request.context.signal?.aborted || !mountedCatalog) {
        return { ok: false, errorCode: 'unsupported_action', error: 'command_palette_not_mounted' };
    }
    const catalog = mountedCatalog;
    const commands = catalog().filter((command) => command.actionSpecId === undefined);
    if (request.actionId === 'ui.command_palette.list') {
        return {
            ok: true,
            result: {
                commands: commands.map(({ id, title, subtitle, category }) => ({
                    id, title,
                    ...(subtitle === undefined ? {} : { subtitle }),
                    ...(category === undefined ? {} : { category }),
                })),
            },
        };
    }
    const input = request.input as Readonly<{ commandId: string }>;
    const command = commands.find((entry) => entry.id === input.commandId);
    if (!command || catalog !== mountedCatalog || request.context.signal?.aborted) {
        return { ok: false, errorCode: 'unsupported_action', error: 'command_palette_entry_unavailable' };
    }
    await command.action();
    return { ok: true, result: { invoked: true } };
}
