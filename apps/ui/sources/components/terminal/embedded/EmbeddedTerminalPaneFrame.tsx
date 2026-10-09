import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { resolveTerminalErrorCopy } from '@/components/sessions/terminal/terminalErrorCopy';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
}>;

const MACHINE_UNREACHABLE_ERROR = 'terminal_machine_unreachable';

type TerminalFrameState =
    | Readonly<{ kind: 'live' }>
    | Readonly<{ kind: 'line'; reason: string; busy?: boolean; tone?: 'neutral' | 'warning'; action?: Readonly<{ label: string; onPress: () => void }> }>
    | Readonly<{ kind: 'failed'; title: string; reason: string; code: string | null }>;

/**
 * Terminal lab ST: the output the person had stays readable through every state except a terminal
 * that never started. Connecting, an exited process and an offline machine are one quiet line over the
 * retained output with one recovery; only a start failure covers the body, with its cause.
 */
function resolveTerminalFrameState(props: EmbeddedTerminalPaneFrameProps): TerminalFrameState {
    const { controller } = props;
    if (controller.approvalPending && controller.onOpenApproval && (controller.status === 'idle' || controller.status === 'connecting')) {
        return { kind: 'line', reason: t('approvals.status.open'),
            action: { label: t('approvals.title'), onPress: controller.onOpenApproval } };
    }
    switch (controller.status) {
        case 'connected': return { kind: 'live' };
        case 'idle':
        case 'connecting': return { kind: 'line', reason: t('terminalWorkspace.states.connecting'), busy: true };
        case 'exited': return {
            kind: 'line',
            reason: t('terminalWorkspace.states.exited', { title: props.title }),
            action: { label: t('terminalWorkspace.states.restart'), onPress: () => controller.requestRestart() },
        };
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
            return {
                kind: 'failed',
                title: t('terminalWorkspace.states.failedTitle', { title: props.title }),
                reason: copy ? t(copy.bodyKey) : t('errors.tryAgain'),
                code: controller.error,
            };
        }
    }
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
    const showsOwnChrome = props.chrome !== 'none';

    return (
        <View testID={testId('root')} style={styles.container}>
            {showsOwnChrome ? (
                <View style={styles.toolbar}>
                    <View style={styles.toolbarLeft}>
                        <Icon name="terminal" size={16} color={theme.colors.text.secondary} />
                        <Text style={styles.toolbarTitle} numberOfLines={1}>
                            {props.title}
                        </Text>
                    </View>
                    <View style={styles.toolbarRight}>
                        {props.toolbarActionsStart}
                        {props.onCopySelection ? (
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
                    {props.onPaste ? (
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

            {frameState.kind === 'line' ? (
                <SurfaceFreshnessLine
                    testID={testId('state-line')}
                    reason={frameState.reason}
                    busy={frameState.busy}
                    tone={frameState.tone}
                    action={frameState.action}
                />
            ) : null}

            <View testID={testId('surface')} style={terminalSurfaceStyle}>
                {props.surface}
                {frameState.kind === 'failed' ? (
                    <View testID={testId('overlay')} style={styles.overlay} pointerEvents="auto">
                        <SurfaceStateCard
                            testID={testId('state-card')}
                            kind="error"
                            title={frameState.title}
                            reason={frameState.reason}
                            diagnosticCode={frameState.code}
                            action={{ label: t('terminalWorkspace.states.tryAgain'), onPress: props.controller.retryConnect, testID: testId('retry') }}
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
