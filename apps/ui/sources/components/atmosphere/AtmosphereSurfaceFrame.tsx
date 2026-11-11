import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useDestinationFocus, useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDeviceType } from '@/utils/platform/responsive';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassEnvironmentHold, useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { resolveGlassReadingCoatOpacity } from '@/components/ui/glass/glassMaterial';
import { useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import Color from 'color';
import { useSetting } from '@/sync/store/hooks';
import { HomePlanet } from './HomePlanet';
import { LookChip } from './look/LookChip';
import { useAtmosphere } from './useAtmosphere';
import { useAtmosphereStage, useAtmosphereSendDissolving, atmosphereStageStore, type AtmosphereRect, type AtmosphereStageGeometry } from './atmosphereStage';
import type { AtmosphereSurface } from './resolveAtmosphere';
import type { AtmosphereEditor } from './look/atmosphereEditor';
import { useAppShellContentPane } from '@/components/navigation/shell/appShellContentPane';
import { projectAtmosphereBand } from './atmosphereGeometry';
import { AtmosphereBandBoundary } from './atmosphereBandBoundary';
import { useAtmosphereBackdrop } from './atmosphereBackdrop';

/** Where the page column sits inside this frame, and the frame's own size (null when the frame is the column). */
type AtmosphereOrigin = Readonly<{ x: number; y: number; frame: Readonly<{ width: number; height: number }> | null }>;
const NO_ORIGIN: AtmosphereOrigin = { x: 0, y: 0, frame: null };

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
    /** The corner radius the column's planet is clipped to, when the column is a rounded sheet. */
    columnRadius?: number;
    children: React.ReactNode;
}>) {
    // All New entry points, including blocking guidance, share the shell's sheet.
    const shellPane = useAppShellContentPane();
    const newSessionPane = props.surface === 'new-session' ? shellPane : null;
    const column = props.column ?? newSessionPane?.ref;
    const columnRadius = props.columnRadius ?? (props.column ? 0 : newSessionPane?.radius ?? 0);
    const subscribeColumnLayout = props.column ? undefined : newSessionPane?.subscribeLayout;
    const destinationFocus = useDestinationFocus();
    const destinationVisible = useDestinationVisibility();
    const destinationKey = useDestinationInstanceKey();
    const homeAtmosphere = useSetting('homeAtmosphere');
    const sending = useAtmosphereSendDissolving() && homeAtmosphere.moments.send !== false;
    const enabled = props.enabled !== false;
    const focused = props.focused ?? destinationFocus;
    // Workspace panes expose visibility separately from focus; an ordinary Expo route does not.
    const visible = enabled && (props.visible ?? (destinationKey !== null ? destinationVisible : focused));
    const surface = props.session && typeof props.surface === 'string' ? 'sessions' : props.surface;
    const atmosphere = useAtmosphere(surface, visible);
    const paneRef = React.useRef<View>(null);
    const bandRef = React.useRef<View>(null);
    const [geometry, setGeometry] = React.useState<AtmosphereStageGeometry | null>(null);
    // Where the page column starts inside this frame, which is larger than it when a route spans the window.
    const [columnOrigin, setColumnOrigin] = React.useState<AtmosphereOrigin>(NO_ORIGIN);
    const request = React.useRef(0);
    const writing = React.useRef(false);
    const onLayout = React.useCallback(() => {
        const id = ++request.current;
        void Promise.all([measure(column?.current ?? paneRef.current), measure(bandRef.current),
            column?.current ? measure(paneRef.current) : null]).then(([pane, tabs, frame]) => {
            if (!pane || id !== request.current) return;
            const origin = frame ? { x: pane.x - frame.x, y: pane.y - frame.y, frame: { width: frame.width, height: frame.height } } : NO_ORIGIN;
            setColumnOrigin(previous => previous.x === origin.x && previous.y === origin.y && previous.frame?.width === origin.frame?.width
                && previous.frame?.height === origin.frame?.height ? previous : origin);
            const band = tabs ? projectAtmosphereBand({ pane, tabs }) : 0;
            setGeometry(previous => previous && writing.current && previous.rect.width === pane.width
                && previous.rect.height === pane.height
                ? { ...previous, rect: pane }
                : { rect: pane, band, horizonAt: 0.86,
                    focus: { x: pane.width / 2, y: tabs ? tabs.y + tabs.height / 2 - pane.y : pane.height / 2 } });
        });
    }, [props.session, column]);
    React.useEffect(() => {
        if (!visible) return;
        onLayout();
        const unsubscribe = subscribeColumnLayout?.(onLayout);
        return () => { unsubscribe?.(); request.current++; };
    }, [onLayout, visible, subscribeColumnLayout]);
    // Every visible pane contributes its rectangle, including opaque transcripts. Only a resolved
    // shown place may select the scene; toggling the coat does not recrop its neighbors.
    const backdrop = useAtmosphereBackdrop(atmosphere);
    useAtmosphereStage(visible ? surface : null, geometry, focused, atmosphere.shown, backdrop);
    const onFocusChange = React.useCallback((focused: boolean) => { writing.current = focused; if (!focused) onLayout(); }, [onLayout]);
    // A chosen picture that has not arrived yet stands in as the planet; the room it needs is already the band's.
    // Only a Horizon picture is drawn in that room. A wallpaper already covers the window, so the room would stay empty.
    const pictureRoom = atmosphere.shown && atmosphere.picture.layout !== 'wallpaper'
        && (atmosphere.source === 'picture' || atmosphere.fallbackReason === 'picture-unavailable');
    // The surface's planet (SurfacePlanet) is drawn behind its band, including a chosen picture's stand-in.
    const planet = atmosphere.shown && atmosphere.source === 'planet' && !props.session;
    const boundary = React.useMemo(() => ({ ref: bandRef, onLayout, onFocusChange, pictureRoom, planet, backdrop }), [onLayout, onFocusChange, pictureRoom, planet, backdrop]);
    const target = typeof props.surface === 'object' && 'project' in props.surface && props.editor
        ? { surface: props.surface, editor: props.editor }
        : { surface: 'new-session' as const };
    // A retained destination's glass sleeps through the backing of the tabs shown in its place.
    return <View ref={paneRef} onLayout={onLayout} style={{ flex: 1, minWidth: 0, minHeight: 0 }}><GlassEnvironmentHold presented={visible} carriesAtmosphere={atmosphere.shown && geometry !== null}>
        <GlassSurface noCoat plane surfaceGroup="content" finishRole={null}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }} testID={props.session ? 'session-atmosphere-coat' : 'atmosphere-surface'}>
            {visible && planet && geometry ? <SurfacePlanet surface={props.surface} atmosphere={atmosphere} geometry={geometry} origin={columnOrigin} radius={columnRadius} sending={sending} /> : null}
            <AtmosphereBandBoundary.Provider value={enabled ? boundary : null}>{props.children}</AtmosphereBandBoundary.Provider>
            {enabled && !props.session && props.showLook !== false && typeof props.surface === 'string' ? <View style={{ position: 'absolute', right: 16, top: 14 }}>
                <LookChip target={target} testID="new-session-look" />
            </View> : null}
        </GlassSurface>
    </GlassEnvironmentHold></View>;
}

