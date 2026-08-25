import * as React from 'react';
import { PixelRatio, Platform, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    getTerminalNativeAvailability,
    normalizeTerminalNativeAvailability,
    type TerminalNativeCopyEvent,
    type TerminalNativeRendererCrashEvent,
    type TerminalNativeRuntimePlatform,
} from '@happier-dev/terminal-native';

import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import { XtermWebViewSurface, type XtermWebViewSurfaceHandle } from '@/components/terminal/xterm/webview/XtermWebViewSurface.native';
import { resolveGhosttyRendererSelection, type GhosttyRendererSelectionOptions } from '@/components/terminal/ghostty/availability';
import { GhosttyTerminalSurface } from '@/components/terminal/ghostty/surface.native';
import { resolveTermuxRendererSelection, type TermuxRendererSelectionOptions } from '@/components/terminal/termux/availability';
import { TermuxTerminalSurface } from '@/components/terminal/termux/surface.native';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
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
    nativeRenderer?: GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    testIdPrefix?: string | null;
    nativeSurfaceKey?: string | null;
    showQuickKeys?: boolean;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneNative(props: EmbeddedTerminalPaneProps) {
    const { theme } = useUnistyles();
    const styles = embeddedTerminalPaneStyles;
    const uiFontScale = useLocalSetting('uiFontScale');
    const terminalRendererPreference = useLocalSetting('terminalRendererPreference');
    const [nativeRendererQuarantine, setNativeRendererQuarantine] = useLocalSettingMutable('terminalNativeRendererQuarantine');
    const osFontScale = typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1;
    const fontMetrics = React.useMemo(() => resolveCodeEditorFontMetrics({ uiFontScale, osFontScale }), [osFontScale, uiFontScale]);
    const keyboardBottomInset = useKeyboardHeight();
    const webViewRef = props.terminalRef as React.MutableRefObject<XtermWebViewSurfaceHandle | null>;
    const byteStreamFeatureEnabled = useFeatureEnabled('terminal.transport.byteStream');
    const nativeFeatureEnabled = useFeatureEnabled('terminal.renderer.native');
    const iosGhosttyFeatureEnabled = useFeatureEnabled('terminal.renderer.iosGhostty');
    const androidTermuxFeatureEnabled = useFeatureEnabled('terminal.renderer.androidTermux');
    const nativePlatform: TerminalNativeRuntimePlatform = Platform.OS === 'android'
        ? 'android'
        : 'ios';
    const resolvedNativeRendererOptions = React.useMemo(
        () => props.nativeRenderer ?? createDefaultNativeRendererOptions({
            platform: nativePlatform,
            byteStreamFeatureEnabled,
            nativeFeatureEnabled,
            iosGhosttyFeatureEnabled,
            androidTermuxFeatureEnabled,
            terminalRendererPreference,
        }),
        [
            androidTermuxFeatureEnabled,
            byteStreamFeatureEnabled,
            iosGhosttyFeatureEnabled,
            nativeFeatureEnabled,
            nativePlatform,
            props.nativeRenderer,
            terminalRendererPreference,
        ],
    );
    const selectedRenderer = React.useMemo(
        () => resolveEmbeddedNativeRendererSelection({
            platform: nativePlatform === 'android' ? 'android' : 'ios',
            nativeRenderer: resolvedNativeRendererOptions,
            terminalRendererPreference,
        }),
        [nativePlatform, resolvedNativeRendererOptions, terminalRendererPreference],
    );
    const [nativeRendererFailed, setNativeRendererFailed] = React.useState(false);
    React.useEffect(() => {
        setNativeRendererFailed(false);
    }, [selectedRenderer]);
    const quarantineActive = nativeRendererQuarantine?.renderer === selectedRenderer
        && nativeRendererQuarantine.expiresAtMs > Date.now();
    React.useEffect(() => {
        if (nativeRendererQuarantine && nativeRendererQuarantine.expiresAtMs <= Date.now()) {
            setNativeRendererQuarantine(null);
        }
    }, [nativeRendererQuarantine, setNativeRendererQuarantine]);
    const effectiveRenderer = nativeRendererFailed || quarantineActive ? 'xterm-webview' : selectedRenderer;
    const onNativeUnavailable = React.useCallback(() => {
        setNativeRendererFailed(true);
    }, []);
    const onRendererCrash = React.useCallback((event: TerminalNativeRendererCrashEvent) => {
        setNativeRendererFailed(true);
        if (selectedRenderer !== 'ios-ghosttykit' && selectedRenderer !== 'android-termux') return;
        setNativeRendererQuarantine({
            renderer: selectedRenderer,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
    }, [selectedRenderer, setNativeRendererQuarantine]);
    const nativeAccessibilityAccepted = terminalRendererPreference === 'native'
        || hasAcceptedNativeAccessibility(resolvedNativeRendererOptions);
    const nativeSurfaceKey = props.nativeSurfaceKey?.trim() || props.testIdPrefix || 'embedded-terminal';

    const onPaste = React.useCallback(async () => {
        const text = await getClipboardStringTrimmedSafe();
        if (!text) return;
        void props.controller.onPaste(text);
    }, [props.controller]);
    const onNativeCopy = React.useCallback((event: TerminalNativeCopyEvent) => {
        props.controller.copySelection?.({ source: 'user-selection', text: event.text });
    }, [props.controller]);
    const onCopySelection = React.useCallback(() => {
        props.terminalRef.current?.copySelection?.();
    }, [props.terminalRef]);

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
            onCopySelection={effectiveRenderer === 'ios-ghosttykit' ? onCopySelection : null}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            footer={footer}
            keyboardBottomInset={keyboardBottomInset}
            platformOS={Platform.OS === 'android' ? 'android' : 'ios'}
            surface={(
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                    {effectiveRenderer === 'ios-ghosttykit' ? (
                        <GhosttyTerminalSurface
                            ref={props.terminalRef}
                            surfaceId={createNativeSurfaceId('ios-ghosttykit', nativeSurfaceKey)}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            accessibilityAccepted={nativeAccessibilityAccepted}
                            onInput={props.controller.onInput}
                            onLink={(event) => props.controller.onLink?.(event.url)}
                            onTitle={(event) => props.controller.onTitle?.(event.title)}
                            onBell={(event) => props.controller.onBell?.(event.label ?? '')}
                            onCopy={onNativeCopy}
                            onResize={props.controller.onResize}
                            onReady={props.controller.onReady}
                            onWriteComplete={props.controller.onWriteComplete}
                            onUnavailable={onNativeUnavailable}
                            onRendererCrash={onRendererCrash}
                        />
                    ) : effectiveRenderer === 'android-termux' ? (
                        <TermuxTerminalSurface
                            ref={props.terminalRef}
                            surfaceId={createNativeSurfaceId('android-termux', nativeSurfaceKey)}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            accessibilityAccepted={nativeAccessibilityAccepted}
                            onInput={props.controller.onInput}
                            onLink={(event) => props.controller.onLink?.(event.url)}
                            onTitle={(event) => props.controller.onTitle?.(event.title)}
                            onBell={(event) => props.controller.onBell?.(event.label ?? '')}
                            onCopy={onNativeCopy}
                            onResize={props.controller.onResize}
                            onReady={props.controller.onReady}
                            onWriteComplete={props.controller.onWriteComplete}
                            onUnavailable={onNativeUnavailable}
                            onRendererCrash={onRendererCrash}
                        />
                    ) : (
                        <XtermWebViewSurface
                            ref={webViewRef}
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            onInput={props.controller.onInput}
                            onPaste={props.controller.onPaste}
                            onLink={props.controller.onLink}
                            onResize={props.controller.onResize}
                            onReady={props.controller.onReady}
                            onWriteComplete={props.controller.onWriteComplete}
                        />
                    )}
                </View>
            )}
        />
    );
});

