import * as React from 'react';

/** What a file body can do beyond reading it: open it full screen once its viewer is ready, and download it. */
export type ArtifactBodyActions = Readonly<{
  openFullScreen: (() => void) | null;
  download: () => void;
  downloading: boolean;
}>;

type Publish = (actions: ArtifactBodyActions | null) => void;
const ArtifactBodyActionsContext = React.createContext<Publish | null>(null);

/**
 * The Artifact view's action row hosts its body's operations (View full screen, Download) beside Share.
 * Returns what the body published and the provider value for the body's subtree.
 */
export function useArtifactBodyActionsHost(): readonly [
  ArtifactBodyActions | null,
  Publish,
] {
  const [actions, setActions] = React.useState<ArtifactBodyActions | null>(
    null,
  );
  return [actions, setActions] as const;
}

export const ArtifactBodyActionsProvider = ArtifactBodyActionsContext.Provider;

/**
 * A body publishes its operations to the hosting action row while mounted. Returns whether a row hosts
 * them; a body shown without one (a History version) keeps its own buttons.
 */
export function usePublishArtifactBodyActions(
  actions: ArtifactBodyActions | null,
): boolean {
  const publish = React.useContext(ArtifactBodyActionsContext);
  React.useEffect(() => {
    if (!publish) return;
    publish(actions);
    return () => publish(null);
  }, [publish, actions]);
  return publish !== null;
}
