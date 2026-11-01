import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { resolveTerminalErrorCopy } from '@/components/sessions/terminal/terminalErrorCopy';
import { SurfaceFreshnessLine, type SurfaceFreshnessAction } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { describeActionOperationStatusLabel } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { embeddedTerminalPaneStyles } from './embeddedTerminalPaneStyles';
import type { EmbeddedTerminalPaneController } from './types';
import { Icon } from '@/components/ui/icons/Icon';

export type EmbeddedTerminalPaneFrameProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    surface: React.ReactNode;
    footer?: React.ReactNode;
    keyboardBottomInset?: number;
    onRequestClose?: (() => void) | null;
    onPaste?: (() => void) | null;
    onCopySelection?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    testIdPrefix?: string | null;
    platformOS?: 'web' | 'ios' | 'android';
    /**
     * `toolbar` (default): the frame carries its own title row and address banner. `none`: an owning
     * strip (the session bottom pane, the phone Terminal page) shows the tabs, the live address pill
     * and the verbs, so the frame is the terminal body and its states alone (terminal lab B1/L).
     */
    chrome?: 'toolbar' | 'none';
    /** The machine the terminal runs on, so an offline line can name it. */
    machineName?: string | null;
    /**
     * The owner already states how the process ended (a run's status line), so the frame leaves its
     * own "exited" line out; every other state line still shows.
     */
    ownerStatesExit?: boolean;
    /**
     * Height in px the retained output needs. When given, the terminal hugs it (and gives way to its
     * parent's bound) instead of filling the parent; the renderer reports it.
     */
    contentHeight?: number | null;
}>;

const MACHINE_UNREACHABLE_ERROR = 'terminal_machine_unreachable';

type TerminalFrameState =
    | Readonly<{ kind: 'live' }>
    | Readonly<{ kind: 'not-open' }>
    | Readonly<{ kind: 'line'; reason: string; busy?: boolean; tone?: 'neutral' | 'warning'; action?: Readonly<{ label: string; onPress: () => void }>; actions?: readonly SurfaceFreshnessAction[] }>
    | Readonly<{ kind: 'failed'; title: string; reason: string; code: string | null }>;

/**
 * Terminal lab ST: the output the person had stays readable through every state except a terminal
 * that never started. Connecting, an exited process and an offline machine are one quiet line over the
 * retained output with one recovery; only a start failure covers the body, with its cause.
 */