export default EmbeddedTerminalPane;

function createNativeSurfaceId(renderer: 'ios-ghosttykit' | 'android-termux', key: string): string {
    return `embedded-terminal:${renderer}:${key}`;
}

type EmbeddedNativeRendererSelection =
    | 'ios-ghosttykit'
    | 'android-termux'
    | 'xterm-webview';

function resolveEmbeddedNativeRendererSelection(input: Readonly<{
    platform: 'ios' | 'android';
    nativeRenderer?: GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions;
    terminalRendererPreference: TerminalRendererPreference;
}>): EmbeddedNativeRendererSelection {
    if (input.terminalRendererPreference === 'xterm-webview') {
        return 'xterm-webview';
    }

    if (!input.nativeRenderer) {
        return 'xterm-webview';
    }

    if (input.platform === 'ios') {
        const selection = resolveGhosttyRendererSelection({
            ...input.nativeRenderer,
            platform: 'ios',
        });
        return selection.renderer === 'ios-ghosttykit' ? 'ios-ghosttykit' : 'xterm-webview';
    }

    const nativeRenderer = input.nativeRenderer as Partial<TermuxRendererSelectionOptions>;
    const selection = resolveTermuxRendererSelection({
        ...input.nativeRenderer,
        platform: 'android',
        legalAccepted: nativeRenderer.legalAccepted === true,
    });
    return selection.renderer === 'android-termux' ? 'android-termux' : 'xterm-webview';
}

function createDefaultNativeRendererOptions(input: Readonly<{
    platform: TerminalNativeRuntimePlatform;
    byteStreamFeatureEnabled: boolean;
    nativeFeatureEnabled: boolean;
    iosGhosttyFeatureEnabled: boolean;
    androidTermuxFeatureEnabled: boolean;
    terminalRendererPreference: TerminalRendererPreference;
}>): GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions | undefined {
    if (input.terminalRendererPreference === 'xterm-webview') {
        return undefined;
    }

    const accessibilityAccepted = input.terminalRendererPreference === 'native';

    if (input.platform === 'ios') {
        const featureEnabled = input.byteStreamFeatureEnabled && input.nativeFeatureEnabled && input.iosGhosttyFeatureEnabled;
        const availability = getTerminalNativeAvailability({
            platform: 'ios',
            featureEnabled,
            accessibilityAccepted,
        });
        return {
            featureEnabled,
            platform: 'ios',
            availability,
            accessibilityAccepted,
            packageProofAccepted: availability.available,
            crashFallbackAvailable: true,
        };
    }

    if (input.platform === 'android') {
        const featureEnabled = input.byteStreamFeatureEnabled && input.nativeFeatureEnabled && input.androidTermuxFeatureEnabled;
        const availability = getTerminalNativeAvailability({
            platform: 'android',
            featureEnabled,
            accessibilityAccepted,
        });
        return {
            featureEnabled,
            platform: 'android',
            availability,
            accessibilityAccepted,
            legalAccepted: availability.available,
            packageProofAccepted: availability.available,
            crashFallbackAvailable: true,
        };
    }

    return undefined;
}

type TerminalRendererPreference = 'auto' | 'xterm-webview' | 'native';

function hasAcceptedNativeAccessibility(
    nativeRenderer?: GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions,
): boolean {
    if (!nativeRenderer) {
        return false;
    }
    if (nativeRenderer.accessibilityAccepted === true) {
        return true;
    }
    const availability = normalizeTerminalNativeAvailability(nativeRenderer.availability);
    return availability.available && availability.accessibility === 'native';
}
