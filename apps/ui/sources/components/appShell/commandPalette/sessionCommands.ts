import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { executeMountedCurrentUiContextCommand } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { presentActionExecutionResult } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { getSessionActionMetadata } from '@/components/sessions/actions/sessionActionMetadata';
import { t } from '@/text';
import type { Command } from './types';

type SessionCommandParams = Readonly<{
    reader: CurrentUiContextReader | null;
    execute(actionId: 'ui.current_context.read' | 'ui.current_context.command.invoke', input: unknown): Promise<ActionExecuteResult>;
    shortcutLabels?: Readonly<Partial<Record<string, string>>>;
    contextCategory?: string;
}>;

export function buildSessionCommands(params: SessionCommandParams): Command[] {
    const reader = params.reader;
    if (!reader) return [];
    const commands = (reader.readCurrentUiContext()?.commands ?? []).flatMap(descriptor => {
        const resolved = reader.resolveCurrentUiCommand(descriptor.id);
        const command = resolved?.command;
        if (resolved?.retirementSignal.aborted || command?.kind !== 'hostLocal' || !command.key) return [];
        const id = command.key.startsWith('session.action:') ? command.key
            : command.key.startsWith('session.info.') ? `session.action:${command.key}` : null;
        if (!id) return [];
        const metadata = getSessionActionMetadata(id.slice('session.action:'.length));
        if (!metadata) return [];
        const invoke = async (execute: SessionCommandParams['execute']) => {
            // Search dismisses before activation. Follow the current-context owner's push until
            // this same mounted declaration returns to the page, or its presenter retires.
            await new Promise<void>(resolve => {
                let unsubscribe = () => {};
                const check = () => {
                    const snapshot = reader.readCurrentUiContext();
                    const available = snapshot?.commands.some(candidate => reader.resolveCurrentUiCommand(candidate.id)?.command === command);
                    if (available || command.isMounted?.() === false || snapshot?.navigation.area !== 'modal') { unsubscribe(); resolve(); }
                };
                unsubscribe = reader.subscribe(check);
                check();
            });
            return executeMountedCurrentUiContextCommand({ reader, command, execute });
        };
        return [{ id, actionSpecId: 'ui.current_context.command.invoke',
            title: descriptor.title, subtitle: descriptor.description, icon: metadata?.icon,
            shortcut: params.shortcutLabels?.[id], category: t('commandPalette.commands.actionsCategory'),
            ...(params.contextCategory ? { contextCategory: params.contextCategory } : {}),
            action: async () => { presentActionExecutionResult(await invoke(params.execute)); },
        }];
    });
    return [...new Map(commands.map(command => [command.id, command])).values()];
}

export type SessionCommandDemand = (() => void) & Readonly<{ setModalId(modalId: string | null | undefined): void }>;

/** Returns the same mounted source's withdrawal, including after its descriptors leave the snapshot. */
export function setSessionCommandPalettePresented(params: SessionCommandParams & Readonly<{ presented: boolean; modalId?: string | null }>): SessionCommandDemand {
    const reader = params.reader;
    const sources = reader?.readCurrentUiContext()?.commands.flatMap(descriptor => {
        const resolved = reader.resolveCurrentUiCommand(descriptor.id);
        const command = resolved?.command;
        return command?.kind === 'hostLocal' && command.key?.startsWith('session.') && command.setCommandPalettePresented
            ? [{ setPresented: command.setCommandPalettePresented }] : [];
    }) ?? [];
    if (!reader || sources.length === 0) return Object.assign(() => {}, { setModalId: () => {} });
    const release = Object.assign(() => { for (const source of sources) source.setPresented(false); }, {
        setModalId: (modalId: string | null | undefined) => { for (const source of sources) source.setPresented(true, modalId); },
    });
    if (!params.presented) { release(); return release; }
    for (const source of sources) source.setPresented(true, params.modalId);
    return release;
}