function resolveTerminalFrameState(props: EmbeddedTerminalPaneFrameProps): TerminalFrameState {
    const { controller } = props;
    if (controller.inputRecoveryAvailable && !controller.readOnly) return {
        kind: 'line', tone: 'warning', reason: t('terminalEmbedded.inputRecovery'),
        actions: [
            { label: t('common.copy'), onPress: () => { void controller.copyInputRecovery?.(); },
                testID: props.testIdPrefix ? `${props.testIdPrefix}-recover-input` : undefined },
            { label: t('common.discard'), onPress: () => controller.discardInputRecovery?.(),
                testID: props.testIdPrefix ? `${props.testIdPrefix}-discard-input` : undefined },
        ],
    };
    // Consent is asked before any PTY exists: the shell is `not-open` (or just starting), and the line
    // says it is waiting on the person. Only the Approvals shortcut needs the owner's callback.
    if (controller.approvalPending && (controller.status === 'not-open' || controller.status === 'idle' || controller.status === 'connecting')) {
        return { kind: 'line', reason: t('approvals.waitingForYou'),
            ...(controller.onOpenApproval ? { action: { label: t('approvals.title'), onPress: controller.onOpenApproval } } : {}) };
    }
    switch (controller.status) {
        case 'connected': return { kind: 'live' };
        case 'not-open': return { kind: 'not-open' };
        case 'idle':
        case 'connecting': return { kind: 'line', reason: t('terminalWorkspace.states.connecting'), busy: true };
        case 'exited': {
            // A native step may exit before its operation settles, including a Stop
            // requested on another device. Only that owner can establish its outcome.
            const operationActive = controller.operationState === 'accepted' || controller.operationState === 'running';
            if (controller.operationStopPending && (operationActive || controller.operationState == null)) return {
                kind: 'line', reason: t('projects.scripts.run.stopping'),
            };
            if (operationActive) return {
                kind: 'line',
                reason: describeActionOperationStatusLabel({ kind: 'host', value: controller.operationState }),
            };
            return {
                kind: 'line',
                // Native PTYs may pair a signal with a placeholder zero exit code. A signal
                // establishes termination; it must not be presented as a successful exit.
                reason: controller.operationState === 'cancelled' || controller.exitSignal != null && controller.exitSignal !== 0
                    ? joinHappierFacts(props.title, t('localServices.rowStatus.stopped'))
                    : joinHappierFacts(t('terminalWorkspace.states.exited', { title: props.title }),
                        controller.exitCode == null ? null : `${t('tools.structuredResult.exit')}: ${controller.exitCode}`),
                // A borrowed view cannot restart a process it does not own.
                ...(controller.readOnly ? {} : { action: { label: t('terminalWorkspace.states.restart'), onPress: () => controller.requestRestart() } }),
            };
        }
        case 'error': {
            if (controller.error === MACHINE_UNREACHABLE_ERROR) {
                return {
                    kind: 'line',
                    tone: 'warning',
                    reason: props.machineName
                        ? t('terminalWorkspace.states.offline', { machine: props.machineName })
                        : t('terminalEmbedded.errors.machineUnreachable'),
                    action: { label: t('terminalWorkspace.states.checkAgain'), onPress: controller.retryConnect },
                };
            }
            const copy = resolveTerminalErrorCopy(controller.error);
            // An attached terminal already exists even if this view's first read
            // failed. Keep its surface and retry only the attachment.
            if (controller.connectionLost || controller.readOnly) {
                return {
                    kind: 'line',
                    tone: 'warning',
                    reason: copy ? t(copy.bodyKey) : controller.readOnly ? t('machines.terminals.unavailable')
                        : t('terminalWorkspace.states.connectionLost', { title: props.title }),
                    action: { label: t('terminalWorkspace.states.reconnect'), onPress: controller.retryConnect },
                };
            }
            return {
                kind: 'failed',
                title: t('terminalWorkspace.states.failedTitle', { title: props.title }),
                reason: copy ? t(copy.bodyKey) : t('errors.tryAgain'),
                code: controller.error,
            };
        }
    }
}

/**
 * Typing keys belong to a terminal that is live or on its way; not-open, exited and failed terminals
 * have no process to receive them, so the phone key rail and arrow pad stay away.
 */
/** Whether the phone key rail and arrow pad are offered: a writable terminal that is open or opening. */
export function terminalAcceptsKeys(controller: Pick<EmbeddedTerminalPaneController, 'status' | 'readOnly' | 'inputRecoveryAvailable'>): boolean {
    if (controller.readOnly || controller.inputRecoveryAvailable) return false;
    return controller.status === 'idle' || controller.status === 'connecting' || controller.status === 'connected';
}

