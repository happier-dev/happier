import * as React from 'react';
import {
  Status,
  useCollectionSavedViewsControl,
  type CollectionSavedViewsLabels,
} from '@happier-dev/plugin-ui/components';
import { usePluginHostApi } from '@happier-dev/plugin-ui/hostApi';

import type { CorpusSavedViewV1 } from '../../settings/savedViews.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageSavedViewLensStatusV1 } from './divergence.js';
import type { TriageSavedViewsNoticeV1 } from './useTriageSavedViews.js';

export type TriageViewsControlPropsV1 = Readonly<{
  views: readonly CorpusSavedViewV1[];
  selectedViewId: string | null;
  status: TriageSavedViewLensStatusV1;
  namesUnavailableSources: boolean;
  busy: boolean;
  unavailableReason: string | null;
  unreadable: boolean;
  notice: TriageSavedViewsNoticeV1 | null;
  text: TriageTextResolverV1;
  onSelectView: (viewId: string | null) => void;
  /** True only after the naming write was applied by the Account owner. */
  onCreateView: (label: string) => Promise<boolean>;
  onRenameView: (view: CorpusSavedViewV1, label: string) => Promise<boolean>;
  onUpdateView: (view: CorpusSavedViewV1) => void;
  onDeleteView: (view: CorpusSavedViewV1) => void;
}>;

type TriageViewItem = Readonly<{ id: string; label: string; view: CorpusSavedViewV1 }>;

/**
 * Triage binds its Account-owned views and notices to the public controlled
 * collection picker. Catalog storage and Rename/Update meaning remain with
 * savedViews.ts and savedViewsCommand.ts; selection uses the host page location.
 */
export function useTriageViewsControl(props: TriageViewsControlPropsV1): Readonly<{
  control: React.ReactElement;
  details: React.ReactElement | null;
}> {
  const hostApi = usePluginHostApi();
  const { views, selectedViewId, status, namesUnavailableSources, busy,
    unavailableReason, unreadable, notice, text, onSelectView, onCreateView,
    onRenameView, onUpdateView, onDeleteView } = props;
  const items = React.useMemo(() => views.map((view): TriageViewItem => ({
    id: view.viewId, label: view.label, view,
  })), [views]);
  const labels = React.useMemo((): CollectionSavedViewsLabels => ({
    title: text('plugins.triage.surface.views', 'Views'),
    unselected: text('plugins.triage.surface.views.none', 'No saved view'),
    actions: text('plugins.triage.surface.views.operations', 'View actions'),
    create: text('plugins.triage.surface.views.save', 'Save as new view'),
    rename: text('plugins.triage.surface.views.rename', 'Rename'),
    update: text('plugins.triage.surface.views.update', 'Update this view'),
    delete: text('plugins.triage.surface.views.delete', 'Delete'),
    modified: text('plugins.triage.surface.views.modified', 'Modified'),
    name: text('plugins.triage.surface.views.name', 'View name'),
    confirm: text('plugins.triage.surface.views.confirm', 'Save view'),
    cancel: text('plugins.triage.surface.views.cancel', 'Cancel'),
  }), [text]);
  const rename = React.useCallback((item: TriageViewItem, label: string) => onRenameView(item.view, label), [onRenameView]);
  const update = React.useCallback((item: TriageViewItem) => onUpdateView(item.view), [onUpdateView]);
  const remove = React.useCallback((item: TriageViewItem) => onDeleteView(item.view), [onDeleteView]);
  const hasNotices = (namesUnavailableSources && status !== 'unsaved') || unreadable || notice !== null;
  const notices = !hasNotices ? null : <>
    {!namesUnavailableSources || status === 'unsaved' ? null : <Status
      tone="warning"
      label={text('plugins.triage.surface.views.unavailableSources', 'This view filters on sources you no longer have configured.')}
    />}
    {unreadable ? <Status
      tone="warning"
      label={text('plugins.triage.surface.views.unreadable', 'These saved views were written by a newer version of Happier, so they were left untouched.')}
    /> : null}
    {notice === null ? null : <Status tone={notice.tone} label={notice.message} />}
  </>;
  return useCollectionSavedViewsControl({
    // The native/RNW host replaces this facade with its captured Account lifetime.
    scope: hostApi,
    items,
    selectedId: selectedViewId,
    modified: status === 'modified',
    disabled: unreadable || unavailableReason !== null,
    busy,
    labels,
    notices,
    onSelect: onSelectView,
    onCreate: onCreateView,
    onRename: rename,
    onUpdate: update,
    onDelete: remove,
  });
}
