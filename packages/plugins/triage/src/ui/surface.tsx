import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';

import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TriageListShell } from './shell/root.js';
import { PluginUiResourceIntentV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { TriageActionEditorLaunchInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageResourceSurface } from './resourceSurface.js';
import { readTriageResourceIntent } from './contributions.js';
import { useTriageTaskDraftLaunch } from './taskDraftLaunch.js';
import { openTriageEntryDetails } from '../composer/openEntryDetails.js';
import { TriageTaskDraftLaunchV1Schema } from '../actions/tasksProtocol.js';
import { readReviewDetailInput, ReviewDetail } from '../reviews/detail.js';

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
  const resource = React.useMemo(() => {
    const input = context.launchInput;
    const parsed = PluginUiResourceIntentV1Schema.safeParse(typeof input === 'object' && input !== null && 'resource' in input ? input.resource : undefined);
    if (parsed.success) return parsed.data;
    if (context.subPath?.startsWith('resource/')) {
      try {
        const restored = PluginUiResourceIntentV1Schema.safeParse(JSON.parse(decodeURIComponent(context.subPath.slice('resource/'.length))));
        if (restored.success) return restored.data;
      } catch { /* A different or malformed page route retains the ordinary list. */ }
    }
    const mount = context.surface.mount;
    return mount.kind === 'destination' && mount.instanceKey !== undefined ? readTriageResourceIntent(mount.instanceKey) ?? null : null;
  }, [context.launchInput, context.subPath, context.surface.mount]);
  React.useEffect(() => {
    if (resource === null || context.surface.mount.kind !== 'destination' || context.surface.mount.container !== 'appPage') return;
    const subPath = `resource/${encodeURIComponent(JSON.stringify(resource))}`;
    if (context.subPath === subPath) return;
    void context.hostApi.replacePageLocation(subPath, { signal: context.signal }).catch(() => {
      if (!context.signal.aborted) return context.hostApi.openExternalLink(resource.url, { signal: context.signal });
    });
  }, [context.hostApi, context.signal, context.subPath, context.surface.mount, resource]);
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

  /** Held by the launch value's identity, like the entry launch: each Edit action… is one delivered open. */
  const actionEditor = React.useMemo(() => {
    const parsed = TriageActionEditorLaunchInputV1Schema.safeParse(context.launchInput);
    return parsed.success ? parsed.data : undefined;
  }, [context.launchInput]);

  // A task draft opened over a Session (a message's Create task) lands in this Session details tab: the Tasks lens
  // with the draft as its open detail, through the same draft adoption as the Tasks page.
  const draft = useTriageTaskDraftLaunch(context.launchInput);
  // That details instance exists only for its draft. When the draft ends (Cancel, or Create handing the task to its
  // source), the mount is settled so the pane owner returns the pane to what it showed before, and the whole Tasks
  // list never takes the draft's place. `cancelled` because the mount hands no input back to its opener.
  const draftLaunched = React.useMemo(() => TriageTaskDraftLaunchV1Schema.safeParse(context.launchInput).success, [context.launchInput]);
  const [draftEnded, setDraftEnded] = React.useState(false);
  const draftClose = draft.status === 'ready' ? draft.shellProps.onCreateDraftClose : null;
  const endDraft = React.useCallback(() => {
    draftClose?.();
    setDraftEnded(true);
    void context.hostApi.settleEphemeralInput({ kind: 'cancelled' }, { signal: context.signal }).catch(() => {
      // A host that cannot settle this mount keeps its own close control; nothing else is drawn here.
    });
  }, [context.hostApi, context.signal, draftClose]);

  if (resource !== null) return <TriageResourceSurface resource={resource} />;
  if (draftLaunched) {
    if (draftEnded) return <></>;
    if (draft.status === 'unavailable') return draft.notice;
    if (draft.status === 'ready') return <TriageListShell tasksPage {...draft.shellProps} onCreateDraftClose={endDraft}
      onCreateDraftCreated={created => openTriageEntryDetails({ hostApi: context.hostApi,
        entryRef: created.entryRef,
        sourceInstance: { source: created.entryRef.source, sourceInstanceId: created.sourceInstanceId },
        signal: context.signal,
      })} />;
    return <></>;
  }

  // Forward the host location and one-shot staged-open provenance alongside
  // any validated qualified entry input. Triage names no
  // route; the shell reads the location once as its lens seed, adopts the
  // launch through the same selection it already owns, and writes both back
  // through the single route owner.
  return (
    <TriageListShell
      {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
      {...(context.launch === undefined ? {} : { pageLaunch: context.launch })}
      {...(launch === undefined ? {} : { launch })}
      {...(actionEditor === undefined ? {} : { actionEditor })}
    />
  );
}

export const renderSurface: RenderSurface = defineUiSurface(context => {
  const review = readReviewDetailInput(context.launchInput);
  return review === null ? <TriageListSurface {...context} /> : <ReviewDetail context={context} input={review} />;
});