function resolveKeyboardBottomInset(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

export const EmbeddedTerminalPaneFrame = React.memo(function EmbeddedTerminalPaneFrame(props: EmbeddedTerminalPaneFrameProps) {
    const { theme } = useUnistyles();
    const styles = embeddedTerminalPaneStyles;
    const keyboardBottomInset = props.platformOS === 'android'
        ? 0
        : resolveKeyboardBottomInset(props.keyboardBottomInset);
    // The keyboard inset belongs to whatever sits last above the keyboard: the footer (the phone key
    // rail, full width) when there is one, else the terminal surface.
    const keyboardInsetStyle = keyboardBottomInset > 0 ? { marginBottom: keyboardBottomInset } : null;
    const terminalSurfaceStyle = keyboardInsetStyle && !props.footer
        ? [styles.terminalSurface, keyboardInsetStyle]
        : styles.terminalSurface;

    const testId = React.useCallback(
        (suffix: string) => (props.testIdPrefix ? `${props.testIdPrefix}-${suffix}` : undefined),
        [props.testIdPrefix],
    );

    const onCopyUrl = React.useCallback(() => {
        const url = props.controller.detectedUrl?.url ?? '';
        if (!url) return;
        void setClipboardStringSafe(url);
    }, [props.controller.detectedUrl?.url]);

    const onOpenUrl = React.useCallback(() => {
        const url = props.controller.detectedUrl?.url ?? '';
        if (!url) return;
        void openExternalUrl(url, props.platformOS === 'web' ? { platformOS: 'web' } : undefined);
    }, [props.controller.detectedUrl?.url, props.platformOS]);

    const frameState = resolveTerminalFrameState(props);
    // A state card that covers the body leaves nothing to read: the renderer stays mounted (it sizes the
    // terminal) but is not seen, so its cursor never shows through a clear content coat.
    const surfaceCovered = frameState.kind === 'failed' || frameState.kind === 'not-open';
    const showsOwnChrome = props.chrome !== 'none';
    const readOnly = props.controller.readOnly === true;
    const hidesExitLine = props.ownerStatesExit === true && props.controller.status === 'exited' && !props.controller.inputRecoveryAvailable;
    const hugsContent = typeof props.contentHeight === 'number';

    return (
        <View testID={testId('root')} style={styles.container}>
            {showsOwnChrome && (!readOnly || props.toolbarActionsStart || props.onRequestClose) ? (
                <View style={readOnly ? styles.toolbarReadOnly : styles.toolbar}>
                    {readOnly ? null : (
                        <View style={styles.toolbarLeft}>
                            <Icon name="terminal" size={16} color={theme.colors.text.secondary} />
                            <Text style={styles.toolbarTitle} numberOfLines={1}>
                                {props.title}
                            </Text>
                        </View>
                    )}
                    <View style={styles.toolbarRight}>
                        {props.toolbarActionsStart}
                        {/* A borrowed output has one copy (its owner's whole-output copy) and nothing that types, resets or restarts. */}
                        {!readOnly && props.onCopySelection ? (
                            <IconButton
                                testID={testId('copy-selection')}
                                iconName="copy"
                                accessibilityLabel={t('common.copy')}
                                tooltip={t('common.copy')}
                                variant="plain"
                                size={28}
                                iconSize={18}
                                onPress={props.onCopySelection}
                            />
                        ) : null}
                        {!readOnly && props.onPaste ? (
                            <IconButton
                                testID={testId('paste')}
                                iconName="clipboard"
                                accessibilityLabel={t('common.paste')}
                                tooltip={t('common.paste')}
                                variant="plain"
                                size={28}
                                iconSize={18}
                                onPress={props.onPaste}
                            />
                        ) : null}
                        {readOnly ? null : (
                            <>
                                <IconButton
                                    testID={testId('clear')}
                                    iconName="trash"
                                    accessibilityLabel={t('common.reset')}
                                    tooltip={t('common.reset')}
                                    variant="plain"
                                    size={28}
                                    iconSize={18}
                                    onPress={props.controller.clearTerminal}
                                />
                                <IconButton
                                    testID={testId('restart')}
                                    iconName="arrow-clockwise"
                                    accessibilityLabel={t('common.refresh')}
                                    tooltip={t('common.refresh')}
                                    variant="plain"
                                    size={28}
                                    iconSize={18}
                                    onPress={() => props.controller.requestRestart()}
                                />
                            </>
                        )}
                        {props.onRequestClose ? (
                            <IconButton
                                testID={testId('close')}
                                iconName="x"
                                accessibilityLabel={t('common.close')}
                                tooltip={t('common.close')}
                                variant="plain"
                                size={28}
                                iconSize={18}
                                onPress={props.onRequestClose}
                            />
                        ) : null}
                    </View>
                </View>
            ) : null}

            {showsOwnChrome && props.controller.detectedUrl?.url ? (
                <View testID={testId('url-banner')} style={styles.banner}>
                    <Text style={styles.bannerUrl} numberOfLines={1}>
                        {props.controller.detectedUrl.url}
                    </Text>
                    <View style={styles.bannerActions}>
                        <PrimaryCircleIconButton
                            active={false}
                            testID={testId('url-copy')}
                            accessibilityLabel={t('common.copy')}
                            onPress={onCopyUrl}
                        >
                            <Icon name="copy" size={16} color={theme.colors.text.primary} />
                        </PrimaryCircleIconButton>
                        <PrimaryCircleIconButton
                            active={false}
                            testID={testId('url-open')}
                            accessibilityLabel={t('common.open')}
                            onPress={onOpenUrl}
                        >
                            <Icon name="arrow-square-out" size={16} color={theme.colors.text.primary} />
                        </PrimaryCircleIconButton>
                        <PrimaryCircleIconButton
                            active={false}
                            testID={testId('url-dismiss')}
                            accessibilityLabel={t('common.close')}
                            onPress={props.controller.dismissDetectedUrl}
                        >
                            <Icon name="x" size={16} color={theme.colors.text.primary} />
                        </PrimaryCircleIconButton>
                    </View>
                </View>
            ) : null}

            {readOnly && props.controller.outputRetention?.truncated ? (
                <SurfaceFreshnessLine testID={testId('retained-notice')} reason={t('projects.scripts.output.earlierNotKept')} />
            ) : null}

            {frameState.kind === 'line' && !hidesExitLine ? (
                <SurfaceFreshnessLine
                    testID={testId('state-line')}
                    reason={frameState.reason}
                    busy={frameState.busy}
                    tone={frameState.tone}
                    action={frameState.action}
                    actions={frameState.actions}
                />
            ) : null}

            <View testID={testId('surface')} style={hugsContent ? [terminalSurfaceStyle, styles.hugging] : terminalSurfaceStyle}>
                <View testID={testId('renderer')} pointerEvents={surfaceCovered ? 'none' : 'auto'}
                    accessibilityElementsHidden={surfaceCovered} importantForAccessibility={surfaceCovered ? 'no-hide-descendants' : 'auto'}
                    style={hugsContent
                        ? [surfaceCovered ? styles.rendererCovered : styles.renderer, styles.hugging, { flexBasis: props.contentHeight }]
                        : surfaceCovered ? styles.rendererCovered : styles.renderer}>
                    {props.surface}
                </View>
                {surfaceCovered ? (
                    <View testID={testId('overlay')} style={styles.overlay} pointerEvents="auto">
                        <SurfaceStateCard
                            testID={testId('state-card')}
                            kind={frameState.kind === 'not-open' ? 'empty' : 'error'}
                            scene={frameState.kind === 'not-open' ? 'noTerminal' : undefined}
                            title={frameState.kind === 'not-open' ? t('terminalWorkspace.states.notOpen') : frameState.title}
                            reason={frameState.kind === 'failed' ? frameState.reason : undefined}
                            diagnosticCode={frameState.kind === 'failed' ? frameState.code : undefined}
                            action={{ label: t(frameState.kind === 'not-open' ? 'common.open' : 'terminalWorkspace.states.tryAgain'), onPress: props.controller.retryConnect, testID: testId('retry') }}
                        />
                    </View>
                ) : null}
            </View>
            {props.footer ? (
                <View testID={testId('footer')} style={keyboardInsetStyle}>
                    {props.footer}
                </View>
            ) : null}
        </View>
    );
});
