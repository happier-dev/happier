import * as React from 'react';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

export type SelectionListCommandInvoke = ReturnType<typeof useCurrentUiContextLocalCommands>['invoke'];
export const SelectionListActivationCommandContext = React.createContext<((id: string) => void) | null>(null);

/** Only opted-in choosers publish mounted commands; the list keeps its existing handlers. */
export function SelectionListCommandHost(props: Readonly<{
    commands: readonly CurrentUiContextLocalCommand[];
    contextKey: string;
    invokeRef: React.RefObject<SelectionListCommandInvoke | null>;
}>) {
    const commands = useCurrentUiContextLocalCommands(props.commands, { contextKey: props.contextKey });
    React.useLayoutEffect(() => {
        props.invokeRef.current = commands.invoke;
        return () => { props.invokeRef.current = null; };
    }, [commands.invoke, props.invokeRef]);
    return null;
}
