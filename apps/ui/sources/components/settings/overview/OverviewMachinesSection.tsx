import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  machinePageHref,
  machinesIndexHref,
} from '@/components/machines/page/machinePageHref';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import {
  describeMachineAttentionWord,
  selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import {
  describeRest,
  useMachineFleetModel,
} from '@/components/machines/widgets/MachineFleetWidget';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Settings › Overview's Machines (lab H1): this Home's machines as rows of the page's one sheet, read
 * from the Machines widget's own fleet model. Each machine that needs the person is a row with its
 * state, quiet, at the row's end; every other machine is counted on the "All machines" row. Before the
 * machine list has arrived the row shows that it is reading, never "no machines".
 */
export const OverviewMachinesSection = React.memo(
  function OverviewMachinesSection(props: Readonly<{ testID: string }>) {
    const { theme } = useUnistyles();
    const { homeLabel, status, settled, refresh, fleet, presence, needs } = useMachineFleetModel();
    const door = useMachinesDoor();
    const router = useRouter();
    const open = React.useCallback(
      (href: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true)
          fireAndForget(result, { tag: 'OverviewMachinesSection.open' });
      },
      [router],
    );
    const byKey = React.useMemo(
      () => new Map(fleet.map((entry) => [entry.key, entry])),
      [fleet],
    );
    const needKeys = React.useMemo(
      () => new Set(needs.map((entry) => entry.key)),
      [needs],
    );
    const calm = fleet.filter(
      (entry) => entry.online && !needKeys.has(entry.key),
    );
    const offline = presence.offline;
    const failed = status === 'error' || status === 'signedOut';
    const reading = !failed && !settled && fleet.length === 0;
    const summary = reading || (failed && fleet.length === 0)
      ? null
      : settled && fleet.length === 0
          ? t('machines.widgets.body.fleet.noMachines')
          : describeRest(calm, offline, needs.length);
    const tone = resolveMachineAttentionWordColor(theme.colors);
    return (
      <ItemGroup title={t('machines.widgets.machine_fleet')} description={homeLabel}>
        {fleet.length > 0 && (failed || status === 'loading') ? (
          <SurfaceFreshnessLine testID={`${props.testID}.freshness`} busy={status === 'loading'}
            reason={t(status === 'loading' ? 'machines.widgets.body.common.loading' : 'machines.widgets.body.common.readFailed')}
            action={failed ? { testID: `${props.testID}.retry`, label: t('common.retry'), onPress: refresh } : undefined} />
        ) : null}
        {needs.map((need) => {
          const entry = byKey.get(need.key);
          const reason = selectHeadlineReason(need.attention);
          if (!entry || !reason) return null;
          return (
            <Item
              key={need.key}
              testID={`${props.testID}.machine.${entry.machine.id}`}
              icon={
                <Icon
                  name={entry.thisComputer ? 'laptop' : 'desktop'}
                  color={theme.colors.text.secondary}
                />
              }
              title={entry.name}
              titleEllipsizeMode="middle"
              detail={describeMachineAttentionWord(reason)}
              detailStyle={{ color: tone }}
              onPress={() =>
                open(
                  machinePageHref({
                    door,
                    target: {
                      serverId: entry.serverId,
                      machineId: entry.machine.id,
                    },
                  }),
                )
              }
            />
          );
        })}
        {reading ? <SurfaceStateCard testID={`${props.testID}.loading`} kind="loading" size="line"
          title={t('machines.widgets.body.common.loading')} /> : failed && fleet.length === 0 ? (
          <SurfaceStateCard testID={`${props.testID}.error`} kind="error" size="line"
            title={t('machines.widgets.body.common.readFailed')} action={{ testID: `${props.testID}.retry`, label: t('common.retry'), onPress: refresh }} />
        ) : <Item
          testID={`${props.testID}.all`}
          title={
            settled && fleet.length === 0
              ? t('machines.widgets.body.fleet.addMachine')
              : t('machines.widgets.body.activity.allMachines')
          }
          subtitle={summary ?? undefined}
          onPress={() => open(machinesIndexHref(door))}
        />}
      </ItemGroup>
    );
  },
);
