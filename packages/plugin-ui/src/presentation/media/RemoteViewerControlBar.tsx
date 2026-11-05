import * as React from 'react';
import { ScrollView, View } from 'react-native';

import type { HappierCapsuleHost } from '../status/capsuleHost.js';
import { HAPPIER_GESTURE_TIMING, type HappierLiveStreamInputMode } from './inputGesture.js';
import { REMOTE_VIEWER_KEYS, type RemoteViewerActions, type RemoteViewerModifier } from './useRemoteViewerActions.js';

/** Runtime leaves only; the shared control bar owns its panels, order and input intent. */
export type RemoteViewerControlBarHost = Readonly<{
    Surface: HappierCapsuleHost['Surface'];
    Button: HappierCapsuleHost['Button'];
    IconButton: React.ComponentType<Readonly<{
        variant?: 'plain';
        accessibilityLabel: string;
        accessibilityRole?: 'checkbox';
        checked?: boolean | 'mixed';
        selected?: boolean;
        disabled?: boolean;
        preserveFocusOnPress?: boolean;
        onPress(): void;
        testID: string;
    }> & (Readonly<{ icon: React.ReactNode; iconName?: never }>
        | Readonly<{ iconName: 'keyboard'; icon?: never }>)>;
    SegmentedTabBar: <T extends string>(props: Readonly<{
        tabs: readonly Readonly<{ id: T; label: string }>[];
        activeTabId: T;
        onSelectTab(id: T): void;
        testIDPrefix: string;
        compact: boolean;
    }>) => React.ReactElement | null;
    KeyHint: React.ComponentType<Readonly<{ label: string }>>;
}>;

export type RemoteViewerControlBarLabels = Readonly<{
    directMode: string;
    trackpadMode: string;
    resetZoom: string;
    sendClipboard: string;
    receiveClipboard: string;
    touch: string;
    modifiers: string;
    arrows: string;
    clipboard: string;
    hideKeyboard: string;
    showKeyboard: string;
}>;

export type RemoteViewerControls = Readonly<{
    mode: HappierLiveStreamInputMode;
    setMode(mode: HappierLiveStreamInputMode): void;
    resetZoom(): void;
}>;

export type RemoteViewerControlBarProps = Readonly<{
    actions: RemoteViewerActions;
    controls: RemoteViewerControls;
    enabled: boolean;
    testID: string;
    host: RemoteViewerControlBarHost;
    labels: RemoteViewerControlBarLabels;
    spacing: Readonly<{ inset: number; gap: number }>;
}>;

type Panel = 'touch' | 'modifiers' | 'arrows' | 'clipboard';

/** The viewer's existing action owner, presented as the same tabs and expanding panels on every screen. */
export function RemoteViewerControlBar(props: RemoteViewerControlBarProps) {
    const [panel, setPanel] = React.useState<Panel | ''>('touch');
    const lastModifierTap = React.useRef<Readonly<{ modifier: RemoteViewerModifier; at: number }> | null>(null);
    const { actions, controls, testID } = props;
    const { Surface, Button, IconButton, SegmentedTabBar, KeyHint } = props.host;
    const styles = {
        root: { position: 'absolute' as const, left: props.spacing.inset, right: props.spacing.inset, bottom: props.spacing.inset, zIndex: 3 },
        row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: props.spacing.gap },
    };
    const modifiers = (Object.keys(actions.modifiers) as RemoteViewerModifier[])
        .filter(modifier => !actions.supportedModifiers || actions.supportedModifiers.includes(modifier));
    const selectPanel = React.useCallback((next: Panel | '') => setPanel(current => current === next ? '' : next), []);
    const tapModifier = (modifier: RemoteViewerModifier) => {
        const at = Date.now();
        const previous = lastModifierTap.current;
        const doubleTap = actions.modifiers[modifier] !== 'locked' && previous?.modifier === modifier
            && at - previous.at <= HAPPIER_GESTURE_TIMING.doubleTapMs;
        lastModifierTap.current = doubleTap ? null : { modifier, at };
        actions.tapModifier(modifier, doubleTap ? { clickCount: 2 } : undefined);
    };
    return <View style={styles.root} testID={testID}>
        <Surface elevation="low" testID={`${testID}-surface`}>
            {panel ? <ScrollView horizontal contentContainerStyle={styles.row}>
                {panel === 'touch' ? <>
                    <SegmentedTabBar tabs={[
                        { id: 'direct' as const, label: props.labels.directMode },
                        { id: 'trackpad' as const, label: props.labels.trackpadMode },
                    ]} activeTabId={controls.mode} onSelectTab={controls.setMode} testIDPrefix={`${testID}-mode`} compact />
                    <Button emphasis="plain" title={props.labels.resetZoom} onPress={controls.resetZoom} testID={`${testID}-reset-zoom`} />
                </> : null}
                {panel === 'modifiers' ? modifiers.map(modifier => <IconButton key={modifier}
                    icon={<KeyHint label={modifier === 'control' ? 'Ctrl' : modifier} />} variant="plain"
                    accessibilityLabel={modifier} accessibilityRole="checkbox"
                    checked={actions.modifiers[modifier] === 'locked' ? 'mixed' : actions.modifiers[modifier] !== 'off'}
                    selected={actions.modifiers[modifier] !== 'off'} disabled={!props.enabled}
                    onPress={() => tapModifier(modifier)} testID={`${testID}-modifier-${modifier}`} />) : null}
                {panel === 'arrows' ? REMOTE_VIEWER_KEYS.filter(key => key !== 'Escape').map(key => <IconButton key={key}
                    variant="plain" icon={<KeyHint label={key} />} accessibilityLabel={key} disabled={!props.enabled} onPress={() => { actions.sendKey(key); }}
                    testID={`${testID}-key-${key}`} />) : null}
                {panel === 'clipboard' ? <>
                    <Button emphasis="plain" title={props.labels.sendClipboard}
                        disabled={!props.enabled || !actions.clipboard.available} onPress={async () => { await actions.sendClipboard(); }} testID={`${testID}-paste`} />
                    <Button emphasis="plain" title={props.labels.receiveClipboard}
                        disabled={!props.enabled || !actions.clipboard.available} onPress={async () => { await actions.receiveClipboard(); }} testID={`${testID}-copy`} />
                </> : null}
            </ScrollView> : null}
            <ScrollView horizontal contentContainerStyle={styles.row}>
                <SegmentedTabBar tabs={[
                    { id: 'touch' as const, label: props.labels.touch },
                    { id: 'modifiers' as const, label: props.labels.modifiers },
                    { id: 'arrows' as const, label: props.labels.arrows },
                    { id: 'clipboard' as const, label: props.labels.clipboard },
                ]} activeTabId={panel} onSelectTab={selectPanel} testIDPrefix={`${testID}-tabs`} compact />
                <IconButton variant="plain" icon={<KeyHint label="Escape" />} accessibilityLabel="Escape"
                    disabled={!props.enabled} onPress={() => { actions.sendKey('Escape'); }} testID={`${testID}-escape`} />
                <IconButton iconName="keyboard" accessibilityLabel={actions.keyboard?.focused
                    ? props.labels.hideKeyboard : props.labels.showKeyboard}
                    selected={actions.keyboard?.focused} disabled={!props.enabled || !actions.keyboard?.available}
                    preserveFocusOnPress
                    onPress={() => { if (actions.keyboard?.focused) actions.keyboard.hideKeyboard(); else actions.keyboard?.showKeyboard(); }}
                    testID={`${testID}-keyboard`} />
            </ScrollView>
        </Surface>
    </View>;
}