/** Draw the frame's already resolved planet only while this destination is presented. */
function SurfacePlanet(props: Readonly<{ surface: AtmosphereSurface; atmosphere: ReturnType<typeof useAtmosphere>; geometry: AtmosphereStageGeometry; origin: AtmosphereOrigin; radius: number; sending: boolean }>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const { atmosphere, geometry, sending } = props;
    // On a Project the planet stays an object (DIRECTION: "never a wallpaper"): Home's Corner, clipped to
    // the project pane, rather than a strip of dots squeezed into the header band.
    const project = typeof props.surface === 'object';
    // A Project composes its planet once for the whole frame and the column only crops it: a pane opening beside the
    // Project (the Browser) narrows the view instead of re-composing the planet into the narrow column (RU2 F-3).
    const composed = project && props.origin.frame ? props.origin.frame : { width: geometry.rect.width, height: geometry.rect.height };
    const offset = project && props.origin.frame ? { left: -props.origin.x, top: -props.origin.y } : { left: 0, top: 0 };
    // Its tab pages stand on the same calm coat a picture gets, so the planet's dither never runs under their ink;
    // the band above keeps the planet clear.
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    const coat = project ? resolveGlassReadingCoatOpacity(settings, { ...environment, atmosphereBehind: 'band' }, theme.dark) : 0;
    // The pane crops the planet: it is clipped to the page column, wherever that sits inside the frame.
    return <View testID="surface-planet" pointerEvents="none"
        style={{ position: 'absolute', left: props.origin.x, top: props.origin.y, width: geometry.rect.width, height: geometry.rect.height, borderRadius: props.radius, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', ...offset, width: composed.width, height: composed.height }}>
        <HomePlanet
            pane={composed} placement={project ? 'corner' : atmosphere.planet.placement}
            style={atmosphere.planet.style} digits={atmosphere.planet.digits} theme={theme.dark ? 'dark' : 'light'} phone={phone}
            hero={!project && geometry.band > 0 ? { composerTop: 2 * geometry.focus.y - geometry.band, aboveBottom: geometry.band, nextTop: null } : null}
            hidden={sending} onHidden={sending ? atmosphereStageStore.finishSendDissolve : undefined} leave={sending ? 'climb' : 'fade'} reducedMotion={atmosphere.reducedMotion} />
        </View>
        {coat > 0 ? <View testID="surface-planet-coat" pointerEvents="none" style={{ position: 'absolute', top: geometry.band, left: 0, right: 0, bottom: 0,
            backgroundColor: Color(theme.colors.surface.base).alpha(coat).rgb().string() }} /> : null}
    </View>;
}
