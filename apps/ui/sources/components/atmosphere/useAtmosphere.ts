import * as React from 'react';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { useSetting, useProjectAtmosphere } from '@/sync/store/hooks';
import { useGlassReduceTransparency } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useDeviceType } from '@/utils/platform/responsive';
import { pictureStore } from './pictureStore';
import { useStoredPictureRecord } from './useStoredPictureRecord';
import { atmospherePictureLocalId, atmospherePlace, atmosphereSurfaceKey, isAtmosphereShown, resolveAtmosphere, selectAtmosphereSettings, type AtmosphereTarget, type ResolvedAtmosphere } from './resolveAtmosphere';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useShallow } from 'zustand/react/shallow';
import { readAtmosphereProject } from './atmosphereContext';

export { resolveAtmosphere } from './resolveAtmosphere';
export type { AtmosphereSurface, AtmosphereTarget, ResolvedAtmosphere } from './resolveAtmosphere';

/** Device availability never delays content or writes the user's synced selection. */
export function useAtmosphere(surface: AtmosphereTarget, enabled = true) {
    const pictures = useAtmospherePictureCatalog();
    const home = useSetting('homeAtmosphere');
    const project = getStorage()(useShallow(state => readAtmosphereProject(state, surface)));
    const projectOverride = useProjectAtmosphere(project ?? undefined);
    // A cold Session has no accepted Home inheritance until its membership and override are known.
    const resolvedContext = enabled && project !== undefined;
    const environmentReduceTransparency = useGlassReduceTransparency();
    const reduceTransparency = useReduceTransparency();
    const reducedMotion = useReducedMotionPreference();
    const isPhone = useDeviceType() === 'phone';
    const surfaceKey = typeof surface === 'object' && 'publicProfile' in surface ? 'profile' : atmosphereSurfaceKey(surface);
    const profile = typeof surface === 'object' && 'publicProfile' in surface ? surface.publicProfile : undefined;
    // The resolver uses the target kind and presentation; project identity belongs to its settings hook.
    const place = atmospherePlace(surface);
    const target = React.useMemo<AtmosphereTarget>(() => profile ? { publicProfile: profile }
        : project ? { place, project } : surface,
        // Identity is the qualified route/context key, not an object allocated by its caller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [surfaceKey, profile, place, project?.serverId, project?.projectKey]);
    const settings = React.useMemo(() => selectAtmosphereSettings(target, home, projectOverride), [target, home, projectOverride]);
    const demanded = resolvedContext && isAtmosphereShown(target, settings);
    const localId = demanded ? atmospherePictureLocalId(settings) : null;
    const pictureRef = settings.picture.ref;
    const builtin = demanded && settings.source === 'picture' && pictureRef.kind === 'builtin'
        ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
    const stored = useStoredPictureRecord(localId);
    // A failed download leaves the planet visible. Revisiting/remounting or choosing again tries once more.
    React.useEffect(() => {
        if (builtin) void pictureStore.ensureBuiltin(builtin).catch(() => {});
    }, [builtin]);

    const shown = React.useRef<ResolvedAtmosphere<(typeof pictures)[number]> | null>(null);
    const resolved = React.useMemo(() => resolveAtmosphere({ surface: target, home: resolvedContext ? home : { ...home, source: 'none' },
        projectOverride: resolvedContext ? projectOverride : undefined, pictures,
        pictureRecord: stored.status === 'present' ? stored.record : undefined,
        shownPicture: shown.current, readingPicture: stored.status === 'loading',
        isPhone, glassEnvironment: { reduceTransparency: environmentReduceTransparency },
        reduceTransparency, reducedMotion }), [target, home, projectOverride, pictures, stored, localId, resolvedContext,
        isPhone, environmentReduceTransparency, reduceTransparency, reducedMotion]);
    shown.current = resolved;
    return resolved;
}
