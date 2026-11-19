import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { TriggerSummarySource } from '../triggers/formatTriggerSummary';

import { resolveTriggerEventGroup } from '../triggers/triggerEventGroups';

/**
 * One mark of what a workflow uses (scene 8): what starts it, then the Agents its steps run on. A trigger mark is
 * the trigger owner's own event glyph in ink; an Agent mark is the Agent's identity mark in its own colour.
 */
export type WorkflowMark =
  | Readonly<{ key: string; kind: 'trigger'; icon: IconName; label: string }>
  | Readonly<{ key: string; kind: 'agent'; agentId: string; label: string }>;

/**
 * What starts a workflow, as marks: each distinct event glyph from the trigger owner (`resolveTriggerEventGroup`), or
 * the manual mark when nothing starts it by itself. The Agents follow from the list-model owner when it carries them.
 */
export function readWorkflowStartMarks(
  triggers: readonly (TriggerSummarySource & Readonly<{ enabled?: boolean }>)[],
  agents: readonly PluginContributionIdentityV1[] = [],
  includeStart = true,
): readonly WorkflowMark[] {
  const marks: WorkflowMark[] = [];
  if (includeStart && triggers.length === 0) {
    marks.push({ key: 'trigger:manual', kind: 'trigger', icon: 'play', label: t('workflows.triggers.summary.manual') });
  }
  const seen = new Set<string>();
  for (const trigger of includeStart ? triggers : []) {
    const group = resolveTriggerEventGroup(trigger);
    if (seen.has(group.glyph)) continue;
    seen.add(group.glyph);
    marks.push({
      key: `trigger:${group.glyph}`,
      kind: 'trigger',
      icon: group.glyph,
      label: group.title,
    });
  }
  for (const agent of agents) {
    const agentId = buildQualifiedPluginContributionKey(agent);
    marks.push({ key: agentId, kind: 'agent', agentId, label: agent.localId });
  }
  return marks;
}

/**
 * A workflow's marks, built once for every place that draws them (scene 8 "Uses"): side by side in a table cell or a
 * card (`row`, up to four then "+N"), or as a tight cluster at the end of a sidebar row's title line (`cluster`, up to
 * three then "+N"). The marks stand bare (no tile or plate); one accessible name says what the workflow uses.
 */
export const WorkflowMarks = React.memo(function WorkflowMarks(
  props: Readonly<{
    marks: readonly WorkflowMark[];
    layout: 'row' | 'cluster';
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const max = props.layout === 'row' ? 4 : 3;
  const shown =
    props.marks.length > max ? props.marks.slice(0, max - 1) : props.marks;
  const more = props.marks.length - shown.length;
  const size = props.layout === 'row' ? ICON_SIZE.xs : ICON_SIZE.xxs;
  const label = props.marks.map((mark) => mark.label).join(', ');
  if (props.marks.length === 0) return null;
  return (
    <View
      testID={props.testID}
      style={[styles.marks, props.layout === 'cluster' ? styles.cluster : null]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      {shown.map((mark) => (
        <View
          key={mark.key}
          style={props.layout === 'row' ? styles.slot : styles.clusterSlot}
        >
          {mark.kind === 'agent' ? (
            <AgentIcon agentId={mark.agentId} size={size} />
          ) : (
            <Icon
              name={mark.icon}
              size={size}
              color={theme.colors.text.secondary}
            />
          )}
        </View>
      ))}
      {more > 0 ? (
        <View style={styles.more}>
          <Text
            variant="meta"
            style={styles.moreText}
            numberOfLines={1}
          >{`+${more}`}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  marks: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: theme.space.s2,
  },
  cluster: {
    gap: 0,
  },
  slot: {
    width: ICON_SIZE.sm,
    height: ICON_SIZE.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A tight cluster at the title line's end: the slots touch, so the marks read as one object beside the name.
  clusterSlot: {
    width: ICON_SIZE.xs,
    height: ICON_SIZE.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  more: {
    minWidth: ICON_SIZE.sm,
    height: ICON_SIZE.sm,
    paddingHorizontal: theme.space.s4,
    marginLeft: theme.space.s2,
    borderRadius: ICON_SIZE.sm / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.selected,
  },
  moreText: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
