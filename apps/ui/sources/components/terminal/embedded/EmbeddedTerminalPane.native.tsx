import * as React from 'react';
import { PixelRatio, Platform, Pressable, View } from 'react-native';
import {
    getTerminalNativeQaCapabilities,
    getTerminalNativeAvailability,
    injectTerminalNativeRendererCrashForQa,
    normalizeTerminalNativeAvailability,
    type TerminalNativeCopyEvent,
    type TerminalNativeRendererCrashEvent,
    type TerminalNativeRuntimePlatform,
} from '@happier-dev/terminal-native';

import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useScreenReaderEnabled } from '@/hooks/ui/useScreenReaderEnabled';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import {
    XtermWebViewSurface,
    type XtermWebViewRendererFailure,
    type XtermWebViewSurfaceHandle,
} from '@/components/terminal/xterm/webview/XtermWebViewSurface.native';
import { resolveGhosttyRendererSelection, type GhosttyRendererSelectionOptions } from '@/components/terminal/ghostty/availability';
import { GhosttyTerminalSurface } from '@/components/terminal/ghostty/surface.native';
import { resolveTermuxRendererSelection, type TermuxRendererSelectionOptions } from '@/components/terminal/termux/availability';
import { TermuxTerminalSurface } from '@/components/terminal/termux/surface.native';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useDeviceType } from '@/utils/platform/responsive';
import { EmbeddedTerminalPaneFrame } from './EmbeddedTerminalPaneFrame';
import { TerminalKeyRail } from './keys/TerminalKeyRail';
import { TerminalKeysSurface } from './keys/TerminalKeysSurface';
import { useTerminalKeys } from './keys/useTerminalKeys';
import type { EmbeddedTerminalPaneController } from './types';
import { useTerminalFind } from './useTerminalFind';

export type EmbeddedTerminalPaneProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    nativeRenderer?: GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    /** See `EmbeddedTerminalPaneFrame` `chrome`. */
    chrome?: 'toolbar' | 'none';
    machineName?: string | null;
    testIdPrefix?: string | null;
    nativeSurfaceKey?: string | null;
    showQuickKeys?: boolean;
    focused?: boolean;
    findSurfaceId?: string;
    enableNativeRendererQaCrashControl?: boolean;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneNative(props: EmbeddedTerminalPaneProps) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const terminalRendererPreference = useLocalSetting('terminalRendererPreference');
    const screenReaderActive = useScreenReaderEnabled();
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
    // Auto is the product default: it selects the native renderer when every hard
    // native gate passes and no screen reader is active, and falls back to the
    // accessible xterm WebView while a screen reader is active unless the native
    // module reports native accessibility. Explicit `native` is the informed
    // override that accepts the fallback-required accessibility gap; it never
    // bypasses package, module, ABI, feature, crash, or quarantine gates.
    const nativeAccessibilityAcceptedByPolicy = terminalRendererPreference === 'native'
        || (terminalRendererPreference === 'auto' && !screenReaderActive);
    const resolvedNativeRendererOptions = React.useMemo(
        () => applyNativeAccessibilityPolicy(
            props.nativeRenderer ?? createDefaultNativeRendererOptions({
                platform: nativePlatform,
                byteStreamFeatureEnabled,
                nativeFeatureEnabled,
                iosGhosttyFeatureEnabled,
                androidTermuxFeatureEnabled,
                terminalRendererPreference,
                accessibilityAcceptedByPolicy: nativeAccessibilityAcceptedByPolicy,
            }),
            nativeAccessibilityAcceptedByPolicy,
        ),
        [
            androidTermuxFeatureEnabled,
            byteStreamFeatureEnabled,
            iosGhosttyFeatureEnabled,
            nativeAccessibilityAcceptedByPolicy,
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
    const [webViewRecoveryNonce, requestWebViewRecovery] = React.useReducer((value: number) => value + 1, 0);
    const quarantineActive = nativeRendererQuarantine?.renderer === selectedRenderer
        && nativeRendererQuarantine.expiresAtMs > Date.now();
    React.useEffect(() => {
        setNativeRendererFailed(false);
    }, [quarantineActive, selectedRenderer]);
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
    const onWebViewRendererFailure = React.useCallback((_failure: XtermWebViewRendererFailure) => {
        props.controller.retryConnect();
        requestWebViewRecovery();
    }, [props.controller]);
    const nativeAccessibilityAccepted = nativeAccessibilityAcceptedByPolicy
        || hasAcceptedNativeAccessibility(resolvedNativeRendererOptions);
    const nativeSurfaceKey = props.nativeSurfaceKey?.trim() || props.testIdPrefix || 'embedded-terminal';
    const activeNativeSurfaceId = effectiveRenderer === 'ios-ghosttykit' || effectiveRenderer === 'android-termux'
        ? createNativeSurfaceId(effectiveRenderer, nativeSurfaceKey)
        : null;
    const qaCrashInjectionAvailable = React.useMemo(
        () => props.enableNativeRendererQaCrashControl === true
            && getTerminalNativeQaCapabilities().rendererCrashInjection,
        [props.enableNativeRendererQaCrashControl],
    );
    const injectRendererCrashForQa = React.useCallback(() => {
        if (!qaCrashInjectionAvailable || !activeNativeSurfaceId) return;
        void injectTerminalNativeRendererCrashForQa(activeNativeSurfaceId);
    }, [activeNativeSurfaceId, qaCrashInjectionAvailable]);

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

    // A phone gets the key rail and the floating arrow pad (terminal lab P1).
    const deviceType = useDeviceType();
    const showKeys = props.showQuickKeys ?? deviceType === 'phone';
    const find = useTerminalFind(props, showKeys);
    const keys = useTerminalKeys({
        onInput: props.controller.onInput,
        focusRenderer: React.useCallback(() => props.terminalRef.current?.focus?.(), [props.terminalRef]),
    });
    const onRendererInput = showKeys ? keys.onInput : props.controller.onInput;
    const footer = showKeys
        ? find.open ? find.bar : <TerminalKeyRail modifiers={keys.modifiers} onPressKey={keys.pressRailKey} testIdPrefix={props.testIdPrefix} />
        : null;

    return (
        <View ref={find.rootRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <EmbeddedTerminalPaneFrame
            chrome={props.chrome}
            machineName={props.machineName}
            title={props.title}
            controller={props.controller}
            onRequestClose={props.onRequestClose}
            onPaste={onPaste}
            onCopySelection={effectiveRenderer === 'ios-ghosttykit' || effectiveRenderer === 'android-termux' ? onCopySelection : null}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            footer={footer}
            keyboardBottomInset={keyboardBottomInset}
            platformOS={Platform.OS === 'android' ? 'android' : 'ios'}
            surface={(
                <TerminalKeysSurface showArrowPad={showKeys && !find.open} onArrow={keys.pressArrow} testIdPrefix={props.testIdPrefix}>
                    {effectiveRenderer === 'ios-ghosttykit' ? (
                        <GhosttyTerminalSurface
                            ref={props.terminalRef}
                            surfaceId={createNativeSurfaceId('ios-ghosttykit', nativeSurfaceKey)}
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-ghostty-native` : undefined}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            accessibilityAccepted={nativeAccessibilityAccepted}
                            accessibilityTerminalLabel={t('terminalEmbedded.nativeAccessibility.terminalLabel')}
                            accessibilityFallbackValue={t('terminalEmbedded.nativeAccessibility.fallbackValue')}
                            accessibilityFocusActionLabel={t('terminalEmbedded.nativeAccessibility.focusAction')}
                            accessibilityCopySelectionActionLabel={t('terminalEmbedded.nativeAccessibility.copySelectionAction')}
                            accessibilitySelectAllActionLabel={t('terminalEmbedded.nativeAccessibility.selectAllAction')}
                            accessibilityOpenLinkActionLabel={t('terminalEmbedded.nativeAccessibility.openLinkAction')}
                            onInput={onRendererInput}
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
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-termux-native` : undefined}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            accessibilityAccepted={nativeAccessibilityAccepted}
                            accessibilityTerminalLabel={t('terminalEmbedded.nativeAccessibility.terminalLabel')}
                            accessibilityFallbackValue={t('terminalEmbedded.nativeAccessibility.fallbackValue')}
                            accessibilityFocusActionLabel={t('terminalEmbedded.nativeAccessibility.focusAction')}
                            accessibilityCopySelectionActionLabel={t('terminalEmbedded.nativeAccessibility.copySelectionAction')}
                            accessibilitySelectAllActionLabel={t('terminalEmbedded.nativeAccessibility.selectAllAction')}
                            accessibilityOpenLinkActionLabel={t('terminalEmbedded.nativeAccessibility.openLinkAction')}
                            onInput={onRendererInput}
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
                            key={`xterm-webview-${webViewRecoveryNonce}`}
                            ref={webViewRef}
                            onFindEngine={find.onFindEngine}
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined}
                            fontSize={fontMetrics.fontSize}
                            lineHeightPx={fontMetrics.lineHeight}
                            onInput={onRendererInput}
                            onPaste={props.controller.onPaste}
                            onCopySelection={(text) => props.controller.copySelection?.({ source: 'user-selection', text })}
                            onLink={props.controller.onLink}
                            onResize={props.controller.onResize}
                            onReady={props.controller.onReady}
                            onWriteComplete={props.controller.onWriteComplete}
                            onRendererFailure={onWebViewRendererFailure}
                        />
                    )}
                    {!showKeys ? find.bar : null}
                    {qaCrashInjectionAvailable && activeNativeSurfaceId ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="QA: inject native terminal renderer crash"
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-native-qa-inject-renderer-crash` : 'embedded-terminal-native-qa-inject-renderer-crash'}
                            onPress={injectRendererCrashForQa}
                            style={{
                                position: 'absolute',
                                top: 4,
                                right: 4,
                                width: 24,
                                height: 24,
                                borderRadius: 12,
                                backgroundColor: '#c62828',
                                opacity: 0.9,
                            }}
                        />
                    ) : null}
                </TerminalKeysSurface>
            )}
        />
        </View>
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

    const selection = resolveTermuxRendererSelection({
        ...input.nativeRenderer,
        platform: 'android',
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
    accessibilityAcceptedByPolicy: boolean;
}>): GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions | undefined {
    if (input.terminalRendererPreference === 'xterm-webview') {
        return undefined;
    }

    const accessibilityAccepted = input.accessibilityAcceptedByPolicy;

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

function applyNativeAccessibilityPolicy(
    nativeRenderer: GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions | undefined,
    accessibilityAcceptedByPolicy: boolean,
): GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions | undefined {
    if (!nativeRenderer) return undefined;
    return {
        ...nativeRenderer,
        accessibilityAccepted: accessibilityAcceptedByPolicy || hasAcceptedNativeAccessibility(nativeRenderer),
    };
}
