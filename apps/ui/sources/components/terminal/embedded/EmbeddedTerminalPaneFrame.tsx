import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { resolveTerminalErrorCopy } from '@/components/sessions/terminal/terminalErrorCopy';
import { EmbeddedTerminalToolbarIconButton } from './EmbeddedTerminalToolbarIconButton';
import { embeddedTerminalPaneStyles } from './embeddedTerminalPaneStyles';
import type { EmbeddedTerminalPaneController } from './types';

export type EmbeddedTerminalPaneFrameProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    surface: React.ReactNode;
    footer?: React.ReactNode;
    onRequestClose?: (() => void) | null;
    onPaste?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    testIdPrefix?: string | null;
    platformOS?: 'web' | 'ios' | 'android';
}>;

export const EmbeddedTerminalPaneFrame = React.memo(function EmbeddedTerminalPaneFrame(props: EmbeddedTerminalPaneFrameProps) {
    const { theme } = useUnistyles();
    const styles = embeddedTerminalPaneStyles;

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

    const shouldShowOverlay = props.controller.status !== 'connected';
    const overlayTitle = props.controller.status === 'error'
        ? t('common.error')
        : props.controller.status === 'exited'
            ? t('common.unavailable')
            : t('common.loading');

    const overlayBody = React.useMemo(() => {
        if (props.controller.status !== 'error') {
            if (props.controller.status === 'exited') return t('errors.tryAgain');
            return t('common.loading');
        }
        const copy = resolveTerminalErrorCopy(props.controller.error);
        if (copy) return t(copy.bodyKey);
        return props.controller.error ? String(props.controller.error) : t('errors.tryAgain');
    }, [props.controller.error, props.controller.status]);

    return (
        <View testID={testId('root')} style={styles.container}>
            <View style={styles.toolbar}>
                <View style={styles.toolbarLeft}>
                    <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
                    <Text style={styles.toolbarTitle} numberOfLines={1}>
                        {props.title}
                    </Text>
                </View>
                <View style={styles.toolbarRight}>
                    {props.toolbarActionsStart}
                    {props.onPaste ? (
                        <EmbeddedTerminalToolbarIconButton
                            testID={testId('paste')}
                            accessibilityLabel={t('common.paste')}
                            onPress={props.onPaste}
                            icon="clipboard-outline"
                        />
                    ) : null}
                    <EmbeddedTerminalToolbarIconButton
                        testID={testId('clear')}
                        accessibilityLabel={t('common.reset')}
                        onPress={props.controller.clearTerminal}
                        icon="trash-outline"
                    />
                    <EmbeddedTerminalToolbarIconButton
                        testID={testId('restart')}
                        accessibilityLabel={t('common.refresh')}
                        onPress={props.controller.requestRestart}
                        icon="refresh-outline"
                    />
                    {props.onRequestClose ? (
                        <EmbeddedTerminalToolbarIconButton
                            testID={testId('close')}
                            accessibilityLabel={t('common.close')}
                            onPress={props.onRequestClose}
                            icon="close-outline"
                        />
                    ) : null}
                </View>
            </View>

            {props.controller.detectedUrl?.url ? (
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
                            <Ionicons name="copy-outline" size={18} color={theme.colors.text} />
                        </PrimaryCircleIconButton>
                        <PrimaryCircleIconButton
                            active={false}
                            testID={testId('url-open')}
                            accessibilityLabel={t('common.open')}
                            onPress={onOpenUrl}
                        >
                            <Ionicons name="open-outline" size={18} color={theme.colors.text} />
                        </PrimaryCircleIconButton>
                        <PrimaryCircleIconButton
                            active={false}
                            testID={testId('url-dismiss')}
                            accessibilityLabel={t('common.close')}
                            onPress={props.controller.dismissDetectedUrl}
                        >
                            <Ionicons name="close-outline" size={18} color={theme.colors.text} />
                        </PrimaryCircleIconButton>
                    </View>
                </View>
            ) : null}

            <View style={styles.terminalSurface}>
                {props.surface}
                {props.footer}
                {shouldShowOverlay ? (
                    <View testID={testId('overlay')} style={styles.overlay} pointerEvents="auto">
                        <Text style={styles.overlayTitle}>{overlayTitle}</Text>
                        <Text style={styles.overlayBody}>{overlayBody}</Text>

                        {props.controller.status === 'error' ? (
                            <Pressable testID={testId('retry')} onPress={props.controller.retryConnect} style={styles.overlayRetry}>
                                <Text style={styles.overlayRetryLabel}>{t('common.retry')}</Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}
            </View>
        </View>
    );
});
