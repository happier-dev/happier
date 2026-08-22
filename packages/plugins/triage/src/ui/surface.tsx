import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';

import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TriageListShell } from './shell/root.js';

/**
 * The PRs & Issues app-page artifact entry.
 *
 * Theme, locale, text scale, accessibility and safe-area all arrive through the
 * provider `defineUiSurface` installs, and the rows arrive through the one
 * mounted window. The entry exists to be the exact thing an ordinary declared
 * `app.page` mounts (`core/SURFACE.md` §1.2), so everything it forwards is a
 * host fact the published `RenderContext` already carries: the page's own
 * `subPath`, and the input the opener passed to `openSurface`.
 *
 * **The launch input is not a Triage-specific mount seam, and an earlier
 * revision of this comment was wrong to treat it as one.** `launchInput` is the
 * generic argument every destination receives; the two Composer surfaces of
 * this same plugin already read it (`composer/entryPicker.tsx`,
 * `composer/controlCompact.tsx`) to learn the scope they were mounted from.
 * Forwarding only `subPath` did not avoid a seam — it discarded the one the
 * host publishes, so **View details** navigated, reported `{ kind: 'opened' }`
 * and left the reader on the page's own prior location with no account of what
 * happened. `core/COMPOSER.md` §7 assigns exactly this consumption to this
 * file.
 *
 * The strict private shape is validated by its one existing owner, and an input
 * that is absent or that owner refuses is the app-origin open this page already
 * served: the reader lands on the location the host routed them to, which is
 * what a page opened without an argument is. There is no second parser here and
 * no Triage-local refusal state — a shape this build cannot honour is not a
 * different page.
 */
function TriageListSurface(context: RenderContext): React.ReactElement {
  /**
   * Held across renders by the launch value's own identity: the host retains
   * one delivered open for as long as the page stays at the location it was
   * addressed to, so a stable parse is what lets the shell adopt it once
   * instead of on every render.
   */
  const launch = React.useMemo(() => {
    const parsed = parseTriageEntryDetailLaunchInput(context.launchInput);
    return parsed.status === 'valid' ? parsed.input : undefined;
  }, [context.launchInput]);

  // The two host facts this entry forwards: the plugin-local location the page
  // was opened at, and the entry an opener asked it to open. Triage names no
  // route; the shell reads the location once as its lens seed, adopts the
  // launch through the same selection it already owns, and writes both back
  // through the single route owner.
  return (
    <TriageListShell
      {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
      {...(launch === undefined ? {} : { launch })}
    />
  );
}

export const renderSurface: RenderSurface = defineUiSurface(TriageListSurface);
