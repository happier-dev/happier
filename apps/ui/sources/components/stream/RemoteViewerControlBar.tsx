import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { gestureTokens } from '@/components/ui/motion/gestureTokens';
import { t } from '@/text';

import type { RemoteViewerStageControls } from './RemoteViewerStage';
import { REMOTE_VIEWER_KEYS, type RemoteViewerActions, type RemoteViewerModifier } from './useRemoteViewerActions';

type Panel = 'touch' | 'modifiers' | 'arrows' | 'clipboard';
const styles = StyleSheet.create(theme => ({
    root: { position: 'absolute', left: theme.space.s12, right: theme.space.s12, bottom: theme.space.s12, zIndex: 3 },
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));

/** The viewer's existing action owner, presented as the same tabs and expanding panels on every screen. */
export function RemoteViewerControlBar(props: Readonly<{
    actions: RemoteViewerActions;
    controls: RemoteViewerStageControls;
    enabled: boolean;
    testID: string;
}>) {
    const [panel, setPanel] = React.useState<Panel | ''>('touch');
    const lastModifierTap = React.useRef<Readonly<{ modifier: RemoteViewerModifier; at: number }> | null>(null);
    const { actions, controls, testID } = props;
    const { Surface, Button } = CORE_CAPSULE_HOST;
    const modifiers = (Object.keys(actions.modifiers) as RemoteViewerModifier[])
        .filter(modifier => !actions.supportedModifiers || actions.supportedModifiers.includes(modifier));
    const selectPanel = React.useCallback((next: Panel | '') => setPanel(current => current === next ? '' : next), []);
    const tapModifier = (modifier: RemoteViewerModifier) => {
        const at = Date.now();
        const previous = lastModifierTap.current;
        const doubleTap = actions.modifiers[modifier] !== 'locked' && previous?.modifier === modifier
            && at - previous.at <= gestureTokens.doubleTapMs;
        lastModifierTap.current = doubleTap ? null : { modifier, at };
        actions.tapModifier(modifier, doubleTap ? { clickCount: 2 } : undefined);
    };
    return <View style={styles.root} testID={testID}>
        <Surface elevation="low" testID={`${testID}-surface`}>
            {panel ? <ScrollView horizontal contentContainerStyle={styles.row}>
                {panel === 'touch' ? <>
                    <SegmentedTabBar tabs={[
                        { id: 'direct' as const, label: t('browserPresence.stream.directMode') },
                        { id: 'trackpad' as const, label: t('browserPresence.stream.trackpadMode') },
                    ]} activeTabId={controls.mode} onSelectTab={controls.setMode} testIDPrefix={`${testID}-mode`} compact />
                    <Button emphasis="plain" title={t('browserPresence.stream.resetZoom')} onPress={controls.resetZoom} testID={`${testID}-reset-zoom`} />
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
                    <Button emphasis="plain" title={t('browserPresence.remoteControls.sendClipboard')}
                        disabled={!props.enabled || !actions.clipboard.available} onPress={async () => { await actions.sendClipboard(); }} testID={`${testID}-paste`} />
                    <Button emphasis="plain" title={t('browserPresence.remoteControls.receiveClipboard')}
                        disabled={!props.enabled || !actions.clipboard.available} onPress={async () => { await actions.receiveClipboard(); }} testID={`${testID}-copy`} />
                </> : null}
            </ScrollView> : null}
            <ScrollView horizontal contentContainerStyle={styles.row}>
                <SegmentedTabBar tabs={[
                    { id: 'touch' as const, label: t('browserPresence.remoteControls.touch') },
                    { id: 'modifiers' as const, label: t('browserPresence.remoteControls.modifiers') },
                    { id: 'arrows' as const, label: t('browserPresence.remoteControls.arrows') },
                    { id: 'clipboard' as const, label: t('browserPresence.remoteControls.clipboard') },
                ]} activeTabId={panel} onSelectTab={selectPanel} testIDPrefix={`${testID}-tabs`} compact />
                <IconButton variant="plain" icon={<KeyHint label="Escape" />} accessibilityLabel="Escape"
                    disabled={!props.enabled} onPress={() => { actions.sendKey('Escape'); }} testID={`${testID}-escape`} />
                <IconButton iconName="keyboard" accessibilityLabel={actions.keyboard?.focused
                    ? t('browserPresence.remoteControls.hideKeyboard') : t('browserPresence.interaction.showKeyboard')}
                    selected={actions.keyboard?.focused} disabled={!props.enabled || !actions.keyboard?.available}
                    preserveFocusOnPress
                    onPress={() => { if (actions.keyboard?.focused) actions.keyboard.hideKeyboard(); else actions.keyboard?.showKeyboard(); }}
                    testID={`${testID}-keyboard`} />
            </ScrollView>
        </Surface>
    </View>;
}
