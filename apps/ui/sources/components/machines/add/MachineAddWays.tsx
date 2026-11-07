import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  buildMachineAddHref,
  type MachineAddRoutePath,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { MachineAddPath } from './machineAddPaths';
import { useMachineAddPaths } from './useMachineAddPaths';

type MachineAddWay = Readonly<{
  id: 'create' | 'ssh' | 'computer';
  path: MachineAddRoutePath;
  icon: IconName;
  title: string;
  subtitle: string;
  /** The column's button (a wide card): what pressing does there. */
  action: string;
  /** One quiet fact beside the button: who bills it, where it runs, what it costs. */
  note: string;
}>;

/**
 * The ways in to the one Add chooser, from this device's add paths (`useMachineAddPaths`, the per-device
 * owner) plus Create in the cloud while the Account allows creating machines. "Your computer" is this
 * computer where it can be set up here, else linking another one.
 */
export function resolveMachineAddWays(
  input: Readonly<{ paths: readonly MachineAddPath[]; canCreate: boolean }>,
): readonly MachineAddWay[] {
  const copy = 'machines.widgets.body.fleet.firstRun';
  const ways: MachineAddWay[] = [];
  if (input.canCreate) {
    ways.push({
      id: 'create',
      path: 'create',
      icon: 'cloud',
      title: t(`${copy}.createTitle`),
      subtitle: t(`${copy}.createSubtitle`),
      action: t(`${copy}.createAction`),
      note: t(`${copy}.billedNote`),
    });
  }
  const ssh = input.paths.find((path) => path.id === 'ssh');
  if (ssh) {
    ways.push({
      id: 'ssh',
      path: 'ssh',
      icon: 'hard-drives',
      title: t(`${copy}.sshTitle`),
      subtitle: t(
        ssh.runs === 'command'
          ? `${copy}.sshCommandSubtitle`
          : `${copy}.sshTaskSubtitle`,
      ),
      action: t(ssh.runs === 'command' ? `${copy}.getCommandAction` : `${copy}.connectAction`),
      note: t(`${copy}.sshNote`),
    });
  }
  const thisComputer = input.paths.find(
    (path) => path.id === 'thisComputer' && !path.connectedMachineId,
  );
  const another = input.paths.find((path) => path.id === 'anotherComputer');
  if (thisComputer) {
    ways.push({
      id: 'computer',
      path: 'thisComputer',
      icon: 'laptop',
      title: t(`${copy}.computerTitle`),
      subtitle: t(
        thisComputer.runs === 'task'
          ? `${copy}.computerTaskSubtitle`
          : `${copy}.computerCommandSubtitle`,
      ),
      action: t(thisComputer.runs === 'task' ? `${copy}.setUpAction` : `${copy}.getCommandAction`),
      note: t(`${copy}.freeNote`),
    });
  } else if (another) {
    ways.push({
      id: 'computer',
      path: 'anotherComputer',
      icon: 'laptop',
      title: t(`${copy}.computerTitle`),
      subtitle: t(`${copy}.computerLinkSubtitle`),
      action: t(`${copy}.getAppAction`),
      note: t(`${copy}.freeNote`),
    });
  }
  return ways;
}

/**
 * "Where should your agents run?" (58d AF1, lab `af-first`): the Machines widget's empty state while the
 * Home has no machine. It says the question once and lists the ways in; each opens the one Add chooser at
 * that way. Reading it asks no machine anything (there is none) and starts nothing. On a full-width card
 * (Machines leads Home's first run) the ways stand side by side as columns, each with its button and one
 * quiet fact; on a half card or a phone they are rows.
 */
export function MachineAddWays(
  props: Readonly<{ serverId?: string; testIDPrefix: string }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  // The question starts on the rows' own edge (their glyph column), so it reads as the list's heading.
  const rowInset = ITEM_ROW_PADDING_HORIZONTAL[useResolvedItemDensity()];
  const paths = useMachineAddPaths(props.serverId);
  const canCreate = useSetting('managedMachineCreationEnabled') !== false;
  const ways = React.useMemo(
    () => resolveMachineAddWays({ paths, canCreate }),
    [canCreate, paths],
  );
  const wide = useIsTablet();
  const columns = useWidgetPresentation()?.footprint.width === 'full' && wide;
  const open = React.useCallback(
    (path: MachineAddRoutePath) => {
      const result = runGuardedNavigation(() =>
        router.push(buildMachineAddHref({ path }) as never),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'MachineAddWays.open' });
    },
    [router],
  );
  return (
    <View testID={`${props.testIDPrefix}.ways`}>
      {/* Over columns the question starts on the card's title edge, as its first line; over rows it starts on
          the rows' glyph column, as their heading. */}
      <View style={columns ? styles.columnsLead : [styles.lead, { paddingHorizontal: rowInset }]}>
        <Text style={styles.title}>
          {t('machines.widgets.body.fleet.firstRun.title')}
        </Text>
        <Text style={styles.reason}>
          {t('machines.widgets.body.fleet.firstRun.reason')}
        </Text>
      </View>
      {columns ? (
        <View style={styles.columns}>
          {ways.map((way, index) => (
            <View key={way.id} testID={`${props.testIDPrefix}.way.${way.id}`}
              // The outer columns keep the card's text edges; seams sit midway in the gutters between them.
              style={[styles.column, index > 0 ? styles.columnSeam : null, index < ways.length - 1 ? styles.columnBeforeSeam : null]}>
              <Icon name={way.icon} color={theme.colors.text.secondary} />
              <Text style={styles.columnTitle}>{way.title}</Text>
              <Text style={styles.columnReason}>{way.subtitle}</Text>
              <View style={styles.columnFoot}>
                <RoundButton
                  testID={`${props.testIDPrefix}.way.${way.id}.action`}
                  size="small"
                  // The first way leads (lab af-first: Create); the others are quieter.
                  display={index === 0 ? 'default' : 'secondary'}
                  title={way.action}
                  onPress={() => open(way.path)}
                />
                <Text style={styles.note} numberOfLines={1}>{way.note}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : ways.map((way) => (
        <Item
          key={way.id}
          testID={`${props.testIDPrefix}.way.${way.id}`}
          title={way.title}
          subtitle={way.subtitle}
          icon={<Icon name={way.icon} color={theme.colors.text.secondary} />}
          onPress={() => open(way.path)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  lead: {
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
    gap: theme.space.s2,
  },
  title: {
    ...Typography.variant('body'),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  reason: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  // The card's description rhythm (frame title → description): the question, then its line, then the ways.
  columnsLead: {
    paddingBottom: theme.space.s12,
    gap: theme.space.s2,
  },
  // Each column reads top-down at the card's own rhythm: mark, title, line, then its button right after.
  columns: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  column: {
    flex: 1,
    minWidth: 0,
    paddingTop: theme.space.s16,
  },
  columnSeam: {
    paddingLeft: theme.space.s16,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  columnBeforeSeam: {
    paddingRight: theme.space.s16,
  },
  columnTitle: {
    ...Typography.variant('body'),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    marginTop: theme.space.s12,
  },
  columnReason: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginTop: theme.space.s2,
  },
  columnFoot: {
    marginTop: theme.space.s12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  note: {
    ...Typography.variant('micro'),
    ...Typography.tabular(),
    flexShrink: 1,
    color: theme.colors.text.tertiary,
  },
}));
