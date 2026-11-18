import * as React from 'react';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { SKILLS_UPDATES_ROUTE } from '@/components/settings/skills/updates/skillsUpdatesModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';

import { RowMark } from '../inventory/ManagedInventoryDirectory';
import {
  presentInventoryRow,
  type ManagedInventoryRowPresentation,
} from '../inventory/inventoryRows';
import { submitBrowserExtensionMutation } from '../submitBrowserExtensionMutation';
import {
  isStoreUpdateActionable,
  type StoreUpdateEntry,
} from './storeUpdatesModel';

export type StoreUpdateHref = NonNullable<
  ManagedInventoryRowPresentation['home']['href']
>;

/** What a Store update row needs from the surface that hosts it (Store → Updates, a Machine's Updates group). */
export type StoreUpdateRowFacts = Readonly<{
  input: Parameters<typeof presentInventoryRow>[1];
  execute: ReturnType<typeof useMountedActionExecution>['execute'];
  getSignal: () => AbortSignal;
  ready: boolean;
  onApplied?: () => void;
}>;
export type StoreUpdateRowHost = StoreUpdateRowFacts & Readonly<{ go: (href: StoreUpdateHref) => void }>;

/** Facts for a surface that shows no Store rows (the dev Updates preview, fixtures): nothing runs and nothing is ready. */
export const NO_STORE_UPDATE_ROWS: StoreUpdateRowFacts = Object.freeze({
  input: Object.freeze({ scope: null, machine: null, projectKey: null }),
  execute: async () => { throw new Error('store_update_rows_unavailable'); },
  getSignal: () => new AbortController().signal,
  ready: false,
});

/** One host per surface: the facts plus guarded navigation to the item's owner. */
export function useStoreUpdateRowHost(facts: StoreUpdateRowFacts): StoreUpdateRowHost {
  const router = useRouter();
  const go = React.useCallback((href: StoreUpdateHref) => {
    const result = runGuardedNavigation(() => router.push(href as never));
    if (result !== true) fireAndForget(result, { tag: 'StoreUpdateRow.go' });
  }, [router]);
  const { input, execute, getSignal, ready, onApplied } = facts;
  return React.useMemo(() => ({ input, execute, getSignal, ready, onApplied, go }), [execute, getSignal, go, input, onApplied, ready]);
}

/** One waiting change, reviewed through its native Action or its owner's detail page. The one row for a Store update. */
export function StoreUpdateRow(
  props: Readonly<{
    entry: StoreUpdateEntry;
    host: StoreUpdateRowHost;
    testID: string;
    /** `item` inside a page section of ordinary rows (Machine → Security), so the section keeps one text column. */
    rowRole?: 'catalogRow' | 'item';
  }>,
) {
  const { entry, host } = props;
  const presentation = presentInventoryRow(entry.row, host.input);
  const title = presentation.facts.title;
  const href =
    entry.row.kind === 'skill' &&
    (entry.state === 'available' || entry.state === 'needsChoice')
      ? SKILLS_UPDATES_ROUTE
      : presentation.home.href;
  const version =
    entry.from && entry.to
      ? `${entry.from} → ${entry.to}`
      : entry.state === 'current'
        ? entry.from
        : null;
  const state =
    entry.state === 'current'
      ? t('capabilities.store.updates.upToDate')
      : entry.state === 'available'
        ? t('capabilities.store.updates.ready')
        : entry.state === 'needsChoice'
          ? t('capabilities.store.updates.needsChoice')
          : entry.state === 'removed'
            ? t('capabilities.skills.home.removedFromSource')
            : [
                t('capabilities.store.updates.unchecked'),
                entry.reason
                  ? describeRegistrySourceStatus(entry.reason)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
  const [applying, apply] = useHappyAction(async () => {
    if (!entry.apply) return;
    const result = await submitBrowserExtensionMutation({
      ...entry.apply,
      machineId: entry.apply.input.machineId,
      execute: host.execute,
      signal: host.getSignal(),
      confirmText: t('capabilities.store.updates.review'),
    });
    if (result.ok) host.onApplied?.();
    else if (result.code) Modal.alert(t('common.error'), result.code);
  });
  const open = () => {
    if (entry.apply) apply();
    else if (href) host.go(href);
  };
  const actionable = Boolean(entry.apply || href);
  const disabled = Boolean(entry.apply && (applying || !host.ready));
  const fix = !isStoreUpdateActionable(entry)
    ? null
    : entry.state === 'available'
      ? t('capabilities.store.updates.review')
      : t('capabilities.store.updates.choose');
  return (
    <CapabilityRow
      testID={props.testID}
      {...(props.rowRole === undefined ? {} : { rowRole: props.rowRole })}
      title={title}
      description={[version, state].filter(Boolean).join(' · ')}
      status={entry.status}
      mark={<RowMark row={entry.row} title={title} input={host.input} />}
      divider={false}
      stackActionWhenNarrow
      action={
        fix && actionable ? (
          <RoundButton
            testID={`${props.testID}.review`}
            size="small"
            display="secondary"
            title={fix}
            loading={applying}
            disabled={disabled}
            onPress={open}
          />
        ) : undefined
      }
      onPress={actionable && !disabled ? open : undefined}
    />
  );
}
