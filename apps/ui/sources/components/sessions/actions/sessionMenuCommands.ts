import type { CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getSessionActionMetadata } from './sessionActionMetadata';

/** UI presenters retain their dialogs; automation must use caller-aware domain Actions. */
export function createUiSessionPresenterCommand(command: CurrentUiContextLocalCommand): CurrentUiContextLocalCommand {
    return { ...command, invoke: (input, context, invocation) => context.surface === 'ui'
        ? command.invoke(input, context, invocation)
        : { ok: false, code: 'unsupported_action' } };
}

export function buildSessionMenuCommands(params: Readonly<{
    items: readonly DropdownMenuItem[];
    select: (actionId: string) => void;
}>): CurrentUiContextLocalCommand[] {
    const commands: CurrentUiContextLocalCommand[] = [];
    const append = (items: readonly DropdownMenuItem[], parentTitle?: string) => {
        for (const item of items) {
            if (item.disabled) continue;
            const title = parentTitle ? `${parentTitle} · ${item.title}` : item.title;
            if (!getSessionActionMetadata(item.id)) {
                if (item.submenu) append(item.submenu.items, title);
            } else {
                commands.push(createUiSessionPresenterCommand({ key: `session.action:${item.id}`, title,
                    ...(item.subtitle ? { description: item.subtitle } : {}),
                    invoke: () => { params.select(item.id); } }));
            }
        }
    };
    append(params.items);
    return commands;
}
