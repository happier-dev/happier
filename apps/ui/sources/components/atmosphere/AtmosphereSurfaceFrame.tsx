import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { planetGlyphLayer, type PlanetIntensity } from '@happier-dev/brand/glyph-scene';
import { projectPlanetGeometry, type HomePane } from '@happier-dev/brand/planet-placement';
import { useDestinationFocus, useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDeviceType } from '@/utils/platform/responsive';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassEnvironmentHold } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useSetting } from '@/sync/store/hooks';
import { HomePlanet } from './HomePlanet';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { GlyphSurface } from './glyph/GlyphSurface';
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
    // A frame without a planet (a Session's) draws nothing from visibility inside its glass: the coat and its
    // content keep their element, so a tab switch renders only this frame and its hold.
    const planetGeometry = visible && planet ? geometry : null;
    const planetAtmosphere = planetGeometry ? atmosphere : null;
    const editor = props.editor;
    const surfaceProp = props.surface;
    const lookShown = enabled && !props.session && props.showLook !== false && typeof props.surface === 'string';
    const glass = React.useMemo(() => {
        const target = typeof surfaceProp === 'object' && 'project' in surfaceProp && editor
            ? { surface: surfaceProp, editor }
            : { surface: 'new-session' as const };
        return <GlassSurface noCoat plane surfaceGroup="content" finishRole={null}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }} testID={props.session ? 'session-atmosphere-coat' : 'atmosphere-surface'}>
            {planetGeometry && planetAtmosphere ? <SurfacePlanet surface={surfaceProp} atmosphere={planetAtmosphere} geometry={planetGeometry} origin={columnOrigin} radius={columnRadius} sending={sending} /> : null}
            <AtmosphereBandBoundary.Provider value={enabled ? boundary : null}>{props.children}</AtmosphereBandBoundary.Provider>
            {lookShown ? <View style={{ position: 'absolute', right: 16, top: 14 }}>
                <LookChip target={target} testID="new-session-look" />
            </View> : null}
        </GlassSurface>;
    }, [planetAtmosphere, boundary, columnOrigin, columnRadius, editor, enabled, lookShown, planetGeometry, props.children, props.session,
        sending, surfaceProp]);
    // A retained destination's glass sleeps through the backing of the tabs shown in its place.
    return <View ref={paneRef} onLayout={onLayout} style={{ flex: 1, minWidth: 0, minHeight: 0 }}><GlassEnvironmentHold presented={visible} carriesAtmosphere={atmosphere.shown && geometry !== null}>
        {glass}
    </GlassEnvironmentHold></View>;
}

/** Draw the frame's already resolved planet only while this destination is presented. */
function SurfacePlanet(props: Readonly<{ surface: AtmosphereSurface; atmosphere: ReturnType<typeof useAtmosphere>; geometry: AtmosphereStageGeometry; origin: AtmosphereOrigin; radius: number; sending: boolean }>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const { atmosphere, geometry, origin, sending } = props;
    const project = typeof props.surface === 'object' && 'project' in props.surface;
    const { width, height } = geometry.rect;
    const drawHeight = project ? Math.min(geometry.band, height) : height;
    if (drawHeight <= 0 || width <= 0) return null;
    const pane = { width, height };
    const look = {
        intensity: atmosphere.planet.intensity, digits: atmosphere.planet.digits, phone,
        theme: theme.dark ? 'dark' as const : 'light' as const, reducedMotion: atmosphere.reducedMotion,
    };
    return <View testID="surface-planet" pointerEvents="none"
        style={{ position: 'absolute', left: origin.x, top: origin.y, width, height: drawHeight, borderRadius: props.radius, overflow: 'hidden' }}>
        {project ? <ProjectBandPlanet {...look} pane={origin.frame ?? pane} origin={origin} height={drawHeight} sending={sending} /> : (
            <HomePlanet {...look} pane={pane}
                hero={geometry.band > 0 ? { composerTop: 2 * geometry.focus.y - geometry.band, aboveBottom: geometry.band, nextTop: null } : null}
                hidden={sending} onHidden={sending ? atmosphereStageStore.finishSendDissolve : undefined} leave={sending ? 'climb' : 'fade'} />
        )}
    </View>;
}

function ProjectBandPlanet({ pane, origin, height, phone, intensity, digits, theme, sending, reducedMotion }: Readonly<{
    pane: HomePane; origin: AtmosphereOrigin; height: number; phone: boolean; intensity: PlanetIntensity; digits: boolean;
    theme: 'light' | 'dark'; sending: boolean; reducedMotion: boolean;
}>) {
    const scene = React.useMemo(() => {
        // The full frame owns the pose, so opening the Browser only changes the crop. The measured
        // header owns the canvas height, so there is no glyph ink behind the tab body.
        const pose = projectPlanetGeometry({ width: pane.width, height: pane.height }, { phone });
        const layer = planetGlyphLayer({ geometry: { ...pose, cy: pose.cy - origin.y }, intensity, digits, soft: phone });
        return () => [layer];
    }, [digits, intensity, origin.y, pane.height, pane.width, phone]);
    return <AtmosphereDissolve visible={!sending} leave={sending ? 'climb' : 'fade'} height={height} reducedMotion={reducedMotion}
        onHidden={sending ? atmosphereStageStore.finishSendDissolve : undefined}
        style={{ position: 'absolute', left: -origin.x, top: 0, width: pane.width, height }}>
        <GlyphSurface width={pane.width} height={height} scene={scene} theme={theme} testID="project-band-planet" />
    </AtmosphereDissolve>;
}
