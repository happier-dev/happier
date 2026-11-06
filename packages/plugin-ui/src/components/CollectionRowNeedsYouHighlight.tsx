import { useMemo, type ReactElement } from 'react';

import { HappierCollectionRowNeedsYouLayer } from '../presentation/collection/CollectionRowNeedsYouLayer.js';
import { resolveHappierCollectionRowNeedsYouHighlight, type HappierCollectionRowNeedsYouFacts, type HappierCollectionRowNeedsYouHighlight } from '../presentation/collection/needsYouHighlight.js';
import { resolveHappierWorkStatusGlyphColor } from '../presentation/work/workStatus.js';
import { resolveHappierWorkTheme } from '../presentation/work/workTheme.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { CollectionRowVisibility } from './collectionRowVisibility.js';

/**
 * The person's opt-in needs-you highlight for one row, from the host's own preference, reduced-motion and
 * presentation facts. Mount it only for a row that needs the person: calm rows never read them. A hosted-web
 * realm has no such facts and stays on Dot, which adds nothing.
 */
export function useCollectionRowNeedsYouHighlight(facts: HappierCollectionRowNeedsYouFacts): HappierCollectionRowNeedsYouHighlight {
  const host = useOptionalPluginUiPresentationHost()?.collectionRowNeedsYou?.useFacts();
  return resolveHappierCollectionRowNeedsYouHighlight({
    preference: host?.preference ?? 'dot',
    reducedMotion: host?.reducedMotion ?? false,
    unopened: facts.unopened,
    visible: facts.visible && (host?.presented ?? true),
  });
}

export type CollectionRowNeedsYouHighlightProps = HappierCollectionRowNeedsYouFacts & Readonly<{ testID?: string }>;

/** The highlight's drawn layer, under a row's content; `Collection`'s `anatomy.needsYou` places it for you. */
export function CollectionRowNeedsYouHighlight(props: CollectionRowNeedsYouHighlightProps): ReactElement | null {
  const highlight = useCollectionRowNeedsYouHighlight(props);
  return <NeedsYouLayer leading={highlight.leading} testID={props.testID} />;
}

/** Collection owns mounted rows; only its moving treatments need the physical viewport's visibility fact. */
export function CollectionRowNeedsYouHighlightInViewport(props: Omit<CollectionRowNeedsYouHighlightProps, 'visible'>): ReactElement {
  const highlight = useCollectionRowNeedsYouHighlight({ unopened: props.unopened, visible: true });
  const layer = <NeedsYouLayer leading={highlight.leading} testID={props.testID} />;
  return highlight.leading === 'glint' || highlight.leading === 'shimmer'
    ? <CollectionRowVisibility testID={props.testID}>{layer}</CollectionRowVisibility>
    : layer;
}

function NeedsYouLayer(props: Readonly<{ leading: HappierCollectionRowNeedsYouHighlight['leading']; testID?: string }>): ReactElement {
  const theme = usePluginTheme();
  const color = useMemo(() => resolveHappierWorkStatusGlyphColor('attention', resolveHappierWorkTheme(theme).colors), [theme]);
  return <HappierCollectionRowNeedsYouLayer leading={props.leading} color={color} {...(props.testID === undefined ? {} : { testID: props.testID })} />;
}
