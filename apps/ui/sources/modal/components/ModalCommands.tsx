import * as React from 'react';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { BaseModalConfig } from '../types';

type ModalCommandInvocation = (key: string, input?: PluginUiJsonValueV1) => unknown;
type ModalCommandsProps = Readonly<{
    bridge?: BaseModalConfig['commandBridge'];
    commands: readonly CurrentUiContextLocalCommand[];
    children: (invoke: ModalCommandInvocation) => React.ReactNode;
}>;

/** Opted-in dialogs borrow the opener's existing command owner for their entire rendered surface. */
export function ModalCommands({ bridge: Bridge, ...props }: ModalCommandsProps): React.ReactNode {
    if (!Bridge) return props.children((key, input) => props.commands.find(command => command.key === key)?.invoke(input));
    return <Bridge><MountedModalCommands {...props} /></Bridge>;
}

function MountedModalCommands(props: Omit<ModalCommandsProps, 'bridge'>): React.ReactNode {
    const commands = useCurrentUiContextLocalCommands(props.commands, { foregroundOverlay: true });
    return props.children(commands.invoke);
}
