import React from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';

import {
    resolveWebKeyboardReferenceViewportHeight,
    updateWebVisualViewportKeyboardReference,
    type WebVisualViewportKeyboardReference,
} from '@/hooks/ui/webVisualViewportKeyboardReference';
import { resolveWebVisualViewportKeyboardInset } from '@/hooks/ui/resolveWebVisualViewportKeyboardInset';
import { resolveTrustedWebSafeAreaBottomInset } from '@/utils/platform/webSafeAreaInset';

/**
 * Live probe for the geometry the mobile-web keyboard/safe-area layout depends on.
 * Web-only: on native the layout is driven by react-native-keyboard-controller instead.
 *
 * Used to diagnose mobile browsers whose `window.innerHeight` / visualViewport /
 * `env(safe-area-inset-*)` values disagree with the actually visible window (e.g. Firefox
 * Android reporting a layout viewport taller than the visual viewport can ever reach).
 */

type ViewportSnapshot = Readonly<{
    cssHeightAttr: string;
    cssWidthAttr: string;
    devicePixelRatio: number;
    documentClientHeight: number;
    documentOffsetHeight: number;
    innerHeight: number;
    innerWidth: number;
    maxTouchPoints: number;
    safeAreaBottomProbePx: number;
    safeAreaTopProbePx: number;
    screenAvailHeight: number;
    screenHeight: number;
    trustedEnvBottomPx: number;
    userAgent: string;
    vvHeight: number | null;
    vvOffsetTop: number | null;
    vvScale: number | null;
    vvWidth: number | null;
}>;

function readEnvSafeAreaProbe(side: 'top' | 'bottom'): number {
    if (typeof document === 'undefined') return 0;
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.left = '0';
    probe.style.top = '0';
    probe.style.paddingTop = `env(safe-area-inset-${side}, 0px)`;
    try {
        document.body.appendChild(probe);
        const padding = window.getComputedStyle(probe).paddingTop;
        return Number.parseFloat(padding) || 0;
    } catch {
        return 0;
    } finally {
        probe.remove();
    }
}

function readSnapshot(): ViewportSnapshot {
    const vv = window.visualViewport;
    const root = document.documentElement;
    return {
        cssHeightAttr: root.getAttribute('style') ?? '',
        cssWidthAttr: '',
        devicePixelRatio: window.devicePixelRatio,
        documentClientHeight: root.clientHeight,
        documentOffsetHeight: root.offsetHeight,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        maxTouchPoints: navigator.maxTouchPoints,
        safeAreaBottomProbePx: readEnvSafeAreaProbe('bottom'),
        safeAreaTopProbePx: readEnvSafeAreaProbe('top'),
        screenAvailHeight: window.screen.availHeight ?? 0,
        screenHeight: window.screen.height ?? 0,
        trustedEnvBottomPx: resolveTrustedWebSafeAreaBottomInset(readEnvSafeAreaProbe('bottom')),
        userAgent: navigator.userAgent,
        vvHeight: vv ? vv.height : null,
        vvOffsetTop: vv ? vv.offsetTop : null,
        vvScale: vv ? vv.scale : null,
        vvWidth: vv ? vv.width : null,
    };
}

function Row(props: Readonly<{ label: string; value: string }>) {
    return (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 16 }}>
            <Text style={{ color: '#ddd', fontSize: 13, flexShrink: 1, paddingRight: 12 }}>{props.label}</Text>
            <Text style={{ color: '#7FD0FF', fontSize: 13, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }} selectable>
                {props.value}
            </Text>
        </View>
    );
}

