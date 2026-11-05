import { DEFAULT_HOME_ATMOSPHERE, atmospherePresentation, type AtmospherePlace, type AtmospherePresentation, type HomeAtmosphere, type ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import type { GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { builtinPictureLocalId, pictureSourceMatches } from './ensureBuiltinPicture';
import type { BuiltinPicture, PictureRecord } from './pictureStore.types';

export type AtmosphereProject = Readonly<{ serverId: string; projectKey: string }>;
export type AtmosphereSurface = AtmospherePlace
    | Readonly<{ project: AtmosphereProject; place?: AtmospherePlace }>
    | Readonly<{ session: Readonly<{ serverId: string; sessionId: string }>; place?: 'sessions' | 'pages' }>
    | Readonly<{ place: AtmospherePlace }>;
/** Profile previews resolve the same presentation but never register as an app-shell atmosphere stage. */
export type AtmosphereTarget = AtmosphereSurface | Readonly<{ publicProfile: AtmospherePresentation }>;
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

/** Projects inherit moment switches from Home; their presentation override is otherwise complete. */
export function selectAtmosphereSettings(surface: AtmosphereTarget, home: HomeAtmosphere,
    projectOverride?: 'home' | ProjectAtmosphere): HomeAtmosphere {
    if (typeof surface === 'object' && 'publicProfile' in surface) {
        return { ...atmospherePresentation(surface.publicProfile), showOn: [], moments: {} };
    }
    if (typeof surface === 'object' && 'project' in surface && projectOverride && projectOverride !== 'home') {
        return { ...projectOverride, moments: home.moments };
    }
    return home;
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
    isPhone: boolean;
    glassEnvironment: GlassMaterialEnvironment;
    reduceTransparency: boolean;
    reducedMotion: boolean;
}>): ResolvedAtmosphere<TPicture> {
    let settings = selectAtmosphereSettings(input.surface, input.home, input.projectOverride);
    const profile = typeof input.surface === 'object' && 'publicProfile' in input.surface;
    let fallbackReason: ResolvedAtmosphere['fallbackReason'] = null;
    let builtinPicture: TPicture | null = null;
    let pictureRecord: PictureRecord | null = null;
    if (!isAtmosphereShown(input.surface, settings)) settings = { ...settings, source: 'none' };
    if (settings.source === 'picture') {
        const ref = settings.picture.ref;
        builtinPicture = ref.kind === 'builtin' ? input.pictures.find(picture => picture.id === ref.id) ?? null : null;
        if (ref.kind === 'builtin' && !builtinPicture) fallbackReason = 'unknown-picture';
        else if (!input.pictureRecord || input.pictureRecord.localId !== atmospherePictureLocalId(settings)
            || input.pictureRecord.kind !== ref.kind
            || (builtinPicture && !pictureSourceMatches(input.pictureRecord.source, builtinPicture.src))) fallbackReason = 'picture-unavailable';
        else pictureRecord = input.pictureRecord;
        // Retain only the available image's identity/bytes; all settings and environment decisions
        // below are current, including layout, accessibility, phone placement and moments.
        if (!profile && fallbackReason === 'picture-unavailable' && input.readingPicture && input.shownPicture?.pictureRecord) {
            settings = { ...settings, picture: { ...settings.picture, ref: input.shownPicture.picture.ref } };
            pictureRecord = input.shownPicture.pictureRecord;
            builtinPicture = input.shownPicture.builtinPicture;
            fallbackReason = null;
        }
        if (fallbackReason) settings = profile
            ? { ...settings, source: 'none' }
            : { ...DEFAULT_HOME_ATMOSPHERE, moments: input.home.moments };
    }
    const planet = input.isPhone && settings.planet.placement === 'rise'
        ? { ...settings.planet, placement: 'corner' as const } : settings.planet;
    const reduceTransparency = input.reduceTransparency || input.glassEnvironment.reduceTransparency === true;
    const shown = isAtmosphereShown(input.surface, settings);
    const atmosphereBehind = !shown ? 'none' : settings.source === 'picture' && settings.picture.layout === 'wallpaper' ? 'wallpaper' : 'band';
    return { ...settings, source: shown ? settings.source : 'none', planet, pictureRecord: shown ? pictureRecord : null,
        builtinPicture: shown ? builtinPicture : null, shown, atmosphereBehind,
        reducedMotion: input.reducedMotion, reduceTransparency, fallbackReason };
}
