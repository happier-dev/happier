import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectDefinitionDetectionV1, ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ProjectNativeInvocationDetail } from './ProjectNativeInvocationDetail';
import { ProjectScriptRow } from './ProjectScriptRow';
import { describeProjectCommandSource } from './projectScriptPresentation';
import { useProjectScriptRun } from './projectScriptRuns';
import type { ProjectScriptsController } from './useProjectScriptsController';

/** The inventory owner supplies stable identity and only the controller facts this row consumes. */
export const DetectedRow = React.memo(function DetectedRow(props: Readonly<{
  testID: string;
  workspace: WorkspaceAddressV1;
  entry: ProjectDefinitionDetectionV1['entries'][number];
  rowKey: string;
  accountId: string | null;
  pending: boolean;
  failureCode: string | null;
  run: ProjectScriptsController['run'];
  compact: boolean;
  showDivider: boolean;
  onOpenServices?: () => void;
}>) {
  const { theme } = useUnistyles();
  const source = props.entry.source;
  const operation = useProjectScriptRun(props.workspace, { kind: 'native', source }, props.accountId);
  const { run, rowKey } = props;
  const onRun = React.useCallback(() => { void run(rowKey, { kind: 'native', source }); }, [run, rowKey, source]);
  if (props.entry.usage === 'service') return (
    <Item testID={props.testID} showDivider={props.showDivider}
      icon={<Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />}
      title={source.target}
      titleAccessory={<Text style={[styles.groupMeta, styles.badge, { color: theme.colors.text.tertiary }]}>
        {t('projects.scripts.service')}
      </Text>}
      detail={props.onOpenServices ? t('projects.scripts.openServices') : undefined}
      mode={props.onOpenServices ? 'interactive' : 'info'}
      showChevron={Boolean(props.onOpenServices)}
      {...(props.onOpenServices ? { onPress: props.onOpenServices } : {})} />
  );
  return <ProjectScriptRow testID={props.testID} workspace={props.workspace}
    name={source.target} badge={null} command={describeProjectCommandSource(source).command}
    nativeSource={source} accountId={props.accountId} portable={false} operation={operation}
    idleText="" pending={props.pending} failureCode={props.failureCode} compact={props.compact}
    showDivider={props.showDivider} onRun={onRun} />;
});

/** Kept separate from paging so an unchanged reference retains its disclosure and Add control. */
export const FoundScriptReferenceRow = React.memo(function FoundScriptReferenceRow(props: Readonly<{
  testID: string;
  workspace: WorkspaceAddressV1;
  accountId: string | null;
  source: ProjectNativeRefV1;
  id: string;
  pending: boolean;
  disabled: boolean;
  add: ProjectScriptsController['add'];
  showDivider: boolean;
}>) {
  const { theme } = useUnistyles();
  const description = describeProjectCommandSource(props.source);
  return <FoundNativeReferenceRow workspace={props.workspace} accountId={props.accountId}
    source={props.source} testID={props.testID} showDivider={props.showDivider}
    icon={<Icon name="circle" size={18} color={theme.colors.text.tertiary} />}
    title={props.source.target} subtitle={description.reference}
    titleAccessory={<StatusPill variant="neutral" hideDot label={description.badge ?? props.source.file}
      labelStyle={styles.mono} style={styles.badge} />}
    rightElement={<RoundButton size="small" display="secondary" title={t('projects.scripts.addToProjectFile')}
      testID={`${props.testID}.add`} loading={props.pending} disabled={props.disabled}
      onPress={() => { void props.add(`add:${props.id}`, props.source); }} />} />;
});

/** A closed reference does not acquire its invocation detail. */
function FoundNativeReferenceRow(props: Omit<React.ComponentProps<typeof Item>, 'mode' | 'onPress'> & Readonly<{
  workspace: WorkspaceAddressV1;
  accountId: string | null;
  source: ProjectNativeRefV1;
}>) {
  const { workspace, accountId, source, ...item } = props;
  const [expanded, setExpanded] = React.useState(false);
  return <ExpandableItem testID={`${item.testID}.disclosure`} expanded={expanded}
    onExpandedChange={setExpanded} showDivider={item.showDivider}
    header={({ headerProps }) => <Item {...item} {...headerProps} rightElementOutsidePressable
      showChevron={false} rightElement={<View style={styles.setupTail}>
        {item.rightElement}<DisclosureCaret expanded={expanded} size={14} />
      </View>} />}>
    {expanded ? <ProjectNativeInvocationDetail workspace={workspace} accountId={accountId}
      source={source} usage="script" testID={`${item.testID}.nativeDetail`} /> : null}
  </ExpandableItem>;
}

const styles = StyleSheet.create((theme) => ({
  setupTail: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10 },
  mono: { ...Typography.mono() },
  badge: { marginLeft: theme.space.s8 },
  groupMeta: { ...Typography.default(), ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary, marginLeft: theme.space.s8 },
}));
