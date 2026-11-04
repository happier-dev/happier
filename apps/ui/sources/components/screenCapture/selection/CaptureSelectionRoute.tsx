import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { useDesktopOverlayTransparentDocumentBackground } from '@/activity/adapters/desktop/ui/useDesktopOverlayTransparentDocumentBackground';
import {
    cancelNativeCapture,
    commitNativeCapture,
    hitTestNativeCapture,
    readNativeCaptureState,
    readNativeSelectionFacts,
    readNativeCaptureShortcuts,
    setNativeCaptureMode,
    subscribeNativeCapture,
    subscribeNativeCaptureShortcuts,
    type NativeCaptureDisplayFacts,
    type NativeCaptureInventory,
    type NativeCaptureSnapshot,
    type NativeCaptureShortcutSnapshot,
} from '@/desktop/capture/nativeCapture';
import { formatKeybindingLabel, parseKeybindingRule } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { acknowledgeCaptureWindowPaint } from '@/desktop/capture/captureWindowHost';

import { RecordingAreaMarks } from '../recording/RecordingAreaMarks';
import type { CaptureRect } from '../window/resolveCaptureWindowFrame';
import { CaptureSelectionLayer, type CaptureSelectionCommit, type CaptureSelectionMode, type CaptureSelectionWindow } from './CaptureSelectionLayer';

type Operation = Readonly<{ operationRef: number; mode: CaptureSelectionMode; display: NativeCaptureDisplayFacts;
    windows: NativeCaptureInventory['windows']; initialPointer: Readonly<{ x: number; y: number }> | null }>;

const selectionWindow = (window: NativeCaptureInventory['windows'][number]): CaptureSelectionWindow => ({
    windowId: window.windowId,
    appName: window.appName,
    title: window.title,
    frame: window.frame,
});

/** `/desktop/capture-selection`: one layer per display, bound to P1's selecting operation. */
export function CaptureSelectionRoute() {
    useDesktopOverlayTransparentDocumentBackground(true);
    const { displayId } = useLocalSearchParams<{ displayId?: string }>();
    const [operation, setOperation] = React.useState<Operation | null>(null);
    const [recordedArea, setRecordedArea] = React.useState<CaptureRect | null>(null);
    const [shortcutLabel, setShortcutLabel] = React.useState<string | undefined>();
    const selecting = operation !== null;
    const operationRef = operation?.operationRef;
    React.useEffect(() => {
        if (operationRef === undefined) return;
        void acknowledgeCaptureWindowPaint().catch(() => { void cancelNativeCapture(operationRef).catch(() => undefined); });
    }, [operationRef]);
    React.useEffect(() => {
        if (!selecting) { setShortcutLabel(undefined); return; }
        let alive = true;
        let pushed = false;
        let stop: (() => void) | undefined;
        const receive = (snapshot: NativeCaptureShortcutSnapshot) => {
            if (!alive) return;
            const binding = snapshot.bindings.find(({ key }) => key === 'captureShortcut')?.active;
            setShortcutLabel(binding ? formatKeybindingLabel(parseKeybindingRule(binding), resolveKeyboardPlatform()) : undefined);
        };
        void subscribeNativeCaptureShortcuts(snapshot => { pushed = true; receive(snapshot); }).then(async unsubscribe => {
            if (!alive) { unsubscribe(); return; }
            stop = unsubscribe;
            const initial = await readNativeCaptureShortcuts();
            if (!pushed) receive(initial);
        }).catch(() => { if (alive && !pushed) setShortcutLabel(undefined); });
        return () => { alive = false; stop?.(); };
    }, [selecting]);
    React.useEffect(() => {
        let alive = true;
        let operationRef: number | null = null;
        let latest: Extract<NativeCaptureSnapshot, { status: 'selecting' }> | null = null;
        let unsubscribe: (() => void) | undefined;
        let receivedPush = false;
        const failed = () => {
            // A failed native fact read must not leave a transparent input host
            // trapping the desktop without its selection controls.
            if (alive && operationRef !== null) void cancelNativeCapture(operationRef).catch(() => undefined);
        };
        const receive = (state: NativeCaptureSnapshot) => {
            if (!alive) return;
            // Native keeps this layer, click-through, only on the display an area is recording.
            setRecordedArea(state.status === 'recording' && String(state.origin?.displayId) === displayId ? state.origin?.rect ?? null : null);
            if (state.status !== 'selecting') { latest = null; setOperation(null); return; }
            latest = state;
            setOperation((current) => current?.operationRef === state.operationRef
                ? current.mode === state.mode ? current : { ...current, mode: state.mode }
                : current);
            if (operationRef === state.operationRef) return;
            operationRef = state.operationRef;
            const display = state.inventory.displays.find((candidate) => String(candidate.displayId) === displayId);
            if (!display) return;
            void readNativeSelectionFacts(state.operationRef, display.displayId).then((facts) => {
                if (!alive || latest?.operationRef !== state.operationRef) return;
                setOperation({ operationRef: state.operationRef, mode: latest.mode, display: facts.display,
                    windows: facts.windows, initialPointer: facts.initialPointer });
            }).catch(failed);
        };
        void subscribeNativeCapture((state) => { receivedPush = true; receive(state); }).then(async (stop) => {
            if (!alive) { stop(); return; }
            unsubscribe = stop;
            const initial = await readNativeCaptureState();
            if (!receivedPush) receive(initial);
        }).catch(failed);
        return () => { alive = false; unsubscribe?.(); };
    }, [displayId]);
    const windows = React.useMemo(() => operation
        ? operation.windows.map(selectionWindow)
        : [], [operation?.windows]);
    const hitTest = React.useCallback(async (point: Readonly<{ x: number; y: number }>) => {
        if (!operation) return null;
        const window = await hitTestNativeCapture(operation.operationRef, operation.display.displayId, point.x, point.y);
        return window ? selectionWindow(window) : null;
    }, [operation]);
    if (recordedArea) return <RecordingAreaMarks area={recordedArea} />;
    if (!operation) return null;
    const { display } = operation;
    const commit = (selection: CaptureSelectionCommit) => void commitNativeCapture(operation.operationRef, selection.kind === 'window'
        ? { kind: 'window', windowId: selection.window.windowId }
        : { kind: 'rect', displayId: display.displayId, rect: selection.rect });
    return (
        <CaptureSelectionLayer
            display={{ width: display.frame.width, height: display.frame.height }}
            safeAreaTop={display.safeAreaTop}
            windows={windows}
            initialPointer={operation.initialPointer ?? undefined}
            shortcutLabel={shortcutLabel}
            hitTest={hitTest}
            mode={operation.mode}
            onModeChange={(mode) => { void setNativeCaptureMode(operation.operationRef, mode).catch(() => undefined); }}
            onCommit={commit}
            onCancel={() => void cancelNativeCapture(operation.operationRef)}
        />
    );
}
