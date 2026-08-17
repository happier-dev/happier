import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';

import { TriageListShell } from './shell/root.js';

/**
 * The PRs & Issues app-page artifact entry.
 *
 * Theme, locale, text scale, accessibility and safe-area all arrive through the
 * provider `defineUiSurface` installs, and the rows arrive through the one
 * mounted window. The entry exists to be the exact thing an ordinary declared
 * `app.page` mounts (`core/SURFACE.md` §1.2), not to add a Triage-specific
 * mount seam, so the only thing it forwards is the host's own `subPath`.
 */
function TriageListSurface(context: RenderContext): React.ReactElement {
  // The one host fact this entry forwards: the plugin-local location the page
  // was opened at. Triage names no route; the shell reads it once as its lens
  // seed and writes it back through the single route owner.
  return <TriageListShell {...(context.subPath === undefined ? {} : { subPath: context.subPath })} />;
}

export const renderSurface: RenderSurface = defineUiSurface(TriageListSurface);
