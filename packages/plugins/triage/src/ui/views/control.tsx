import * as React from 'react';
import { Button, Row, Select, Stack, Status, TextField } from '@happier-dev/plugin-ui';

import {
  type CorpusSavedViewV1,
} from '../../settings/savedViews.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageSavedViewLensStatusV1 } from './divergence.js';
import type { TriageSavedViewsNoticeV1 } from './useTriageSavedViews.js';

/**
 * The compact **Views** control (`core/SURFACE.md` §6.5).
 *
 * It names the lens the reader is looking through — a saved view by its own
 * name, or that same view as **Modified** once they have moved off it — and it
 * is where the five explicit operations live: select, create, rename, update
 * and delete.
 *
 * **Every control here is a shared public `plugin-ui` control.** There is no
 * Triage popover, menu, chip or focus handling in this file: the roving focus,
 * the checked/selected semantics, the platform touch-target floor and the
 * disabled treatment are the host's, reached through props. That is also why
 * the operations are exposed as controls rather than folded behind an overlay
 * trigger — `plugin-ui`'s `Popover`/`Menu` render their content only through the
 * private presentation host, so an overlay composition is unreachable on a
 * mount that does not publish one, which is the same reason the filter rail
 * exposes its facets individually.
 *
 * **It decides nothing durable.** `settings/savedViews.ts` mints the id,
 * validates every bound and owns the CAS verdict; `savedViewsCommand.ts` owns
 * what Rename and Update each save. The only bound named here is the view
 * count, imported from that owner so a Create control is not offered when the
 * next press could only be refused — the same reuse the reducer already makes
 * of the facet bound.
 */

/** The Select value standing for "no saved view", which is not a view id. */
const UNSAVED_VIEW_KEY = '';

export type TriageViewsControlPropsV1 = Readonly<{
  views: readonly CorpusSavedViewV1[];
  /** The reducer's selected view, which is what the lens on screen came from. */
  selectedViewId: string | null;
  status: TriageSavedViewLensStatusV1;
  /** Whether this view names sources the reader no longer has configured. */
  namesUnavailableSources: boolean;
  /** A write this mount asked for has not settled. */
  busy: boolean;
  /** Why the controls cannot write, in words, or `null` when they can. */
  unavailableReason: string | null;
  /** The stored set belongs to a writer this build cannot read. */
  unreadable: boolean;
  notice: TriageSavedViewsNoticeV1 | null;
  text: TriageTextResolverV1;
  onSelectView: (viewId: string | null) => void;
  onCreateView: (label: string) => void;
  onRenameView: (view: CorpusSavedViewV1, label: string) => void;
  onUpdateView: (view: CorpusSavedViewV1) => void;
  onDeleteView: (view: CorpusSavedViewV1) => void;
}>;

type NameDraft = Readonly<{ kind: 'create' | 'rename'; label: string }>;

