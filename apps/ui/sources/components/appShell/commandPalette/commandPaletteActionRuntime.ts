import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { Command } from './types';
import type { KeyboardCommandId } from '@/keyboard/types';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { alertActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { fireAndForget } from '@/utils/system/fireAndForget';

type CommandPaletteAction = NonNullable<ActionExecutorDeps['uiCommandPaletteAction']>;
type CommandPaletteActionRequest = Parameters<CommandPaletteAction>[0];

let mountedCatalog: Readonly<{
    read: () => readonly Command[];
    prepareSessionCommands?: () => (() => void) | Promise<() => void>;
}> | null = null;

/** Binds the existing command builder for this shell's mounted lifetime. */
export function registerCommandPaletteActionCatalog(buildCommands: () => readonly Command[], prepareSessionCommands?: () => (() => void) | Promise<() => void>): () => void {
    const catalog = { read: buildCommands, prepareSessionCommands };
    mountedCatalog = catalog;
    return () => {
        if (mountedCatalog === catalog) mountedCatalog = null;
    };
}

/** A bound shortcut consumes the same current command and UI invocation as its palette row. */
export function executeCommandPaletteKeyboardCommand(commandId: KeyboardCommandId): 'handled' | 'pass' {
    const catalog = mountedCatalog;
    const actionId = commandId.startsWith('action:') ? commandId.slice('action:'.length) : null;
    const pluginIdentity = actionId ? parseQualifiedPluginActionId(actionId) : null;
    const actionSpecId = pluginIdentity ? buildQualifiedPluginContributionKey(pluginIdentity) : actionId;
    const find = () => {
        const commands = catalog?.read();
        return commands?.find(entry => entry.id === commandId)
            ?? (actionSpecId ? commands?.find(entry => entry.actionSpecId === actionSpecId
                || entry.id === `plugin-action:${actionSpecId}`) : undefined);
    };
    const command = find();
    if (!command && commandId.startsWith('session.action:') && catalog?.prepareSessionCommands) {
        const prepared = catalog.prepareSessionCommands();
        const invokePrepared = async (release: () => void) => {
            try {
                if (mountedCatalog !== catalog) return;
                const current = find();
                if (!current) {
                    alertActionExecutionFailure({ ok: false, errorCode: 'unsupported_action', error: 'command_palette_entry_unavailable' });
                    return;
                }
                await current.action();
            } finally { release(); }
        };
        if (typeof prepared === 'function') {
            if (!find()) { prepared(); return 'pass'; }
            fireAndForget(invokePrepared(prepared), { tag: 'CommandPalette.keyboard.session' });
        } else {
            fireAndForget(prepared.then(invokePrepared), { tag: 'CommandPalette.keyboard.session' });
        }
        return 'handled';
    }
    if (!command) return 'pass';
    fireAndForget(Promise.resolve().then(() => command.action()), { tag: 'CommandPalette.keyboard' });
    return 'handled';
}

/** Re-resolve every command at invocation time; never retain an obsolete callback. */
export async function executeCommandPaletteAction(request: CommandPaletteActionRequest): Promise<ActionExecuteResult> {
    if (request.context.signal?.aborted || !mountedCatalog) {
        return { ok: false, errorCode: 'unsupported_action', error: 'command_palette_not_mounted' };
    }
    const catalog = mountedCatalog;
    const commands = catalog.read().filter((command) => command.actionSpecId === undefined
        || (command.invokeAction !== undefined && request.context.executeOrdinaryChildAction !== undefined));
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
    if (command.invokeAction) {
        const outcome = await command.invokeAction(request.context);
        if (!outcome.ok || ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result).success) return outcome;
        return { ...outcome, result: { invoked: true } };
    }
    await command.action();
    return { ok: true, result: { invoked: true } };
}
