import * as React from 'react';
import { View } from 'react-native';
import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import type { PluginSurfaceActionControls } from './pluginSurfaceActionControls';

const DISPLAY = { primary: 'default', secondary: 'secondary', plain: 'inverted', destructive: 'destructive' } as const satisfies Record<string, RoundButtonDisplay>;

/** Same native host control for both carriers, outside the author-rendered tree/frame. */
export function MountedPluginActionControls({ controls }: Readonly<{ controls: PluginSurfaceActionControls }>) {
    const snapshot = React.useSyncExternalStore(controls.subscribe, controls.getSnapshot, controls.getSnapshot);
    return <>{snapshot.map(control => <View key={control.id}>
        <RoundButton size="normal" title={control.presentation.title}
            display={DISPLAY[control.presentation.variant ?? 'secondary']}
            disabled={control.busy || control.presentation.disabled}
            loading={control.busy}
            testID={`plugin-surface-action-control:${control.id}`}
            onPress={() => { void controls.press(control.id); }} />
    </View>)}</>;
}
