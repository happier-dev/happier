import * as React from 'react';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol';
import { View } from 'react-native';

import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import type { EmbeddedTerminalDockLocation } from './embeddedTerminalDocking';
import type { SessionTerminalIdentity, SessionTerminalMode } from './sessionTerminalMode';
import { publishTerminalSurfaceSummary } from './terminalSurfaceSummary';
import { createSessionTerminalLeafHandles } from './strip/sessionTerminalLeafHandles';
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
        terminalMode,
        terminalTarget: props.terminalIdentity.terminalTarget,
        available: props.terminalIdentity.available,
        terminalRef: terminalRendererRef,
    });

    // A bell asks for attention only when it rings in a view nobody is looking at.
    const bellSeenRef = React.useRef<string | null>(controller.terminalBell ?? null);
    if (props.focused) bellSeenRef.current = controller.terminalBell ?? null;
    const unseenBell = controller.terminalBell && controller.terminalBell !== bellSeenRef.current ? controller.terminalBell : null;
    const detectedUrl = controller.detectedUrl?.url ?? null;
    React.useEffect(() => {
        publishTerminalSurfaceSummary(terminalKey, {
            title: controller.terminalTitle ?? null,
            bell: unseenBell,
            status: controller.status,
            error: controller.status === 'error' ? controller.error : null,
            url: detectedUrl,
        });
    }, [controller.error, controller.status, controller.terminalTitle, detectedUrl, terminalKey, unseenBell]);

    // The pane's tab menu reaches this view's own verbs while it is mounted.
    const leafHandles = React.useMemo(() => createSessionTerminalLeafHandles(props.scopeId), [props.scopeId]);
    const findRuntime = useFindSurfaceRuntime();
    const mountedFindId = React.useId();
    const findSurfaceId = `terminal:${terminalKey}:${mountedFindId}`;
    const findEligible = usePluginSurfaceFocusEligibility() && props.focused !== false;
    const terminalId = props.terminalIdentity.terminalId;
    const { clearTerminal, requestRestart, copySelection, onPaste } = controller;
    React.useEffect(() => {
        if (!terminalId || !props.terminalIdentity.available) return;
        return leafHandles.register(terminalId, {
            get find() { return findEligible && terminalRendererRef.current?.find
                ? () => { findRuntime.open(findSurfaceId); } : null; },
            copySelection: copySelection ? () => copySelection() : null,
            paste: () => { void getClipboardStringTrimmedSafe().then((text) => { if (text) void onPaste(text); }); },
            clear: clearTerminal,
            restart: requestRestart,
        });
    }, [clearTerminal, copySelection, findEligible, findRuntime, findSurfaceId, leafHandles, onPaste, props.terminalIdentity.available, requestRestart, terminalId]);

    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const restartFromSurface = React.useCallback(() => {
        if (!terminalId) return;
        void execute('session.terminals.restart', { scopeId: props.scopeId, terminalId }, {
            surface: 'ui', defaultSessionId: props.sessionId, serverId: serverId ?? undefined,
        });
    }, [execute, props.scopeId, props.sessionId, serverId, terminalId]);
    // Keep the registered worker handle raw; the toolbar is an Action caller, not another restart owner.
    const surfaceController = React.useMemo(() => ({ ...controller, requestRestart: restartFromSurface }), [controller, restartFromSurface]);

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
