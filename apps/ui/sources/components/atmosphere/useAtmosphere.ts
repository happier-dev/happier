import * as React from 'react';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { useSetting, useProjectAtmosphere } from '@/sync/store/hooks';
import { useGlassReduceTransparency } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { pictureStore } from './pictureStore';
import { builtinThumbnailLocalId } from './ensureBuiltinPicture';
import { useStoredPictureRecord } from './useStoredPictureRecord';
import { atmospherePictureLocalId, atmospherePlace, atmosphereSurfaceKey, isAtmosphereShown, resolveAtmosphere, selectAtmosphereSettings, type AtmosphereTarget, type ResolvedAtmosphere } from './resolveAtmosphere';
import { useAtmosphereDisplaySample } from './atmosphereStage';
import { usePublicProfileAtmospherePreviewValue } from '@/sync/store/settingsPreview';
import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectAtmosphere } from '@/sync/store/domains/projectAccountRows';
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
    const surfaceKey = typeof surface === 'object' && 'publicProfile' in surface ? 'profile' : atmosphereSurfaceKey(surface);
    const profileDraft = usePublicProfileAtmospherePreviewValue(typeof surface === 'object' && 'publicProfile' in surface ? surface.draftServerId : undefined);
    const profile = typeof surface === 'object' && 'publicProfile' in surface ? profileDraft ?? surface.publicProfile : undefined;
    // The resolver uses the target kind and presentation; project identity belongs to its settings hook.
    const place = atmospherePlace(surface);
    const target = React.useMemo<AtmosphereTarget>(() => profile ? { publicProfile: profile }
        : project ? { place, project } : surface,
        // Identity is the qualified route/context key, not an object allocated by its caller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [surfaceKey, profile, place, project?.serverId, project?.projectKey]);
    const scope = getStorage()(state => state.settingsScope);
    const homeRef = home.picture.ref;
    const homePictureKey = homeRef.kind === 'builtin' ? homeRef.id : homeRef.localId;
    // A gesture changes the effective presentation, not the authored Home arrival's lifetime.
    const inheritsHome = getStorage()(state => {
        if (typeof surface === 'object' && 'publicProfile' in surface) return false;
        const authored = project ? readProjectAtmosphere(state, project) : undefined;
        return authored === undefined || authored === 'home';
    });
    const selection = resolvedContext && inheritsHome && isAtmosphereShown(target, projectOverride && projectOverride !== 'home'
        ? { ...projectOverride, moments: home.moments } : home) && home.source === 'picture' && homeRef.kind === 'builtin'
        ? JSON.stringify([scope?.serverId, scope?.accountId, home.source, homeRef.kind, homePictureKey, home.picture.selectedAtMs]) : null;
    const nowMs = useAtmosphereDisplaySample(selection);
    const settings = React.useMemo(() => selectAtmosphereSettings(target, home, projectOverride, nowMs), [target, home, projectOverride, nowMs]);
    const demanded = resolvedContext && isAtmosphereShown(target, settings);
    const localId = demanded ? atmospherePictureLocalId(settings) : null;
    const pictureRef = settings.picture.ref;
    const builtin = demanded && settings.source === 'picture' && pictureRef.kind === 'builtin'
        ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
    const stored = useStoredPictureRecord(localId, builtin ? builtinThumbnailLocalId(builtin.id) : undefined);
    const [failedAcquisition, setFailedAcquisition] = React.useState<typeof builtin>(undefined);
    const presented = useLayoutPresentationActive();

    const shown = React.useRef<ResolvedAtmosphere<(typeof pictures)[number]> | null>(null);
    const resolved = React.useMemo(() => resolveAtmosphere({ surface: target, home: resolvedContext ? home : { ...home, source: 'none' },
        projectOverride: resolvedContext ? projectOverride : undefined, pictures, nowMs,
        pictureRecord: stored.status === 'present' ? stored.record : undefined,
        shownPicture: shown.current, readingPicture: stored.status === 'loading',
        pictureAcquisitionFailed: builtin !== undefined && failedAcquisition === builtin,
        glassEnvironment: { reduceTransparency: environmentReduceTransparency },
        reduceTransparency, reducedMotion }), [target, home, projectOverride, pictures, stored, localId, nowMs, resolvedContext, builtin, failedAcquisition,
        environmentReduceTransparency, reduceTransparency, reducedMotion]);
    // The display read already established cache availability. Acquire only a missing/mismatched
    // picture after that read settles; a cache hit needs no second IndexedDB read or preparation.
    const needsAcquisition = stored.status !== 'loading' && (resolved.fallbackReason === 'picture-unavailable'
        || stored.status === 'present' && stored.record.localId !== localId);
    // Acquisition is demanded while the page is presented and the app is viewed; a hide renders no stage.
    useHostActivelyViewedEffect((viewed) => {
        if (!builtin || !viewed || !presented || !needsAcquisition) return;
        let disposed = false;
        setFailedAcquisition(undefined);
        void pictureStore.ensureBuiltin(builtin).catch(() => {
            if (!disposed) setFailedAcquisition(builtin);
        });
        return () => { disposed = true; };
    }, [builtin, presented, needsAcquisition]);
    shown.current = resolved;
    return resolved;
}