export function TriageViewsControl(props: TriageViewsControlPropsV1): React.ReactElement {
  const {
    busy,
    namesUnavailableSources,
    notice,
    onCreateView,
    onDeleteView,
    onRenameView,
    onSelectView,
    onUpdateView,
    selectedViewId,
    status,
    text,
    unavailableReason,
    unreadable,
    views,
  } = props;

  const [draft, setDraft] = React.useState<NameDraft | null>(null);
  const selected = React.useMemo(
    () => views.find((view) => view.viewId === selectedViewId) ?? null,
    [selectedViewId, views],
  );

  const onChangeSelection = React.useCallback((value: unknown) => {
    if (typeof value !== 'string') return;
    setDraft(null);
    onSelectView(value === UNSAVED_VIEW_KEY ? null : value);
  }, [onSelectView]);

  const startCreate = React.useCallback(() => { setDraft({ kind: 'create', label: '' }); }, []);
  const startRename = React.useCallback(() => {
    if (selected === null) return;
    setDraft({ kind: 'rename', label: selected.label });
  }, [selected]);
  const cancelDraft = React.useCallback(() => { setDraft(null); }, []);
  const changeDraft = React.useCallback((label: string) => {
    setDraft((current) => (current === null ? current : { ...current, label }));
  }, []);
  const commitDraft = React.useCallback(() => {
    if (draft === null) return;
    setDraft(null);
    if (draft.kind === 'create') {
      onCreateView(draft.label);
      return;
    }
    if (selected !== null) onRenameView(selected, draft.label);
  }, [draft, onCreateView, onRenameView, selected]);
  const update = React.useCallback(() => {
    if (selected !== null) onUpdateView(selected);
  }, [onUpdateView, selected]);
  const remove = React.useCallback(() => {
    if (selected !== null) onDeleteView(selected);
  }, [onDeleteView, selected]);

  // A stored set this build cannot read is not an empty set the reader may
  // overwrite: every write stays refused until a build that understands it runs.
  const writable = !unreadable && unavailableReason === null && !busy;
  const options = React.useMemo(() => [
    {
      value: UNSAVED_VIEW_KEY,
      label: text('plugins.triage.surface.views.none', 'No saved view'),
    },
    ...views.map((view) => ({ value: view.viewId, label: view.label })),
  ], [text, views]);

  return (
    <Stack gap="small">
      <Row gap="small" wrap align="center">
        <Select
          label={text('plugins.triage.surface.views', 'Views')}
          value={selectedViewId ?? UNSAVED_VIEW_KEY}
          options={options}
          disabled={!writable}
          onChange={onChangeSelection}
        />
        {/*
          The one place the lens is named as no longer the saved one. It is said
          in words rather than by a mark on the name, because the whole point of
          the state is that an Update is available and has not happened.
        */}
        {status !== 'modified' ? null : (
          <Status
            tone="muted"
            label={text('plugins.triage.surface.views.modified', 'Modified')}
          />
        )}
        {draft !== null ? null : (
          <Button
            title={text('plugins.triage.surface.views.save', 'Save as new view')}
            variant="plain"
            disabled={!writable}
            onPress={startCreate}
          />
        )}
        {draft !== null || selected === null ? null : (
          <>
            <Button
              title={text('plugins.triage.surface.views.rename', 'Rename')}
              variant="plain"
              disabled={!writable}
              onPress={startRename}
            />
            <Button
              title={text('plugins.triage.surface.views.update', 'Update this view')}
              variant="plain"
              // Nothing to save is not an operation. Offering it anyway would
              // make an explicit write look like it did nothing.
              disabled={!writable || status !== 'modified'}
              onPress={update}
            />
            <Button
              title={text('plugins.triage.surface.views.delete', 'Delete')}
              variant="plain"
              disabled={!writable}
              onPress={remove}
            />
          </>
        )}
      </Row>

      {draft === null ? null : (
        <Row gap="small" wrap align="center">
          <TextField
            label={text('plugins.triage.surface.views.name', 'View name')}
            value={draft.label}
            onChange={changeDraft}
          />
          <Button
            title={text('plugins.triage.surface.views.confirm', 'Save view')}
            variant="secondary"
            // An unnamed view is nothing typed yet, not a bound: the exact
            // label rule stays at the one CAS owner, which reports it back.
            disabled={!writable || draft.label.trim().length === 0}
            onPress={commitDraft}
          />
          <Button
            title={text('plugins.triage.surface.views.cancel', 'Cancel')}
            variant="plain"
            onPress={cancelDraft}
          />
        </Row>
      )}

      {/*
        A view is applied exactly as stored, so one naming a source the reader
        has removed legitimately matches less than it did. Saying so is what
        keeps an honestly narrow view from reading as a broken one.
      */}
      {!namesUnavailableSources || status === 'unsaved' ? null : (
        <Status
          tone="warning"
          label={text(
            'plugins.triage.surface.views.unavailableSources',
            'This view filters on sources you no longer have configured.',
          )}
        />
      )}

      {unreadable ? (
        <Status
          tone="warning"
          label={text(
            'plugins.triage.surface.views.unreadable',
            'These saved views were written by a newer version of Happier, so they were left untouched.',
          )}
        />
      ) : null}

      {unavailableReason === null ? null : (
        <Status tone="warning" label={unavailableReason} />
      )}

      {notice === null ? null : (
        <Status tone={notice.tone} label={notice.message} />
      )}
    </Stack>
  );
}
