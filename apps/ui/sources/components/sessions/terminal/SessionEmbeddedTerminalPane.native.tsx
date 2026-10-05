import * as React from 'react';
import { View } from 'react-native';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane.native';

import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from './embeddedTerminalDocking';
import { useSessionTerminalIdentity, type SessionTerminalIdentity } from './sessionTerminalMode';
import { useSessionEmbeddedTerminalPaneModel, type SessionEmbeddedTerminalPaneProps } from './useSessionEmbeddedTerminalPaneModel';

export const SessionEmbeddedTerminalPane = React.memo(function SessionEmbeddedTerminalPaneNative(props: SessionEmbeddedTerminalPaneProps) {
    const terminalIdentity = useSessionTerminalIdentity({
        ...props,
        terminalInstanceId: props.currentDockLocation === 'details'
            ? props.terminalInstanceId ?? SESSION_PRIMARY_TERMINAL_INSTANCE_ID
            : props.terminalInstanceId,
    });
    return <SessionEmbeddedTerminalPaneContent key={terminalIdentity.terminalKey} {...props} terminalIdentity={terminalIdentity} />;
});

const SessionEmbeddedTerminalPaneContent = React.memo(function SessionEmbeddedTerminalPaneContent(props: SessionEmbeddedTerminalPaneProps & Readonly<{ terminalIdentity: SessionTerminalIdentity }>) {
    const model = useSessionEmbeddedTerminalPaneModel(props);
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={model.title}
                focused={props.focused}
                findSurfaceId={model.findSurfaceId}
                chrome={props.chrome}
                machineName={props.machineName}
                controller={model.controller}
                terminalRef={model.terminalRendererRef}
                onRequestClose={props.onRequestClose}
                testIdPrefix={model.testIdPrefix}
                nativeSurfaceKey={model.terminalKey}
                toolbarActionsStart={model.toolbarActionsStart}
            />
        </View>
    );
});

export default SessionEmbeddedTerminalPane;
