import type { ReactElement } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

/** The chosen Saved Secret's exact reference and current revision (the SDK's `SharedSavedSecretReferenceSelectionV1Schema`); never its value. */
export type SavedSecretChoiceSelection = Readonly<{ ref: string; resourceRevision: number }>;

/**
 * Happier's own saved-secret choice list, as its pickers draw it: search once the list is long, then the secrets this
 * Account can bind by name, with their status. The host reads its catalog; only a ready secret can be chosen.
 */
export type SavedSecretChoiceListProps = Readonly<{
  testIDPrefix: string;
  /** The reference currently chosen, which carries the check. */
  selectedRef: string | null;
  onSelect: (selection: SavedSecretChoiceSelection) => void;
  /** Readable alternative on a host without the saved-secret choice presentation. */
  unavailableLabel?: string;
}>;

/** The incumbent saved-secret choice list, shared with Happier core; the host loads and draws it. */
export function SavedSecretChoiceList(props: SavedSecretChoiceListProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderSavedSecretChoiceList) {
    return (
      <Text
        testID={`${props.testIDPrefix}-unavailable`}
        tone="secondary"
        valueKey="happier.plugin-ui.savedSecretChoice.unavailable"
        fallback={props.unavailableLabel ?? 'Saved secrets are unavailable on this host.'}
      />
    );
  }
  return <>{host.renderSavedSecretChoiceList(props)}</>;
}
