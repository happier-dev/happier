import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
  TriageAdministerSavedViewResultV1Schema,
  TriageReadSavedViewsResultV1Schema,
  type TriageAdministerSavedViewInputV1,
  type TriageAdministerSavedViewResultV1,
  type TriageReadSavedViewsResultV1,
} from '../../actions/savedViewsProtocol.js';
import { parseCorpusSmartPolicy, type CorpusSmartPolicyV1 } from '../../corpus/query/smartPolicy.js';
import type { SurfaceFilterSelectionV1, TriageListOrderV1 } from '../../projection/listWindow.js';
import {
  CORPUS_EMPTY_SAVED_VIEWS_V1,
  type CorpusSavedViewV1,
  type CorpusSavedViewsReadV1,
} from '../../settings/savedViews.js';

/**
 * The surface's one path to the `triage.savedViews` CAS owner.
 *
 * A mounted surface holds a Host API with actions and no Settings member, so
 * every read, create, rename, update, delete and select leaves through here.
 * The module owns no state and makes no decision: `settings/savedViews.ts`
 * still mints the view id, validates every bound, decides the conflict verdict
 * and clears a deleted view's selection atomically. This is transport plus the
 * one thing a caller must not spell twice — what **Rename** and **Update** mean
 * in terms of the single `update` command.
 *
 * The lens carried here is the exact source-neutral facet vocabulary the list
 * Action queries with, passed through unreshaped. Nothing rebuilds, sorts or
 * re-encodes a facet value: a second spelling of one constraint is how a saved
 * lens and a live lens start to disagree about what the reader is looking at.
 */

/**
 * What a saved-view command needs from a mounted surface: the ability to invoke
 * this plugin's own view Actions, and nothing else about the mount.
 */
export type TriageSavedViewsHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

/** The lens half of a view: exactly what a saved view stores, and no query. */
export type TriageSavedViewLensV1 = Readonly<{
  filters: SurfaceFilterSelectionV1;
  order: TriageListOrderV1;
  smartPolicy: CorpusSmartPolicyV1;
}>;

export async function readTriageSavedViewsFromSurface(
  host: TriageSavedViewsHostV1,
  options?: PluginCancellationOptions,
): Promise<TriageReadSavedViewsResultV1> {
  const result = await host.executeAction(
    TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
    { v: 1 },
    options,
  );
  // The Action crosses a JSON transport, so its own published result schema —
  // not a cast — admits the value the lens is taken from.
  return TriageReadSavedViewsResultV1Schema.parse(result);
}

export async function administerTriageSavedViewFromSurface(
  host: TriageSavedViewsHostV1,
  input: TriageAdministerSavedViewInputV1,
  options?: PluginCancellationOptions,
): Promise<TriageAdministerSavedViewResultV1> {
  const result = await host.executeAction(
    TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
    input as unknown as JsonValue,
    options,
  );
  return TriageAdministerSavedViewResultV1Schema.parse(result);
}

/**
 * Read one Action projection as the read-side resolver's own input.
 *
 * `settings/effectiveView.ts` is the one place a durable saved-view state
 * becomes the lens the query runs, and it takes the owner's read shape. This is
 * the only conversion between the two, so the surface resolves through that
 * resolver rather than growing a second one that reinterprets a stored view.
 *
 * The wire widens the closed Smart ladder to a two-member array of the two
 * named predicates, so the one policy owner re-narrows it here. A value it
 * refuses cannot have come from the writer — which is the same statement
 * `unreadable` already makes, and the same refusal to overwrite a set this
 * build cannot understand.
 */
export function readTriageSavedViewsProjectionV1(projection: Readonly<{
  availability: TriageReadSavedViewsResultV1['availability'];
  views: TriageReadSavedViewsResultV1['views'];
  selectedViewId: string | null;
}>): CorpusSavedViewsReadV1 {
  if (projection.availability === 'unavailable') {
    return { kind: 'unreadable', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
  }
  const views: CorpusSavedViewV1[] = [];
  for (const view of projection.views) {
    const smartPolicy = parseCorpusSmartPolicy(view.smartPolicy);
    if (smartPolicy === null) return { kind: 'unreadable', value: CORPUS_EMPTY_SAVED_VIEWS_V1 };
    views.push({
      viewId: view.viewId,
      label: view.label,
      filters: view.filters,
      order: view.order,
      smartPolicy,
    });
  }
  return {
    kind: projection.availability,
    value: { v: 1, views, selectedViewId: projection.selectedViewId },
  };
}

/** Save the lens the reader is looking at under a name they just gave it. */
export function triageCreateSavedViewInputV1(
  label: string,
  lens: TriageSavedViewLensV1,
): TriageAdministerSavedViewInputV1 {
  return {
    v: 1,
    kind: 'create',
    label,
    filters: lens.filters,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
    // A view the reader just saved is the view they are now looking through.
    select: true,
  };
}

/**
 * Rename keeps the STORED lens and changes only the name.
 *
 * Both intents reach the one `update` command, and this is the only place that
 * difference is decided: a control that assembled the draft itself would be a
 * second answer to "what does Rename save", and the first modified lens it met
 * would be written into the view under the guise of a rename.
 */
export function triageRenameSavedViewInputV1(
  view: CorpusSavedViewV1,
  label: string,
): TriageAdministerSavedViewInputV1 {
  return {
    v: 1,
    kind: 'update',
    viewId: view.viewId,
    label,
    filters: view.filters,
    order: view.order,
    smartPolicy: view.smartPolicy,
  };
}

/** Update keeps the STORED name and saves the lens the reader is looking at. */
export function triageUpdateSavedViewInputV1(
  view: CorpusSavedViewV1,
  lens: TriageSavedViewLensV1,
): TriageAdministerSavedViewInputV1 {
  return {
    v: 1,
    kind: 'update',
    viewId: view.viewId,
    label: view.label,
    filters: lens.filters,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
  };
}

export function triageDeleteSavedViewInputV1(viewId: string): TriageAdministerSavedViewInputV1 {
  return { v: 1, kind: 'delete', viewId };
}

export function triageSelectSavedViewInputV1(
  viewId: string | null,
): TriageAdministerSavedViewInputV1 {
  return { v: 1, kind: 'select', viewId };
}
