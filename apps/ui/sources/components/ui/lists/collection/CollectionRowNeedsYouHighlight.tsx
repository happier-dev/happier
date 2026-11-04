import * as React from 'react';
import {
    HappierCollectionRowNeedsYouLayer,
    resolveHappierCollectionRowNeedsYouHighlight,
    type HappierCollectionRowNeedsYouFacts,
    type HappierCollectionRowNeedsYouHighlight,
} from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export type CollectionRowNeedsYouFacts = HappierCollectionRowNeedsYouFacts;

/** The host's facts behind the highlight; plugin rows read the same ones through the presentation host. */
export function useCollectionRowNeedsYouHostFacts() {
    const preference = useLocalSetting('sessionListNeedsYouHighlight');
    const reducedMotion = useReducedMotionPreference();
    const hostViewed = useHostActivelyViewed();
    const layoutPresented = useLayoutPresentationActive();
    return { preference, reducedMotion, presented: hostViewed && layoutPresented };
}

/**
 * The opt-in needs-you highlight for one row (owner ruling 2026-11-01). Mount only on a row that needs the
 * person, outside the Needs you shelf: calm rows never subscribe to the preference. Motion also stops while the
 * window or the pane is hidden.
 */
export function useCollectionRowNeedsYouHighlight(facts: CollectionRowNeedsYouFacts): HappierCollectionRowNeedsYouHighlight {
    const host = useCollectionRowNeedsYouHostFacts();
    return resolveHappierCollectionRowNeedsYouHighlight({
        preference: host.preference, reducedMotion: host.reducedMotion, unopened: facts.unopened, visible: facts.visible && host.presented,
    });
}

/** The row's leading highlight layer, drawn in the row's `leading` slot under its content. */
export const CollectionRowNeedsYouLeading = React.memo(function CollectionRowNeedsYouLeading(props: CollectionRowNeedsYouFacts & Readonly<{
    testID?: string;
}>) {
    const highlight = useCollectionRowNeedsYouHighlight(props);
    return <CollectionRowNeedsYouLayer leading={highlight.leading} testID={props.testID} />;
});

/** Plugin-ui's drawn layer in the host's attention colour. The Appearance tiles render it `still`. */
export function CollectionRowNeedsYouLayer(props: Readonly<{ leading: HappierCollectionRowNeedsYouHighlight['leading']; still?: boolean; testID?: string }>) {
    const { theme } = useUnistyles();
    return <HappierCollectionRowNeedsYouLayer {...props} color={workStatusGlyphColor(theme.colors, 'attention')} />;
}
