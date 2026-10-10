import * as React from 'react';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol';
import { View } from 'react-native';

import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import { useEmbeddedTerminalPresentation } from '@/components/terminal/embedded/useEmbeddedTerminalPresentation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import type { EmbeddedTerminalDockLocation } from './embeddedTerminalDocking';
import type { SessionTerminalIdentity, SessionTerminalMode } from './sessionTerminalMode';
import { useSessionEmbeddedTerminalPty } from './useSessionEmbeddedTerminalPty';

export type SessionEmbeddedTerminalPaneProps = Readonly<{
    sessionId: string;
    scopeId: string;
    currentDockLocation: EmbeddedTerminalDockLocation;
    terminalInstanceId?: string;
    onOpenNewTerminalTab?: (() => void) | null;
    onRequestClose?: () => void;
    testIdPrefix?: string | null;
    terminalMode?: SessionTerminalMode;
    terminal?: SessionTerminalMemberV1;
    /**
     * `toolbar` (default): the frame's own title row (a Details tab, the legacy sidebar). `none`: the
     * session bottom pane's strip or the phone Terminal page owns the tabs, verbs and address pill.
     */
    chrome?: 'toolbar' | 'none';
    /** What the terminal is called where it is shown (the strip's tab title); falls back to "Terminal". */
    title?: string;
    /** The machine it runs on, so an offline line names it. */
    machineName?: string | null;
    /** This view is the focused member of the visible tab: a bell it shows is already seen. */
    focused?: boolean;
}>;

/**
 * The one model behind the web and native session terminal leaves: identity, the PTY controller, the
 * frame's title and actions, and the last-known summary the strip, list view and Jump read for this
 * terminal (`terminalSurfaceSummary`). The platform files only choose the renderer.
 */
export function useSessionEmbeddedTerminalPaneModel(props: SessionEmbeddedTerminalPaneProps & Readonly<{ terminalIdentity: SessionTerminalIdentity }>) {
    const testIdPrefix = props.testIdPrefix === undefined ? 'session-embedded-terminal' : props.testIdPrefix;
    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const { serverId, terminalMode, terminalKey } = props.terminalIdentity;

    const controller = useSessionEmbeddedTerminalPty({
        sessionId: props.sessionId,
        serverId,
        terminalKey,
        scopeId: props.scopeId,
        memberId: props.terminalIdentity.terminalId ?? (terminalMode === 'session_attach' ? 'session-attach' : 'embedded'),
        terminalMode,
        terminalTarget: props.terminalIdentity.terminalTarget,
        available: props.terminalIdentity.available,
        terminalRef: terminalRendererRef,
    });

    const terminalId = props.terminalIdentity.terminalId;
    const { findSurfaceId, onOpenApproval } = useEmbeddedTerminalPresentation({ scopeId: props.scopeId, terminalKey,
        terminalId, available: props.terminalIdentity.available, focused: props.focused, controller, terminalRef: terminalRendererRef });

    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const restartFromSurface = React.useCallback(() => {
        if (!terminalId) return;
        void execute('session.terminals.restart', { scopeId: props.scopeId, terminalId }, {
            surface: 'ui', defaultSessionId: props.sessionId, serverId: serverId ?? undefined,
        });
    }, [execute, props.scopeId, props.sessionId, serverId, terminalId]);
    // Keep the registered worker handle raw; the toolbar is an Action caller, not another restart owner.
    const surfaceController = React.useMemo(() => ({ ...controller, requestRestart: restartFromSurface, onOpenApproval }), [controller, restartFromSurface, onOpenApproval]);

    const toolbarActionsStart = React.useMemo(() => (props.onOpenNewTerminalTab ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconButton
                testID={testIdPrefix ? `${testIdPrefix}-new-tab` : undefined}
                iconName="plus"
                accessibilityLabel={t('terminalEmbedded.openNewTabA11y')}
                tooltip={t('terminalEmbedded.openNewTabA11y')}
                variant="plain"
                size={28}
                iconSize={18}
                onPress={props.onOpenNewTerminalTab}
            />
        </View>
    ) : null), [props.onOpenNewTerminalTab, testIdPrefix]);

    return {
        controller: surfaceController,
        terminalRendererRef,
        findSurfaceId,
        terminalKey,
        testIdPrefix,
        title: props.title ?? t('settings.terminal'),
        toolbarActionsStart,
    };
}
