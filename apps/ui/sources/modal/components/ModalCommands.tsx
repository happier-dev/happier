import * as React from 'react';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { BaseModalConfig } from '../types';

type ModalCommandInvocation = (key: string, input?: PluginUiJsonValueV1) => unknown;
type ModalCommandsProps = Readonly<{
    bridge?: BaseModalConfig['commandBridge'];
    commands: readonly CurrentUiContextLocalCommand[];
    children: (invoke: ModalCommandInvocation) => React.ReactNode;
}>;

/** Opted-in dialogs borrow the opener's existing command owner for their entire rendered surface. */
export function ModalCommands({ bridge: Bridge, ...props }: ModalCommandsProps): React.ReactNode {
    const content = <UnscopedModalCommands {...props} />;
    if (!Bridge) return content;
    // Ordinary wrapping bridges retain their children; the captured command bridge mounts the same controls
    // with its own invocation owner instead. Unscoped dialogs do not import the Action execution graph.
    return <Bridge modalCommands={{ commands: props.commands, render: props.children }}>{content}</Bridge>;
}

function UnscopedModalCommands(props: Omit<ModalCommandsProps, 'bridge'>): React.ReactNode {
    return props.children((key, input) => props.commands.find(command => command.key === key)?.invoke(input));
}
