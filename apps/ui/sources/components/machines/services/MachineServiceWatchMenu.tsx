import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { machineServiceWatchChoices } from './machineServicesPresentation';
import { useMachineServiceWatch } from './useMachineServiceWatch';

/**
 * Watch a service (lab `services/watch`): the page's second way to add here, beside Deploy an app here. Opening it
 * asks the Machine what it can watch; the person picks any number, grouped by kind, and watches them at once. What
 * is already watched stays visible and can't be picked again.
 */
export function MachineServiceWatchMenu(props: Readonly<{
  serverId: string; machineId: string; machineName: string; rows: readonly MachineServiceRowV1[];
}>) {
  const { theme } = useUnistyles();
  const watcher = useMachineServiceWatch({ serverId: props.serverId, machineId: props.machineId });
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(NO_PICKS);
  const { discover } = watcher;
  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (next) discover(); else setPicked(NO_PICKS);
  }, [discover]);
  // Opened before this menu's Account binding resolved (the empty card mounts it just as the list answers), `discover`
  // did nothing; it asks as soon as it can, so the picker never stays on "Looking" with nothing asked.
  const unasked = open && watcher.discovery.kind === 'idle';
  React.useEffect(() => { if (unasked) discover(); }, [discover, unasked]);
  const choices = React.useMemo(() => watcher.discovery.kind === 'listed'
    ? machineServiceWatchChoices(watcher.discovery.candidates, props.rows) : [], [watcher.discovery, props.rows]);
  const items = React.useMemo((): readonly DropdownMenuItem[] => choices.map(choice => ({
    id: choice.candidateId,
    testID: `machine-services-watch-candidate:${choice.candidateId}`,
    title: choice.name,
    subtitle: choice.watched ? t('machineServices.watch.alreadyWatched')
      : `${choice.nativeResourceId} · ${t(`machineServices.state.${choice.phase}`)}`,
    category: choice.kind === 'systemd' || choice.kind === 'compose' ? t(`machineServices.kind.${choice.kind}`) : choice.kind,
    checked: picked.has(choice.candidateId),
    disabled: choice.watched,
  })), [choices, picked]);
  const chosen = choices.filter(choice => picked.has(choice.candidateId));
  const { watch } = watcher;
  const confirm = () => fireAndForget(watch(chosen).then((done) => { if (done) onOpenChange(false); }),
    { tag: 'MachineServices.watch' });
  const empty = watcher.discovery.kind === 'listed' ? t('machineServices.watch.none', { machine: props.machineName })
    : watcher.discovery.kind === 'unavailable' ? t('machineServices.watch.unavailable', { machine: props.machineName })
      : t('machineServices.watch.reading', { machine: props.machineName });
  const outcome = watcher.outcome?.kind === 'failed' ? t('machineServices.watch.failed', { count: watcher.outcome.count })
    : watcher.outcome?.kind === 'approval' ? t('machineServices.watch.approval') : null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      closeOnSelect={false}
      showCategoryTitles
      search
      searchPlaceholder={t('machineServices.watch.search')}
      emptyLabel={empty}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAnchorAlign="end"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('machineServices.watch.action')}
      onSelect={(id) => {
        if (choices.some(choice => choice.candidateId === id && !choice.watched)) setPicked(previous => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      }}
      footer={(
        <View style={styles.footer}>
          <Text variant="meta" style={[styles.note, { color: outcome ? theme.colors.state.warning.foreground : theme.colors.text.secondary }]}
            testID={outcome ? 'machine-services-watch-outcome' : undefined}>
            {outcome ?? t('machineServices.watch.note')}
          </Text>
          <RoundButton
            testID="machine-services-watch-confirm"
            size="small"
            title={chosen.length > 0 ? t('machineServices.watch.confirm', { count: chosen.length }) : t('machineServices.watch.confirmNone')}
            loading={watcher.pending}
            disabled={chosen.length === 0 || watcher.pending}
            onPress={confirm}
          />
        </View>
      )}
      trigger={({ toggle }) => (
        <RoundButton
          testID="machine-services-watch"
          size="small"
          display="secondary"
          title={t('machineServices.watch.action')}
          leading={<Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
          onPress={toggle}
        />
      )}
    />
  );
}

const NO_PICKS: ReadonlySet<string> = new Set();

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s12,
  },
  note: {
    flex: 1,
    minWidth: 0,
  },
}));
