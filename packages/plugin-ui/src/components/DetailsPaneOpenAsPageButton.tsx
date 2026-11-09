import type { ReactElement } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type DetailsPaneOpenAsPageButtonProps = Readonly<{
  onPress: () => unknown;
  disabled?: boolean;
  testID?: string;
  /** Omit to use the host's translated Open as page label and tooltip. */
  accessibilityLabel?: string;
}>;

/**
 * The host's Open as page control, shared by core and authored DetailsPane actions.
 * The caller owns navigation: bind onPress to replacePageLocation(subPath, { backLocation }).
 * A continuing native/RNW editor uses preserveUnsavedChanges: true so expanding
 * and returning keep both its text and the host's dirty protection.
 */
export function DetailsPaneOpenAsPageButton(props: DetailsPaneOpenAsPageButtonProps): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  return host?.renderDetailsPaneOpenAsPageButton ? <>{host.renderDetailsPaneOpenAsPageButton(props)}</> : null;
}
