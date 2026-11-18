import * as React from 'react';
import { View } from 'react-native';
import type { PluginUiActionControlPresentationV1 } from '@happier-dev/protocol/plugins/ui';
import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import {
    readPluginActionControlPlacement,
    type MountedPluginActionControl,
    type PluginSurfaceActionControls,
} from './pluginSurfaceActionControls';

const DISPLAY = { primary: 'default', secondary: 'secondary', plain: 'inverted', destructive: 'destructive' } as const satisfies Record<string, RoundButtonDisplay>;

/** The one physical host button for a registered control, in the slot or at its declaration. */
function PluginActionControlButton({ controls, id, presentation, busy }: Readonly<{
    controls: PluginSurfaceActionControls;
    /** Absent until the host admits the registration: the button holds its place but does nothing. */
    id: string | undefined;
    presentation: PluginUiActionControlPresentationV1;
    busy: boolean;
}>) {
    // The host's button for an author's Action.Control stands at the plugin Button's own default size (`normal`, the page
    // control height), so it lines up with the author's Buttons and segmented controls beside it (DBW 02:57Z, Run).
    return <RoundButton size="normal" title={presentation.title}
        accessibilityLabel={presentation.accessibilityLabel}
        display={DISPLAY[presentation.variant ?? 'secondary']}
        disabled={busy || presentation.disabled}
        loading={busy}
        {...(id === undefined ? {} : { testID: `plugin-surface-action-control:${id}` })}
        onPress={() => { if (id !== undefined) void controls.press(id); }} />;
}

/** The mount's slot, outside the author tree/frame: controls no author-tree placement draws (framed carriers). */
export function MountedPluginActionControls({ controls }: Readonly<{ controls: PluginSurfaceActionControls }>) {
    const snapshot = React.useSyncExternalStore(controls.subscribe, controls.getSlotSnapshot, controls.getSlotSnapshot);
    if (snapshot.length === 0) return null;
    // A press at the surface's end, its own width: never a bar across the pane.
    return <View style={BAND_STYLE}>{snapshot.map(control => <View key={control.id}>
        <PluginActionControlButton controls={controls} id={control.id} presentation={control.presentation} busy={control.busy} />
    </View>)}</View>;
}

const NO_CONTROL: MountedPluginActionControl | undefined = undefined;

/**
 * A same-realm `Action.Control` drawn where its author declared it, so it stays inside the presentation
 * (dialog, sheet, pane) that hosts it, in that presentation's focus order. Press authority is unchanged:
 * only this host button reaches `press`.
 */
export function PluginInlineActionControl({ controls, control, presentation }: Readonly<{
    controls: PluginSurfaceActionControls;
    control: object | null;
    presentation: PluginUiActionControlPresentationV1;
}>) {
    const id = control === null ? undefined : readPluginActionControlPlacement(control);
    React.useLayoutEffect(() => id === undefined ? undefined : controls.placeInline(id), [controls, id]);
    const view = React.useSyncExternalStore(controls.subscribe,
        () => id === undefined ? NO_CONTROL : controls.getSnapshot().find(entry => entry.id === id),
        () => id === undefined ? NO_CONTROL : controls.getSnapshot().find(entry => entry.id === id));
    // A bound control the mount no longer offers (Actions unavailable, released) draws nothing, as in the slot.
    if (id !== undefined && view === undefined) return null;
    return <PluginActionControlButton controls={controls} id={view?.id}
        presentation={view?.presentation ?? presentation} busy={view?.busy ?? false} />;
}

// Inset like the page's content, so the press is never cut by the pane's edge or corner.
const BAND_STYLE = { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 } as const;
