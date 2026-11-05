import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useDestinationFocus, useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDeviceType } from '@/utils/platform/responsive';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useSetting } from '@/sync/store/hooks';
import { HomePlanet } from './HomePlanet';
import { LookChip } from './look/LookChip';
import { useAtmosphere } from './useAtmosphere';
import { useAtmosphereStage, useAtmosphereSending, type AtmosphereRect, type AtmosphereStageGeometry } from './atmosphereStage';
import type { AtmosphereSurface } from './resolveAtmosphere';
import type { AtmosphereEditor } from './look/atmosphereEditor';
import { projectAtmosphereBand } from './atmosphereGeometry';
import { AtmosphereBandBoundary } from './atmosphereBandBoundary';

function measure(node: View | null): Promise<AtmosphereRect | null> {
    return new Promise(resolve => node ? node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height })) : resolve(null));
}

/** Surface geometry and controls only: the shell remains the sole picture renderer. */
export function AtmosphereSurfaceFrame(props: Readonly<{
    surface: AtmosphereSurface;
    enabled?: boolean;
    focused?: boolean;
    visible?: boolean;
    session?: boolean;
    editor?: AtmosphereEditor;
    /** False when the surface seats Look itself (the floating New Session composer's status row). */
    showLook?: boolean;
    /** The column that holds the band when the frame wraps more than that column (a Project beside its editor). */
    column?: React.RefObject<View | null>;
    children: React.ReactNode;
}>) {
    const destinationFocus = useDestinationFocus();
    const destinationVisible = useDestinationVisibility();
    const destinationKey = useDestinationInstanceKey();
    const homeAtmosphere = useSetting('homeAtmosphere');
    const sending = useAtmosphereSending() && homeAtmosphere.moments.send !== false;
    const enabled = props.enabled !== false;
    const focused = props.focused ?? destinationFocus;
    // Workspace panes expose visibility separately from focus; an ordinary Expo route does not.
    const visible = enabled && (props.visible ?? (destinationKey !== null ? destinationVisible : focused));
    const surface = props.session && typeof props.surface === 'string' ? 'sessions' : props.surface;
    const atmosphere = useAtmosphere(surface, visible);
    const paneRef = React.useRef<View>(null);
    const bandRef = React.useRef<View>(null);
    const [geometry, setGeometry] = React.useState<AtmosphereStageGeometry | null>(null);
    const request = React.useRef(0);
    const writing = React.useRef(false);
    const onLayout = React.useCallback(() => {
        const id = ++request.current;
        void Promise.all([measure(props.column?.current ?? paneRef.current), measure(bandRef.current)]).then(([pane, tabs]) => {
            if (!pane || id !== request.current) return;
            const band = tabs ? projectAtmosphereBand({ pane, tabs }) : 0;
            setGeometry(previous => previous && writing.current && previous.rect.width === pane.width
                && previous.rect.height === pane.height
                ? { ...previous, rect: pane }
                : { rect: pane, band, horizonAt: 0.86,
                    focus: { x: pane.width / 2, y: tabs ? tabs.y + tabs.height / 2 - pane.y : pane.height / 2 } });
        });
    }, [props.session, props.column]);
    React.useEffect(() => { onLayout(); return () => { request.current++; }; }, [onLayout, visible]);
    // Every visible pane contributes its rectangle, including opaque transcripts. Only an atmosphere
    // surface (or the session opt-in) may select the scene; toggling the coat does not recrop its neighbors.
    useAtmosphereStage(visible ? surface : null, geometry, focused, atmosphere.shown);
    const onFocusChange = React.useCallback((focused: boolean) => { writing.current = focused; if (!focused) onLayout(); }, [onLayout]);
    const boundary = React.useMemo(() => ({ ref: bandRef, onLayout, onFocusChange }), [onLayout, onFocusChange]);
    const target = typeof props.surface === 'object' && 'project' in props.surface && props.editor
        ? { surface: props.surface, editor: props.editor }
        : { surface: 'new-session' as const };
    return <View ref={paneRef} onLayout={onLayout} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <GlassSurface noCoat plane surfaceGroup="content" finishRole={null}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }} testID={props.session ? 'session-atmosphere-coat' : 'atmosphere-surface'}>
            {visible && !props.session && geometry ? <SurfacePlanet surface={surface} atmosphere={atmosphere} geometry={geometry} sending={sending} /> : null}
            <AtmosphereBandBoundary.Provider value={enabled ? boundary : null}>{props.children}</AtmosphereBandBoundary.Provider>
            {enabled && !props.session && props.showLook !== false && typeof props.surface === 'string' ? <View style={{ position: 'absolute', right: 16, top: 14 }}>
                <LookChip target={target} testID="new-session-look" />
            </View> : null}
        </GlassSurface>
    </View>;
}

/** Resolve device picture availability and draw only while this destination is presented. */
function SurfacePlanet(props: Readonly<{ surface: AtmosphereSurface; atmosphere: ReturnType<typeof useAtmosphere>; geometry: AtmosphereStageGeometry; sending: boolean }>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const atmosphere = props.atmosphere;
    const { geometry, sending } = props;
    if (atmosphere.source !== 'planet') return null;
    return <HomePlanet
        pane={{ width: geometry.rect.width, height: geometry.rect.height }} placement={atmosphere.planet.placement}
        style={atmosphere.planet.style} digits={atmosphere.planet.digits} theme={theme.dark ? 'dark' : 'light'} phone={phone}
        hero={geometry.band > 0 ? { composerTop: 2 * geometry.focus.y - geometry.band, aboveBottom: geometry.band, nextTop: null } : null}
        band={typeof props.surface === 'object' && geometry.band > 0 ? geometry.band : undefined}
        hidden={sending} leave={sending ? 'climb' : 'fade'} reducedMotion={atmosphere.reducedMotion} />;
}
