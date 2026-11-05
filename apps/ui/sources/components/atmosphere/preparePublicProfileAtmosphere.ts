import { ATMOSPHERE_HORIZON_FADE_FROM, ATMOSPHERE_LOOKS, resolveParams, type AtmospherePicture } from '@happier-dev/brand/atmosphere';
import { AtmospherePresentationSchema, atmospherePresentation, type AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { PublicProfilePictureCreditUrlV1Schema, PublicProfilePictureDescriptorV1Schema, PublicProfilePreparedAtmosphereV1Schema, type PublicProfilePreparedAtmosphereV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { encodeBase64 } from '@/encryption/base64';
import { t } from '@/text';
import type { PictureStore } from './pictureStore.types';
import { atmospherePictureLocalId, resolveAtmosphere } from './resolveAtmosphere';
import { effectivePictureLook, pictureHazeIsAdaptive } from './look/atmosphereEdits';

export type PreparedProfileAtmosphereResult =
    | Readonly<{ status: 'ready'; value: PublicProfilePreparedAtmosphereV1 }>
    | Readonly<{ status: 'unavailable'; reason: 'account_retired' | 'picture_unavailable' | 'picture_normalization_failed' }>;

/** Pure selection and local byte preparation; public transport belongs to the reviewed Account dispatcher. */
export async function preparePublicProfileAtmosphere(input: Readonly<{
    presentation: AtmospherePresentation;
    pictures: readonly AtmospherePicture[];
    store: Pick<PictureStore, 'get' | 'prepare'>;
    isCurrent(): boolean;
}>): Promise<PreparedProfileAtmosphereResult> {
    if (!input.isCurrent()) return { status: 'unavailable', reason: 'account_retired' };
    // Parsing makes a detached candidate before any asynchronous device I/O or catalog change.
    const presentation = AtmospherePresentationSchema.parse(atmospherePresentation(input.presentation));
    if (presentation.source === 'none') return { status: 'ready', value: { source: 'none' } };
    if (presentation.source === 'planet') return { status: 'ready', value: { source: 'planet', planet: presentation.planet } };
    const ref = presentation.picture.ref;
    const selected = ref.kind === 'builtin' ? input.pictures.find(picture => picture.id === ref.id) : undefined;
    if (ref.kind === 'builtin' && !selected) return { status: 'unavailable', reason: 'picture_unavailable' };
    const retainedCatalog = selected ? [{ id: selected.id, src: { ...selected.src } }] : [];
    const effective = effectivePictureLook(presentation, input.pictures);
    const creditUrl = selected ? PublicProfilePictureCreditUrlV1Schema.safeParse(selected.credit.url) : null;
    const descriptor = PublicProfilePictureDescriptorV1Schema.parse({
        ...(selected ? { kind: selected.kind, title: selected.title, horizon: selected.horizon, focus: selected.focus,
            hour: selected.hour, grades: selected.grades, dark: selected.dark,
            ...(selected.adjust ? { adjust: selected.adjust } : {}), ...(selected.themes ? { themes: selected.themes } : {}) }
            // An own picture has no release grade or focus: equal source/target hours are the shared no-grade identity.
            : { kind: 'photo', title: t('settingsAppearance.glassControls.yourPicture'), horizon: {}, focus: {},
                hour: 0, grades: { light: 0, dusk: 0, night: 0 }, dark: 'night' }),
        adaptiveHaze: pictureHazeIsAdaptive(presentation, selected),
        credit: selected ? { ...selected.credit,
            url: creditUrl?.success ? creditUrl.data : undefined } : null,
        look: { effect: effective.effect, params: resolveParams(ATMOSPHERE_LOOKS.find(look => look.id === effective.effect), effective.params),
            strength: effective.strength, dissolve: { style: effective.fade, from: effective.from ?? ATMOSPHERE_HORIZON_FADE_FROM, to: effective.to ?? 1 } },
    });
    const localId = atmospherePictureLocalId(presentation)!;
    try {
        const record = await input.store.get(localId);
        if (!input.isCurrent()) return { status: 'unavailable', reason: 'account_retired' };
        const resolved = resolveAtmosphere({ surface: { publicProfile: presentation },
            home: { ...presentation, moments: {}, showOn: [] }, pictures: retainedCatalog, pictureRecord: record,
            isPhone: false, glassEnvironment: {}, reduceTransparency: false, reducedMotion: true });
        if (!resolved.pictureRecord) return { status: 'unavailable', reason: 'picture_unavailable' };
        const pixels = await input.store.prepare(resolved.pictureRecord.data, { format: 'png' });
        if (!input.isCurrent()) return { status: 'unavailable', reason: 'account_retired' };
        const prefix = 'data:image/png;base64,';
        const base64 = typeof pixels === 'string' ? (pixels.startsWith(prefix) ? pixels.slice(prefix.length) : '')
            : pixels.type === 'image/png' ? encodeBase64(new Uint8Array(await pixels.arrayBuffer())) : '';
        if (!input.isCurrent()) return { status: 'unavailable', reason: 'account_retired' };
        const parsed = PublicProfilePreparedAtmosphereV1Schema.safeParse({ source: 'picture',
            picture: { layout: presentation.picture.layout, descriptor, content: { mimeType: 'image/png', base64 } } });
        return parsed.success ? { status: 'ready', value: parsed.data }
            : { status: 'unavailable', reason: 'picture_normalization_failed' };
    } catch {
        return { status: 'unavailable', reason: input.isCurrent() ? 'picture_normalization_failed' : 'account_retired' };
    }
}
