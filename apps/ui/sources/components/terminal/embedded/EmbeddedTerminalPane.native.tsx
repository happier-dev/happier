import * as React from 'react';
import { PixelRatio, Platform, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { Text } from '@/components/ui/text/Text';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import { XtermWebViewSurface, type XtermWebViewSurfaceHandle } from '@/components/terminal/xterm/webview/XtermWebViewSurface.native';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import { EmbeddedTerminalPaneFrame } from './EmbeddedTerminalPaneFrame';
import { embeddedTerminalPaneStyles } from './embeddedTerminalPaneStyles';
import type { EmbeddedTerminalPaneController } from './types';

const DEFAULT_QUICK_KEYS: ReadonlyArray<Readonly<{ id: string; label: string; data: string }>> = [
    { id: 'escape', label: 'Esc', data: '\u001b' },
    { id: 'ctrl-c', label: 'Ctrl+C', data: '\u0003' },
    { id: 'ctrl-d', label: 'Ctrl+D', data: '\u0004' },
    { id: 'enter', label: 'Enter', data: '\r' },
];

export type EmbeddedTerminalPaneProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    testIdPrefix?: string | null;
    showQuickKeys?: boolean;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneNative(props: EmbeddedTerminalPaneProps) {
    const { theme } = useUnistyles();
    const styles = embeddedTerminalPaneStyles;
    const uiFontScale = useLocalSetting('uiFontScale');
    const osFontScale = typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1;
    const fontMetrics = React.useMemo(() => resolveCodeEditorFontMetrics({ uiFontScale, osFontScale }), [osFontScale, uiFontScale]);
    const keyboardBottomInset = useKeyboardHeight();
    const webViewRef = props.terminalRef as React.MutableRefObject<XtermWebViewSurfaceHandle | null>;

    const onPaste = React.useCallback(async () => {
        const text = await getClipboardStringTrimmedSafe();
        if (!text) return;
        props.controller.onInput(text);
    }, [props.controller]);

    const footer = props.showQuickKeys ? (
        <ScrollView
            horizontal={true}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.quickKeysRow}
            style={styles.quickKeysScroll}
        >
            {DEFAULT_QUICK_KEYS.map((key) => (
                <Pressable
                    key={key.id}
                    accessibilityRole="button"
                    onPress={() => {
                        props.controller.onInput(key.data);
                        webViewRef.current?.focus();
                    }}
                    style={styles.quickKey}
                >
                    <Text style={styles.quickKeyLabel}>{key.label}</Text>
                </Pressable>
            ))}
        </ScrollView>
    ) : null;

    return (
        <EmbeddedTerminalPaneFrame
            title={props.title}
            controller={props.controller}
            onRequestClose={props.onRequestClose}
            onPaste={onPaste}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            footer={footer}
            keyboardBottomInset={keyboardBottomInset}
            platformOS={Platform.OS === 'android' ? 'android' : 'ios'}
            surface={(
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                    <XtermWebViewSurface
                        ref={webViewRef}
                        testID={props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined}
                        fontSize={fontMetrics.fontSize}
                        lineHeightPx={fontMetrics.lineHeight}
                        onInput={props.controller.onInput}
                        onResize={props.controller.onResize}
                        onReady={props.controller.onReady}
                    />
                </View>
            )}
        />
    );
});

export default EmbeddedTerminalPane;
