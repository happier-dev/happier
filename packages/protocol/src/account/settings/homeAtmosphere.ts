import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

export const ATMOSPHERE_PLACES = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
export type AtmospherePlace = typeof ATMOSPHERE_PLACES[number];
export const AtmosphereShowOnSchema = lazyDefinition(() => z.array(z.enum(ATMOSPHERE_PLACES))
    .check(z.refine(places => new Set(places).size === places.length)));

/** Defaults belong to the authored layout, independent of glass or device availability. */
export function defaultAtmosphereShowOn(layout: 'horizon' | 'wallpaper'): AtmospherePlace[] {
    return layout === 'wallpaper' ? [...ATMOSPHERE_PLACES] : ['home', 'new-session', 'projects'];
}

function readAtmospherePlaces(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const showOn = AtmosphereShowOnSchema.safeParse(Reflect.get(value, 'showOn'));
    const picture: unknown = Reflect.get(value, 'picture');
    const wallpaper = picture && typeof picture === 'object' && Reflect.get(picture, 'layout') === 'wallpaper';
    return { ...value, showOn: showOn.success ? showOn.data : defaultAtmosphereShowOn(wallpaper ? 'wallpaper' : 'horizon') };
}

const PlanetSchema = lazyDefinition(() => z.strictObject({
    placement: z.enum(['corner', 'side', 'rise']), style: z.enum(['airy', 'balanced', 'rich']), digits: z.boolean(),
}));
export const AtmospherePictureRefSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('builtin'), id: z.string() }),
        z.strictObject({ kind: z.literal('user'), localId: z.string() }),
    ]));
export const AtmospherePictureSchema = lazyDefinition(() => z.strictObject({
    ref: AtmospherePictureRefSchema,
    layout: z.enum(['horizon', 'wallpaper']),
}));
export const AtmosphereLookOverrideSchema = lazyDefinition(() => z.strictObject({
    look: z.optional(z.enum(['original', 'fine', 'painted-fine', 'halftone', 'mosaic', 'painted', 'haze', 'engraving'])),
    strength: z.optional(defineStoredReadProjection(z.number().check(z.minimum(0), z.maximum(1)), () => z.number())),
    dissolve: z.optional(z.enum(['ordered', 'gradient', 'haze', 'shrink', 'rows'])),
}));
/** Presentation shared by contextual editors; context lifecycle switches stay with their owners. */
export const AtmospherePresentationSchema = lazyDefinition(() => z.strictObject({
    source: z.enum(['none', 'planet', 'picture']), planet: PlanetSchema, picture: AtmospherePictureSchema,
    looks: z.record(z.string(), AtmosphereLookOverrideSchema),
}));
const ProjectAtmosphereObjectSchema = lazyDefinition(() => z.strictObject({
    ...AtmospherePresentationSchema.shape, showOn: AtmosphereShowOnSchema,
}));
export const ProjectAtmosphereSchema = defineStoredReadProjection(ProjectAtmosphereObjectSchema,
    () => z.pipe(z.transform(readAtmospherePlaces), createStoredReadSchema(z.strictObject(ProjectAtmosphereObjectSchema.shape))));
const HomeAtmosphereObjectSchema = lazyDefinition(() => z.strictObject({
    ...ProjectAtmosphereObjectSchema.shape, moments: z.record(z.string(), z.boolean()),
}));
export const HomeAtmosphereSchema = defineStoredReadProjection(HomeAtmosphereObjectSchema,
    () => z.pipe(z.transform(readAtmospherePlaces), createStoredReadSchema(z.strictObject(HomeAtmosphereObjectSchema.shape))));
export type HomeAtmosphere = z.infer<typeof HomeAtmosphereSchema>;
export type ProjectAtmosphere = z.infer<typeof ProjectAtmosphereSchema>;
export type AtmosphereLookOverride = z.infer<typeof AtmosphereLookOverrideSchema>;
export type AtmospherePresentation = z.infer<typeof AtmospherePresentationSchema>;

/** A layout's untouched default follows the new layout; deliberate custom place sets survive. */
export function applyAtmosphereLayoutDefault<T extends AtmospherePresentation & { showOn?: AtmospherePlace[] }>(
    current: AtmospherePresentation & { showOn?: readonly AtmospherePlace[] }, next: T,
): T {
    if (current.picture.layout === next.picture.layout || !current.showOn || !next.showOn) return next;
    const previousDefault = defaultAtmosphereShowOn(current.picture.layout);
    const samePlaces = (left: readonly AtmospherePlace[], right: readonly AtmospherePlace[]) =>
        left.length === right.length && left.every(place => right.includes(place));
    return samePlaces(current.showOn, previousDefault) && samePlaces(next.showOn, current.showOn)
        ? { ...next, showOn: defaultAtmosphereShowOn(next.picture.layout) } : next;
}

export const DEFAULT_HOME_ATMOSPHERE: HomeAtmosphere = {
    source: 'planet', planet: { placement: 'corner', style: 'balanced', digits: true },
    picture: { ref: { kind: 'builtin', id: 'white-rocks-open-sea' }, layout: 'horizon' }, looks: {}, showOn: defaultAtmosphereShowOn('horizon'),
    moments: { welcome: true, loading: true, send: true, qr: true, pairing: true, themeSwitch: true,
        sessionFinished: true, idleResettle: true, releaseCaption: true, yourHome: true },
};

export function atmospherePresentation(value: AtmospherePresentation): AtmospherePresentation {
    return { source: value.source, planet: value.planet, picture: value.picture, looks: value.looks };
}
