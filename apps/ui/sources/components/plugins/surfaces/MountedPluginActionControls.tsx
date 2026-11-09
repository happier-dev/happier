import * as React from 'react';
import { View } from 'react-native';
import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import type { PluginSurfaceActionControls } from './pluginSurfaceActionControls';

const DISPLAY = { primary: 'default', secondary: 'secondary', plain: 'inverted', destructive: 'destructive' } as const satisfies Record<string, RoundButtonDisplay>;

/** Same native host control for both carriers, outside the author-rendered tree/frame. */
export function MountedPluginActionControls({ controls }: Readonly<{ controls: PluginSurfaceActionControls }>) {
    const snapshot = React.useSyncExternalStore(controls.subscribe, controls.getSnapshot, controls.getSnapshot);
    if (snapshot.length === 0) return null;
    // A press at the surface's end, its own width: never a bar across the pane.
    return <View style={BAND_STYLE}>{snapshot.map(control => <View key={control.id}>
        <RoundButton size="small" title={control.presentation.title}
            display={DISPLAY[control.presentation.variant ?? 'secondary']}
            disabled={control.busy || control.presentation.disabled}
            loading={control.busy}
            testID={`plugin-surface-action-control:${control.id}`}
            onPress={() => { void controls.press(control.id); }} />
    </View>)}</View>;
}

// Inset like the page's content, so the press is never cut by the pane's edge or corner.
const BAND_STYLE = { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 } as const;
