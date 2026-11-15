import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { InlineStatus } from '@/components/ui/status/InlineStatus';
import type { IconName } from '@/components/ui/icons/Icon';
import { Icon } from '@/components/ui/icons/Icon';
import {
  CollectionNavigationRow,
  type CollectionNavigationRowProps,
} from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';

import type { deploymentRailState } from '../deploymentPresentation';

/** An Environment's state while it needs the person or deploys (`deploymentRailState`); healthy has none. */
export type DeploymentEnvironmentState = NonNullable<
  ReturnType<typeof deploymentRailState>
>;

/**
 * The one Environment state mark (UI refinements ruling 2026-11-15 08:57Z): plugin-ui `Status` inline, its dot and word
 * in the state's tone, pulsing while a deploy works. Every Environment row draws its state through here: the Services
 * list, the Services column, the Projects tree and the rail rows, through the app's one inline `Status` (`InlineStatus`).
 */
export const DeploymentEnvironmentStateMark = React.memo(
  function DeploymentEnvironmentStateMark(
    props: Readonly<{
      state: DeploymentEnvironmentState;
      testID?: string;
    }>,
  ) {
    return (
      <InlineStatus
        tone={props.state.tone ?? 'neutral'}
        label={props.state.text}
        pulsing={props.state.tone === null}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      />
    );
  },
);

/** An Environment's mark: a platform (Vercel, Cloudflare) is a cloud; a Machine target is its drives. */
export function deploymentEnvironmentGlyph(platform: boolean): IconName {
  return platform ? 'cloud' : 'hard-drives';
}

/** The platform a platform Environment runs on: the plugin that declares it and its name ("Vercel"). */
export type DeploymentPlatformIdentity = Readonly<{ pluginId: string; title: string }>;

/**
 * An Environment's identity mark (lab d1 rail, d4 header): a platform Environment carries its platform's own brand
 * (Vercel's triangle, Cloudflare's cloud), a Machine target its drives. One owner for the rail, All deployments and
 * the Environment header.
 */
export const DeploymentEnvironmentMark = React.memo(function DeploymentEnvironmentMark(
  props: Readonly<{ platform: DeploymentPlatformIdentity | null; size?: 'row' | 'page' }>,
) {
  const { theme } = useUnistyles();
  const size = props.size ?? 'row';
  if (props.platform) return <PluginMark title={props.platform.title} pluginId={props.platform.pluginId} size={size} />;
  if (size === 'page') return <PageHeaderMarkIcon name={deploymentEnvironmentGlyph(false)} />;
  return (
    <HappierCollectionListMark>
      <Icon name={deploymentEnvironmentGlyph(false)} size={18} color={theme.colors.text.secondary} />
    </HappierCollectionListMark>
  );
});

/**
 * What a tree row stands for: an Environment, a service on its Machine or a database it runs, or a Project folded into
 * its one Environment (it keeps the Project's mark so top-level rows start on one edge, lab sideSvc).
 */
export type DeploymentTreeRowKind =
  | 'project'
  | 'environment'
  | 'service'
  | 'database';

function treeRowGlyph(
  kind: DeploymentTreeRowKind,
  platform: boolean,
): IconName {
  // The marks Machine → Services and Services → Databases already give services and databases.
  switch (kind) {
    case 'project':
      return 'folder';
    case 'environment':
      return deploymentEnvironmentGlyph(platform);
    case 'service':
      return 'cube';
    case 'database':
      return 'stack';
  }
}

/**
 * The end of an Environment row in a column or tree (lab rdProj / sideSvc: "v1.42", "● Deploy failed"): the state mark
 * while it needs the person or deploys, otherwise its one quiet fact (a version, an age, a database's engine).
 */
export function DeploymentEnvironmentRowEnd(
  props: Readonly<{
    state: DeploymentEnvironmentState | null;
    fact: string | null;
    testID?: string;
  }>,
) {
  const testID = props.testID === undefined ? {} : { testID: props.testID };
  if (props.state)
    return <DeploymentEnvironmentStateMark state={props.state} {...testID} />;
  return props.fact ? (
    <Text {...testID} numberOfLines={1} style={styles.fact}>
      {props.fact}
    </Text>
  ) : null;
}

/** One row of a column's Environment tree: an Environment, or what it runs one level under it. */
export type DeploymentTreeRowModel = Readonly<{
  kind: DeploymentTreeRowKind;
  title: string;
  titleQualifier?: string | null;
  /** An Environment on a platform target (its mark is a cloud). */
  platform?: boolean;
  state?: DeploymentEnvironmentState | null;
  fact?: string | null;
}>;

/**
 * The one Environment row of the column trees (UI refinements ruling 2026-11-15 08:57Z; lab "one row, one tree"): the
 * Services column and the Projects tree both draw an Environment, and the services and databases it runs, through this
 * row. One line: the mark, the name (and its Production qualifier), and the row's end. The caller owns the tree's
 * structure (level, disclosure, selection, keyboard) and where a press goes.
 */
export const DeploymentTreeRow = React.memo(function DeploymentTreeRow(
  props: Readonly<{
    row: DeploymentTreeRowModel;
    testID: string;
    selected: boolean;
    onPress: () => void;
  }> &
    Pick<
      CollectionNavigationRowProps,
      | 'href'
      | 'disclosure'
      | 'indentPx'
      | 'child'
      | 'treeItem'
      | 'rightElement'
      | 'dimmed'
      | 'accessibilityLabel'
      | 'count'
    >,
) {
  const { theme } = useUnistyles();
  const { row, testID, ...rest } = props;
  return (
    <CollectionNavigationRow
      {...rest}
      testID={testID}
      title={row.title}
      titleQualifier={row.titleQualifier ?? null}
      icon={
        <Icon
          name={treeRowGlyph(row.kind, row.platform === true)}
          size={16}
          color={theme.colors.text.secondary}
        />
      }
      // While it needs the person (a toned state, not a working deploy) the row keeps the shared needs-you treatment.
      needsYou={Boolean(row.state?.tone)}
      status={
        <DeploymentEnvironmentRowEnd
          state={row.state ?? null}
          fact={row.fact ?? null}
          testID={`${testID}:end`}
        />
      }
      accessibilityLabel={
        props.accessibilityLabel ??
        [row.title, row.titleQualifier, row.state?.text ?? row.fact]
          .filter(Boolean)
          .join(', ')
      }
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  fact: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
    minWidth: 0,
  },
}));
