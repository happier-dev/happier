import * as React from 'react';
import { View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierLiveStreamInputMode, HappierLiveStreamViewTransform } from '@happier-dev/plugin-ui/presentation';
import { createPersistentUiState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { RemoteViewerActions } from './useRemoteViewerActions';

/** A viewer preference, scoped by its producer to Home, Account, Machine and source identity. */
export const remoteViewerModes = createPersistentUiState<HappierLiveStreamInputMode>('remote-viewer-input-mode-v1',
    value => value === 'trackpad' ? 'trackpad' : 'direct');
const FIT: HappierLiveStreamViewTransform = { scale: 1, x: 0, y: 0 };
export type RemoteViewerStageControls = Readonly<{
    mode: HappierLiveStreamInputMode;
    setMode(mode: HappierLiveStreamInputMode): void;
    resetZoom(): void;
    zoomReset: number;
    onViewTransformChange(transform: HappierLiveStreamViewTransform): void;
    renderCursor(position: Readonly<{ x: number; y: number }>): React.ReactNode;
    renderDragTrail(points: readonly Readonly<{x: number; y: number}>[]): React.ReactNode;
}>;
export type RemoteViewerHostActions = RemoteViewerActions & Readonly<{
    inputMode: Readonly<{ value: HappierLiveStreamInputMode; setMode(mode: HappierLiveStreamInputMode): void }>;
    resetZoom(): void;
}>;
const styles = StyleSheet.create(theme => ({
    root: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
    picture: { ...StyleSheet.absoluteFillObject },
    controls: { position: 'absolute', left: theme.space.s12, bottom: theme.space.s12, zIndex: 3 },
    cursor: { position: 'absolute', pointerEvents: 'none' },
}));

/** Picture, local viewport and touch-mode controls share one leaf; cursor frames never rerender the host screen. */
export function RemoteViewerStage(props: Readonly<{
    viewerKey?: string;
    viewport: Readonly<{ width: number; height: number }>;
    enabled: boolean;
    children: React.ReactNode;
    renderInput(controls: RemoteViewerStageControls): React.ReactNode;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    // Canonical source keys contain nested JSON escapes; MMKV keys reject backslashes.
    const storageKey = props.viewerKey ? encodeURIComponent(props.viewerKey) : null;
    const retained = usePersistentUiStateValue(remoteViewerModes, storageKey);
    const [temporaryMode, setTemporaryMode] = React.useState<HappierLiveStreamInputMode>('direct');
    const mode = props.viewerKey ? retained ?? 'direct' : temporaryMode;
    const [transform, setTransform] = React.useState(FIT);
    const [zoomReset, setZoomReset] = React.useState(0);
    const setMode = React.useCallback((next: HappierLiveStreamInputMode) => {
        if (storageKey) remoteViewerModes.set(storageKey, next);
        else setTemporaryMode(next);
    }, [storageKey]);
    const resetZoom = React.useCallback(() => { setTransform(FIT); setZoomReset(value => value + 1); }, []);
    const onViewTransformChange = React.useCallback((next: HappierLiveStreamViewTransform) => {
        setTransform(current => current.scale === next.scale && current.x === next.x && current.y === next.y ? current : next);
    }, []);
    const renderCursor = React.useCallback((position: Readonly<{ x: number; y: number }>) => props.enabled
        ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[styles.cursor, { left: position.x, top: position.y }]} testID={`${props.testID}-cursor`}>
            <Icon name="cursor" size={ICON_SIZE.md} weight="fill" color={theme.colors.text.primary} />
        </View> : null, [props.enabled, props.testID, theme.colors.text.primary]);
    const renderDragTrail = React.useCallback((points: readonly Readonly<{x: number; y: number}>[]) => props.enabled && points.length > 1
        ? <Svg pointerEvents="none" style={StyleSheet.absoluteFillObject} width={props.viewport.width} height={props.viewport.height}
            testID={`${props.testID}-drag-trail`}><Polyline points={points.map(point => `${point.x},${point.y}`).join(' ')}
                fill="none" stroke={theme.colors.text.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg> : null,
        [props.enabled, props.testID, props.viewport.width, props.viewport.height, theme.colors.text.primary]);
    const controls = React.useMemo(() => ({ mode, setMode, resetZoom, zoomReset, onViewTransformChange, renderCursor, renderDragTrail }),
        [mode, setMode, resetZoom, zoomReset, onViewTransformChange, renderCursor, renderDragTrail]);
    const { Surface, Button } = CORE_CAPSULE_HOST;
    return <View style={styles.root}>
        <View style={[styles.picture, { transform: [
            { translateX: transform.x + (transform.scale - 1) * props.viewport.width / 2 },
            { translateY: transform.y + (transform.scale - 1) * props.viewport.height / 2 },
            { scale: transform.scale },
        ] }]}>{props.children}</View>
        {props.renderInput(controls)}
        {props.enabled ? <View style={styles.controls}><Surface elevation="low" testID={`${props.testID}-mode-controls`}>
            <SegmentedTabBar tabs={[
                {id: 'direct' as const, label: t('browserPresence.stream.directMode')},
                {id: 'trackpad' as const, label: t('browserPresence.stream.trackpadMode')},
            ]} activeTabId={mode} onSelectTab={setMode} testIDPrefix={`${props.testID}-mode`} compact />
            {transform.scale > 1 ? <Button emphasis="plain" title={t('browserPresence.stream.resetZoom')}
                onPress={resetZoom} testID={`${props.testID}-reset-zoom`} /> : null}
        </Surface></View> : null}
    </View>;
}
