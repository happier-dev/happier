import * as React from 'react';
import { View } from 'react-native';

import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { formatTriggerSetSummary } from '../triggers/formatTriggerSummary';
import { resolveTriggerEventGroup } from '../triggers/triggerEventGroups';
import type { useAccountWorkflowEditor } from '../triggers/AccountTriggersSection';
import type { WorkflowLibraryRecordRow } from './workflowLibraryCollection';

export type AccountWorkflowLibraryRow = Extract<
  WorkflowLibraryRecordRow,
  Readonly<{ accountTrigger: unknown }>
>;
type AccountWorkflowEditor = ReturnType<typeof useAccountWorkflowEditor>;

/** Turned off as a whole: the set, or every trigger it has. */
export function isAccountWorkflowOff(row: AccountWorkflowLibraryRow): boolean {
  const set = row.accountTrigger;
  return (
    !set.enabled ||
    (set.triggers.length > 0 &&
      set.triggers.every((trigger) => !trigger.enabled))
  );
}

export function isAccountWorkflowReviewRequired(
  row: AccountWorkflowLibraryRow,
): boolean {
  return row.accountTrigger.legacy?.lockedReason === 'review_required';
}

/**
 * The quiet line a Library row gives an Account Workflow (Q7): its trigger, as a saved workflow's row
 * gives its own. A manual one is its name alone, like a manual saved workflow; turned off, the line
 * says so first.
 */
export function formatAccountWorkflowLine(
  row: AccountWorkflowLibraryRow,
): string | null {
  if (isAccountWorkflowReviewRequired(row))
    return t('workflows.triggers.legacy.reviewRequired');
  const when =
    row.accountTrigger.triggers.length > 0 ? row.triggerSummary : null;
  if (!isAccountWorkflowOff(row)) return when;
  return [t('workflows.triggers.row.off'), when].filter(Boolean).join(' · ');
}

/**
 * Where an Account Workflow's settings hang from, for any Library row anatomy: the row's own frame.
 * With one setting the press opens it; with several, a short menu asks which one, so every existing
 * trigger editor stays one press away. A `?trigger=` link opens the first setting once.
 */
export const AccountWorkflowRowAnchor = React.memo(
  function AccountWorkflowRowAnchor(
    props: Readonly<{
      row: AccountWorkflowLibraryRow;
      editor: AccountWorkflowEditor;
      deepLink?: boolean;
      /** A host that owns the press itself (a Collection) registers the row's opener instead. */
      register?: (key: string, open: () => void) => () => void;
      children: (open: () => void) => React.ReactNode;
    }>,
  ) {
    const anchorRef = React.useRef<View>(null);
    const [choosing, setChoosing] = React.useState(false);
    const latest = React.useRef(props);
    latest.current = props;
    const open = React.useCallback(() => {
      const { row, editor } = latest.current;
      if (row.triggerOpenTargets.length > 1) {
        setChoosing(true);
        return;
      }
      void editor.open(row.openTarget, anchorRef);
    }, []);
    const { register } = props;
    const key = props.row.key;
    React.useEffect(() => register?.(key, open), [register, key, open]);
    React.useEffect(() => {
      if (props.deepLink)
        void latest.current.editor.open(
          latest.current.row.openTarget,
          anchorRef,
        );
    }, [props.deepLink]);
    const set = props.row.accountTrigger;
    const items = React.useMemo(
      (): readonly DropdownMenuItem[] =>
        props.row.triggerOpenTargets.map((target, index) => {
          const trigger = set.triggers.find(
            (candidate) => candidate.id === target.triggerId,
          );
          return {
            id: String(index),
            testID: `${props.row.key}:setting:${target.triggerId ?? 'manual'}`,
            title: formatTriggerSetSummary(trigger ? [trigger] : []),
            ...(trigger && (!trigger.enabled || !set.enabled)
              ? { subtitle: t('workflows.triggers.row.off') }
              : {}),
            icon: (
              <Icon
                name={
                  trigger ? resolveTriggerEventGroup(trigger).glyph : 'play'
                }
              />
            ),
          };
        }),
      [props.row.key, props.row.triggerOpenTargets, set],
    );
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
          {props.children(open)}
        </View>
        {choosing ? (
          <DropdownMenu
            testID={`${props.row.key}:settings`}
            open
            onOpenChange={setChoosing}
            items={items}
            popoverAnchorRef={anchorRef}
            onSelect={(id) => {
              setChoosing(false);
              const target = latest.current.row.triggerOpenTargets[Number(id)];
              if (target) void latest.current.editor.open(target, anchorRef);
            }}
            placement="bottom"
            popoverAnchorAlign="start"
            matchTriggerWidth={false}
            maxWidthCap={320}
            popoverPortalWebTarget="body"
          />
        ) : null}
      </>
    );
  },
);