export default function ViewportGeometryDebug() {
    const [snapshot, setSnapshot] = React.useState<ViewportSnapshot | null>(null);
    const [reference, setReference] = React.useState<WebVisualViewportKeyboardReference | null>(null);
    const [focusedInset, setFocusedInset] = React.useState(0);
    const [unfocusedInset, setUnfocusedInset] = React.useState(0);
    const referenceRef = React.useRef<WebVisualViewportKeyboardReference | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;

        const tick = () => {
            const next = readSnapshot();
            setSnapshot(next);
            const vv = window.visualViewport;
            if (vv) {
                const active = document.activeElement;
                const tag = active?.tagName?.toLowerCase() ?? '';
                const isFocused = tag === 'input' || tag === 'textarea'
                    || active?.getAttribute?.('contenteditable') === 'true';
                const updated = updateWebVisualViewportKeyboardReference(referenceRef.current, {
                    width: vv.width,
                    visualBottom: vv.height + vv.offsetTop,
                    layoutViewportHeight: window.innerHeight,
                    isEditableElementFocused: isFocused,
                });
                referenceRef.current = updated;
                setReference(updated);
                const inset = (focused: boolean) => resolveWebVisualViewportKeyboardInset({
                    layoutViewportHeight: resolveWebKeyboardReferenceViewportHeight(updated, {
                        layoutViewportHeight: window.innerHeight,
                        currentVisualBottom: vv.height + vv.offsetTop,
                    }),
                    visualViewportHeight: vv.height,
                    visualViewportOffsetTop: vv.offsetTop,
                    isEditableElementFocused: focused,
                    isMobileLikeHost: vv.width < 768,
                });
                setFocusedInset(inset(true));
                setUnfocusedInset(inset(false));
            }
        };

        tick();
        const interval = setInterval(tick, 250);
        window.visualViewport?.addEventListener('resize', tick);
        window.visualViewport?.addEventListener('scroll', tick);
        window.addEventListener('resize', tick);
        return () => {
            clearInterval(interval);
            window.visualViewport?.removeEventListener('resize', tick);
            window.visualViewport?.removeEventListener('scroll', tick);
            window.removeEventListener('resize', tick);
        };
    }, []);

    const fmt = (value: number | null | undefined, digits = 1) =>
        value === null || value === undefined ? '—' : value.toFixed(digits);

    return (
        <>
            <Stack.Screen options={{ title: 'Viewport Geometry' }} />
            <ScrollView style={{ flex: 1, backgroundColor: '#111' }} contentContainerStyle={{ paddingVertical: 12 }}>
                <TextInput
                    placeholder="Tap here to focus & open the keyboard"
                    placeholderTextColor="#888"
                    style={{
                        marginHorizontal: 16,
                        marginBottom: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: '#444',
                        color: '#fff',
                        fontSize: 15,
                    }}
                />
                {Platform.OS !== 'web' ? (
                    <Row label="platform" value="web-only probe" />
                ) : snapshot === null ? (
                    <Row label="state" value="reading…" />
                ) : (
                    <>
                        <Row label="innerWidth × innerHeight" value={`${snapshot.innerWidth} × ${snapshot.innerHeight}`} />
                        <Row label="vv.width × vv.height" value={`${fmt(snapshot.vvWidth)} × ${fmt(snapshot.vvHeight)}`} />
                        <Row label="vv.offsetTop / vv.scale" value={`${fmt(snapshot.vvOffsetTop)} / ${fmt(snapshot.vvScale, 3)}`} />
                        <Row label="document clientHeight / offsetHeight" value={`${snapshot.documentClientHeight} / ${snapshot.documentOffsetHeight}`} />
                        <Row label="screen height / availHeight" value={`${snapshot.screenHeight} / ${snapshot.screenAvailHeight}`} />
                        <Row label="devicePixelRatio" value={fmt(snapshot.devicePixelRatio, 3)} />
                        <Row label="env(safe-area-inset-bottom) probe" value={`${fmt(snapshot.safeAreaBottomProbePx)} CSS px`} />
                        <Row label="env(safe-area-inset-top) probe" value={`${fmt(snapshot.safeAreaTopProbePx)} CSS px`} />
                        <Row label="trusted env bottom (our rule)" value={`${fmt(snapshot.trustedEnvBottomPx)} CSS px`} />
                        <Row label="keyboard reference (baseline)" value={fmt(reference && snapshot?.vvHeight != null
                            ? resolveWebKeyboardReferenceViewportHeight(reference, {
                                layoutViewportHeight: snapshot.innerHeight,
                                currentVisualBottom: snapshot.vvHeight + (snapshot.vvOffsetTop ?? 0),
                            })
                            : null)} />
                        <Row label="resolved keyboard inset (focused / blurred)" value={`${focusedInset} / ${unfocusedInset}`} />
                        <Row label="innerHeight − vv.bottom" value={fmt(snapshot.innerHeight - ((snapshot.vvHeight ?? 0) + (snapshot.vvOffsetTop ?? 0)))} />
                        <Row label="maxTouchPoints" value={`${snapshot.maxTouchPoints}`} />
                        <Row label="userAgent" value={snapshot.userAgent} />
                        <Row label="html style" value={snapshot.cssHeightAttr || '—'} />
                    </>
                )}
            </ScrollView>
        </>
    );
}
