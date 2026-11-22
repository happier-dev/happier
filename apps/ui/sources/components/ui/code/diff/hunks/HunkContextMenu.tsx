import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
  ContextMenu,
  type ContextMenuItem,
} from '@/components/ui/forms/dropdown/ContextMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { hapticsLight, hapticsSelection } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { presentDiffHunkKeep } from './diffHunkKeepLabels';
import type {
  DiffHunkAction,
  DiffHunkInfo,
  DiffViewerHunks,
} from '../diffViewerTypes';

/**
 * The phone menu of one change (lab ade-shell RV3 P3): Keep, Discard, Comment, Ask about this change,
 * Copy. Opened by a long press on the change's row; the same keyed actions as the row and the bar.
 */
export function HunkContextMenu(
  props: Readonly<{
    hunk: DiffHunkInfo;
    review: DiffViewerHunks;
    anchorRef: React.RefObject<unknown>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>,
) {
  const { hunk, review } = props;
  const { theme } = useUnistyles();
  const actions = review.actions ?? {};
  const state = review.stateOf?.(hunk) ?? 'open';
  const kept = state === 'kept';
  const busy = state === 'discarding';
  const reason = (action: DiffHunkAction) =>
    review.disabledReason?.(hunk, action) ?? null;
  const icon = (name: IconName) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  const items: ContextMenuItem[] = [];
  if (actions.keep) {
    const keepReason = reason('keep');
    items.push({
      id: 'keep',
      testID: `hunk-menu-keep-${hunk.index}`,
      // The title says the state ("Kept", as on the row and the bar); a trailing mark would repeat the check.
      title: presentDiffHunkKeep(review, kept).title,
      icon: icon('check'),
      disabled: busy || keepReason !== null,
      ...(keepReason ? { subtitle: keepReason } : {}),
    });
  }
  if (actions.discard && !kept) {
    const discardReason = reason('discard');
    items.push({
      id: 'discard',
      testID: `hunk-menu-discard-${hunk.index}`,
      title: t('hunkReview.discard'),
      icon: icon('arrow-arc-left'),
      disabled: busy || discardReason !== null,
      ...(discardReason ? { subtitle: discardReason } : {}),
    });
  }
  if (actions.comment)
    items.push({
      id: 'comment',
      testID: `hunk-menu-comment-${hunk.index}`,
      title: t('hunkReview.comment'),
      icon: icon('chat-circle'),
    });
  if (actions.ask)
    items.push({
      id: 'ask',
      testID: `hunk-menu-ask-${hunk.index}`,
      title: t('hunkReview.askAbout'),
      icon: icon('sparkle'),
    });
  if (actions.copy)
    items.push({
      id: 'copy',
      testID: `hunk-menu-copy-${hunk.index}`,
      title: t('hunkReview.copy'),
      icon: icon('copy'),
    });
  if (items.length === 0) return null;
  return (
    <ContextMenu
      testID={`hunk-menu-${hunk.index}`}
      anchorRef={props.anchorRef}
      open={props.open}
      onOpenChange={props.onOpenChange}
      items={items}
      onSelect={(id) => {
        props.onOpenChange(false);
        const action = id as DiffHunkAction;
        if (action === 'discard') void hapticsLight();
        else void hapticsSelection();
        actions[action]?.(hunk);
      }}
    />
  );
}
