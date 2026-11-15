import * as React from 'react';
import { Status, type StatusProps } from '@happier-dev/plugin-ui';
import { useOptionalHappierUiLocalization } from '@happier-dev/plugin-ui/environment';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';

/**
 * A state as a row says it (UI refinements ruling 2026-11-15 08:57Z): the one shared plugin-ui `Status`, inline, its dot
 * and word in the state's tone. Environment and Machine state in core rows draw through here instead of a status pill,
 * a work-status row mark or a hand-drawn dot. `Status` reads the plugin-ui environment, so used outside a Collection or
 * plugin surface (a column row, an `Item`) it opens that scope itself; inside one it adds nothing.
 */
export const InlineStatus = React.memo(function InlineStatus(
  props: Omit<StatusProps, 'presentation' | 'value' | 'valueKey' | 'action'>,
) {
  const scoped = useOptionalHappierUiLocalization() !== null;
  const status = <Status {...props} presentation="inline" />;
  return scoped ? (
    status
  ) : (
    <CorePluginUiPresentationScope>{status}</CorePluginUiPresentationScope>
  );
});
