import { DEFAULT_HOME_ATMOSPHERE, atmospherePresentation, type AtmospherePlace, type AtmospherePresentation, type HomeAtmosphere, type ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import type { GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { builtinPictureLocalId, builtinThumbnailLocalId, pictureSourceMatches } from './ensureBuiltinPicture';
import type { BuiltinPicture, PictureRecord } from './pictureStore.types';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { MOMENT_TRIGGER_WINDOWS_MS } from '@happier-dev/brand/planet-moments';

export type AtmosphereProject = Readonly<{ serverId: string; projectKey: string }>;
export type AtmosphereSurface = AtmospherePlace
    | Readonly<{ project: AtmosphereProject; place?: AtmospherePlace }>
    | Readonly<{ session: Readonly<{ serverId: string; sessionId: string }>; place?: 'sessions' | 'pages' }>
    | Readonly<{ place: AtmospherePlace }>;
/** Profile previews resolve the same presentation but never register as an app-shell atmosphere stage. */
export type AtmosphereTarget = AtmosphereSurface | Readonly<{ publicProfile: AtmospherePresentation; draftServerId?: string }>;
export type ResolvedAtmosphere<TPicture extends BuiltinPicture = BuiltinPicture> = HomeAtmosphere & Readonly<{
    shown: boolean;
    atmosphereBehind: 'none' | 'band' | 'wallpaper';
    pictureRecord: PictureRecord | null;
    builtinPicture: TPicture | null;
    reducedMotion: boolean;
    reduceTransparency: boolean;
    fallbackReason: 'unknown-picture' | 'picture-unavailable' | null;
}>;

export function atmospherePlace(surface: AtmosphereTarget): AtmospherePlace {
    return typeof surface === 'string' ? surface : 'place' in surface && surface.place ? surface.place
        : 'project' in surface ? 'projects' : 'session' in surface ? 'sessions' : 'home';
}

export function atmosphereSurfaceKey(surface: AtmosphereSurface): string {
    const place = atmospherePlace(surface);
    return typeof surface === 'string' ? place : 'project' in surface ? JSON.stringify([place, surface.project.serverId, surface.project.projectKey])
        : 'session' in surface ? JSON.stringify([place, surface.session.serverId, surface.session.sessionId]) : place;
}

/** Shared by acquisition and rendering: an excluded place never demands picture bytes. */
export function isAtmosphereShown(surface: AtmosphereTarget, settings: HomeAtmosphere): boolean {
    if (typeof surface === 'object' && 'publicProfile' in surface) return settings.source !== 'none';
    const place = atmospherePlace(surface);
    return settings.source !== 'none' && settings.showOn.includes(place)
        && (settings.source !== 'planet' || place !== 'sessions' && place !== 'pages');
}

/** A display rotates its chosen built-in picture by elapsed time since the local choice first appeared. */
export function homeIdleResettlePicture(home: HomeAtmosphere, rotationElapsedMs: number): Extract<AtmospherePresentation['picture']['ref'], { kind: 'builtin' }> | null {
    if (home.source !== 'picture' || home.picture.ref.kind !== 'builtin' || home.moments.idleResettle === false) return null;
    // Device-specific plugin catalogs never change this shared sequence; contributed pictures keep their selection.
    const chosenId = home.picture.ref.id;
    const index = ATMOSPHERE_PICTURES.findIndex(picture => picture.id === chosenId);
    if (index < 0) return null;
    const window = Math.floor(Math.max(0, rotationElapsedMs) / MOMENT_TRIGGER_WINDOWS_MS.resettle);
    return { kind: 'builtin', id: ATMOSPHERE_PICTURES[(index + window) % ATMOSPHERE_PICTURES.length]!.id };
}

/** Projects inherit moment switches from Home; their presentation override is otherwise complete. */
export function selectAtmosphereSettings(surface: AtmosphereTarget, home: HomeAtmosphere,
    projectOverride?: 'home' | ProjectAtmosphere, rotationElapsedMs = 0): HomeAtmosphere {
    if (typeof surface === 'object' && 'publicProfile' in surface) {
        return { ...atmospherePresentation(surface.publicProfile), showOn: [], moments: {} };
    }
    if (typeof surface === 'object' && 'project' in surface && projectOverride && projectOverride !== 'home') {
        return { ...projectOverride, moments: home.moments };
    }
    if (!isAtmosphereShown(surface, home)) return home;
    const ref = homeIdleResettlePicture(home, rotationElapsedMs);
    return !ref || home.picture.ref.kind === 'builtin' && ref.id === home.picture.ref.id
        ? home : { ...home, picture: { ...home.picture, ref } };
}

export function atmospherePictureLocalId(settings: AtmospherePresentation): string | null {
    if (settings.source !== 'picture') return null;
    return settings.picture.ref.kind === 'builtin' ? builtinPictureLocalId(settings.picture.ref.id) : settings.picture.ref.localId;
}

/** One decision owner for every route place, its effective atmosphere, device bytes and accessibility. */
export function resolveAtmosphere<TPicture extends BuiltinPicture>(input: Readonly<{
    surface: AtmosphereTarget;
    home: HomeAtmosphere;
    projectOverride?: 'home' | ProjectAtmosphere;
    pictures: readonly TPicture[];
    pictureRecord?: PictureRecord;
    shownPicture?: ResolvedAtmosphere<TPicture> | null;
    readingPicture?: boolean;
    pictureAcquisitionFailed?: boolean;
    glassEnvironment: GlassMaterialEnvironment;
    reduceTransparency: boolean;
    reducedMotion: boolean;
    /** Mounted consumers hold the admitted elapsed rotation time between idle resettles. */
    rotationElapsedMs?: number;
}>): ResolvedAtmosphere<TPicture> {
    let settings = selectAtmosphereSettings(input.surface, input.home, input.projectOverride, input.rotationElapsedMs);
    const profile = typeof input.surface === 'object' && 'publicProfile' in input.surface;
    let fallbackReason: ResolvedAtmosphere['fallbackReason'] = null;
    let builtinPicture: TPicture | null = null;
    let pictureRecord: PictureRecord | null = null;
    if (!isAtmosphereShown(input.surface, settings)) settings = { ...settings, source: 'none' };
    if (settings.source === 'picture') {
        const ref = settings.picture.ref;
        builtinPicture = ref.kind === 'builtin' ? input.pictures.find(picture => picture.id === ref.id) ?? null : null;
        if (ref.kind === 'builtin' && !builtinPicture) fallbackReason = 'unknown-picture';
        else if (!input.pictureRecord || (input.pictureRecord.localId !== atmospherePictureLocalId(settings)
            && !(ref.kind === 'builtin' && !input.pictureAcquisitionFailed
                && input.pictureRecord.localId === builtinThumbnailLocalId(ref.id)))
            || input.pictureRecord.kind !== ref.kind
            || (builtinPicture && !pictureSourceMatches(input.pictureRecord.source, builtinPicture.src))) fallbackReason = 'picture-unavailable';
        else pictureRecord = input.pictureRecord;
        // Retain only the available image's identity/bytes; all settings and environment decisions
        // below are current, including layout, accessibility, phone placement and moments.
        if (!profile && fallbackReason === 'picture-unavailable' && input.readingPicture) {
            if (input.shownPicture?.pictureRecord) {
                settings = { ...settings, picture: { ...settings.picture, ref: input.shownPicture.picture.ref } };
                pictureRecord = input.shownPicture.pictureRecord;
                builtinPicture = input.shownPicture.builtinPicture;
            }
            fallbackReason = null;
        }
        if (fallbackReason) settings = profile
            ? { ...settings, source: 'none' }
            : { ...settings, source: 'planet', planet: DEFAULT_HOME_ATMOSPHERE.planet };
    }
    const reduceTransparency = input.reduceTransparency || input.glassEnvironment.reduceTransparency === true;
    const shown = isAtmosphereShown(input.surface, settings);
    const atmosphereBehind = !shown ? 'none' : settings.source === 'picture' && settings.picture.layout === 'wallpaper' ? 'wallpaper' : 'band';
    return { ...settings, source: shown ? settings.source : 'none', pictureRecord: shown ? pictureRecord : null,
        builtinPicture: shown ? builtinPicture : null, shown, atmosphereBehind,
        reducedMotion: input.reducedMotion, reduceTransparency, fallbackReason };
}
