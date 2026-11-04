import * as React from 'react';
import { formatHappierCapabilityCount as formatCapabilityCount } from '@happier-dev/plugin-ui/presentation';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  McpServerToolSettingsPatchV1,
  McpToolSettingV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { resolveViewportClass } from '@/utils/platform/viewportClass';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { Typography } from '@/constants/Typography';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';
import { t } from '@/text';

import {
  McpToolDecisionBadges,
  mcpToolEffect,
  type McpToolEffect,
} from './McpToolDecisionBadges';
import type { McpServerToolsList } from './useMcpServerTools';

type ServerDefault = McpServerToolsList['settings']['default'];
type ToolRow = McpServerToolsList['tools'][number];
type Filter = 'all' | 'read' | 'write' | 'destructive' | 'set';

/** Rows shown before "Show all": enough to read the policy, short enough to reach Configuration. */
const COLLAPSED_ROWS = 9;
/** A search field once the list no longer reads at a glance (the collections' rule). */
const SEARCH_THRESHOLD = 8;

export type McpToolAgentNotes = Readonly<{
  /** Agents that load tools on demand (cost note). */
  onDemand: readonly string[];
  /** Agents with no tool control: settings don't apply (D24). */
  notApply: readonly string[];
  /** Agents where Off blocks at call time instead of hiding. */
  blocked: readonly string[];
  /** Agents where Off hides at launch: turning back on applies to new sessions. */
  hidden: readonly string[];
}>;

/** The per-Agent truth from the projected facts (D24): who loads on demand, who ignores settings, who blocks. */
export function describeMcpToolAgents(
  perAgent: McpServerToolsList['perAgent'],
  agentNames: (agentIds: readonly string[]) => readonly string[],
  installedAgentIds: readonly string[],
): McpToolAgentNotes {
  const installed = new Set(installedAgentIds);
  const names = (
    predicate: (
      agent: McpServerToolsList['perAgent']['agents'][number],
    ) => boolean,
  ) =>
    agentNames(
      perAgent.agents
        .filter((agent) => installed.has(agent.agentId) && predicate(agent))
        .map((agent) => agent.agentId),
    );
  return {
    onDemand: names((agent) => agent.loading === 'on_demand'),
    notApply: names((agent) => agent.approval === null && agent.off === null),
    blocked: names((agent) => agent.off === 'blocked'),
    hidden: names((agent) => agent.off === 'hidden'),
  };
}

/**
 * A server's Tools section (md A, inline): the default for its tools, then each tool with what it does
 * and the three choices always visible. A value that follows the default is an outlined thumb; a value
 * the person set is filled and marked "Set by you", so the few they chose stand out from the quiet column.
 * The foot says honestly which Agents the settings don't reach (D24).
 */
export const McpServerToolsSection = React.memo(function McpServerToolsSection(
  props: Readonly<{
    status: 'loading' | 'ready' | 'unavailable';
    list: McpServerToolsList | null;
    agentNames: (agentIds: readonly string[]) => readonly string[];
    /** The Agents installed on the person's machines (D24 names only these). */
    installedAgentIds: readonly string[];
    onChange: (patch: McpServerToolSettingsPatchV1) => Promise<string | null>;
    /** Why the tools couldn't be read (a diagnostic code) and the way to read them again. */
    errorCode?: string | null;
    onRetry?: () => void;
    /** The tools are a last-known list (sign-in expired): dimmed, dated, not editable. */
    stale?: Readonly<{ date: string }> | null;
    readOnly?: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const list = props.list;
  const tools = list?.tools ?? [];
  const serverDefault: ServerDefault = list?.settings.default ?? 'ask';
  const editable = props.readOnly !== true && !props.stale && list !== null;

  const counts = React.useMemo(() => {
    const result = {
      all: tools.length,
      read: 0,
      write: 0,
      destructive: 0,
      set: 0,
    };
    for (const tool of tools) {
      const effect = mcpToolEffect(tool.annotations);
      if (effect === 'read') result.read += 1;
      else if (effect === 'destructive') result.destructive += 1;
      else result.write += 1;
      if (tool.source === 'tool') result.set += 1;
    }
    return result;
  }, [tools]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tools.filter((tool) => {
      const effect = mcpToolEffect(tool.annotations);
      if (filter === 'read' && effect !== 'read') return false;
      if (filter === 'write' && effect !== 'write') return false;
      if (filter === 'destructive' && effect !== 'destructive') return false;
      if (filter === 'set' && tool.source !== 'tool') return false;
      if (!needle) return true;
      return (
        tool.name.toLocaleLowerCase().includes(needle) ||
        (tool.title ?? '').toLocaleLowerCase().includes(needle)
      );
    });
  }, [filter, query, tools]);
  const filtered = filter !== 'all' || query.trim() !== '';
  const shown =
    showAll || filtered ? visible : visible.slice(0, COLLAPSED_ROWS);

  const change = React.useCallback(
    async (patch: McpServerToolSettingsPatchV1) => {
      setFailure(null);
      const error = await props.onChange(patch);
      if (error) setFailure(error);
    },
    [props.onChange],
  );

  const notes =
    list && list.perAgent.status === 'ready'
      ? describeMcpToolAgents(list.perAgent, props.agentNames, props.installedAgentIds)
      : null;
  const footLines = notes
    ? [
        notes.notApply.length > 0
          ? t('capabilities.mcp.tools.notApply', {
              agents: formatAgentNameList(notes.notApply),
            })
          : null,
        notes.blocked.length > 0
          ? t('capabilities.mcp.tools.blocked', {
              agents: formatAgentNameList(notes.blocked),
            })
          : null,
        notes.hidden.length > 0 && tools.some((tool) => tool.setting === 'off')
          ? t('capabilities.mcp.tools.hiddenRestart', {
              agents: formatAgentNameList(notes.hidden),
            })
          : null,
      ].filter((line): line is string => line !== null)
    : [];

  const description = props.stale
    ? t('capabilities.mcp.tools.lastListed', { date: props.stale.date })
    : t('capabilities.mcp.tools.description');

  if (list === null) {
    return (
      <ItemGroup
        testID={props.testID}
        title={t('capabilities.mcp.tools.title')}
        description={t('capabilities.mcp.tools.description')}
      >
        {props.status === 'loading' ? (
          // The tools are being listed: placeholder rows in their place, never a dash that reads as data.
          <View testID={`${props.testID}:loading`}>
            <SkeletonRows rows={2} />
          </View>
        ) : (
          <SurfaceStateCard
            testID={`${props.testID}:unavailable`}
            kind="error"
            size="line"
            title={t('capabilities.mcp.tools.loadFailed')}
            diagnosticCode={props.errorCode ?? undefined}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
          />
        )}
      </ItemGroup>
    );
  }

  return (
    <ItemGroup
      testID={props.testID}
      title={t('capabilities.mcp.tools.title')}
      description={description}
    >
      {props.stale ? null : (
        <SegmentedChoiceItem<ServerDefault>
          testID={`${props.testID}:default`}
          testIDPrefix={`${props.testID}:default`}
          title={t('capabilities.mcp.tools.defaultTitle')}
          value={serverDefault}
          disabled={!editable}
          options={[
            {
              id: 'ask',
              label: t('capabilities.mcp.tools.defaultAsk'),
              description: t('capabilities.mcp.tools.defaultAskDescription'),
            },
            {
              id: 'allow_read_only',
              label: t('capabilities.mcp.tools.defaultReadOnly'),
              description: t(
                'capabilities.mcp.tools.defaultReadOnlyDescription',
              ),
            },
            {
              id: 'allow_all',
              label: t('capabilities.mcp.tools.defaultAll'),
              description: t('capabilities.mcp.tools.defaultAllDescription'),
            },
          ]}
          onChange={(next) => void change({ default: next })}
        />
      )}
      {tools.length === 0 ? (
        <SectionContentRow testID={`${props.testID}:notListed`}>
          <Text variant="meta" style={styles.note}>
            {t('capabilities.mcp.tools.notListed')}
          </Text>
        </SectionContentRow>
      ) : (
        <>
          {list.tokens !== null && !props.stale ? (
            <SectionContentRow testID={`${props.testID}:cost`}>
              <Text variant="meta" style={styles.note}>
                {t('capabilities.mcp.tools.cost', {
                  count: tools.length,
                  tokens: formatCapabilityCount(list.tokens),
                })}
                {notes && notes.onDemand.length > 0
                  ? ` ${t('capabilities.mcp.tools.onDemand', { agents: formatAgentNameList(notes.onDemand), count: tools.length })}`
                  : null}
              </Text>
            </SectionContentRow>
          ) : null}
          {props.stale ? null : (
            <SectionContentRow testID={`${props.testID}:filters`}>
              <View style={styles.filters}>
                {tools.length > SEARCH_THRESHOLD ? (
                  <View style={styles.search}>
                    <CompactSearchField
                      testID={`${props.testID}:search`}
                      value={query}
                      onChangeText={setQuery}
                      placeholder={t('capabilities.mcp.tools.search', {
                        count: tools.length,
                      })}
                    />
                  </View>
                ) : null}
                <SegmentedTabBar<Filter>
                  presentation="pills"
                  testIDPrefix={`${props.testID}:filter`}
                  accessibilityLabel={t('capabilities.mcp.tools.title')}
                  activeTabId={filter}
                  onSelectTab={setFilter}
                  tabs={[
                    {
                      id: 'all',
                      label: t('capabilities.mcp.tools.filterAll'),
                      count: String(counts.all),
                    },
                    ...(counts.read > 0
                      ? [
                          {
                            id: 'read' as const,
                            label: t('capabilities.mcp.tools.filterReadOnly'),
                            count: String(counts.read),
                          },
                        ]
                      : []),
                    ...(counts.write > 0
                      ? [
                          {
                            id: 'write' as const,
                            label: t('capabilities.mcp.tools.filterWrites'),
                            count: String(counts.write),
                          },
                        ]
                      : []),
                    ...(counts.destructive > 0
                      ? [
                          {
                            id: 'destructive' as const,
                            label: t(
                              'capabilities.mcp.tools.filterDestructive',
                            ),
                            count: String(counts.destructive),
                          },
                        ]
                      : []),
                    ...(counts.set > 0
                      ? [
                          {
                            id: 'set' as const,
                            label: t('capabilities.mcp.tools.filterSetByYou'),
                            count: String(counts.set),
                          },
                        ]
                      : []),
                  ]}
                />
              </View>
            </SectionContentRow>
          )}
          {shown.length === 0 ? (
            <Item
              testID={`${props.testID}:noMatch`}
              title={t('capabilities.mcp.tools.noMatch')}
              showChevron={false}
            />
          ) : (
            shown.map((tool) => (
              <McpToolRow
                key={tool.name}
                tool={tool}
                serverDefault={serverDefault}
                editable={editable}
                dimmed={Boolean(props.stale)}
                onChange={(value) =>
                  void change({ tools: { [tool.name]: value } })
                }
                testID={`${props.testID}:tool:${tool.name}`}
              />
            ))
          )}
          {!showAll && !filtered && visible.length > COLLAPSED_ROWS ? (
            <Item
              testID={`${props.testID}:showAll`}
              title={t('capabilities.mcp.tools.showAll', {
                count: visible.length,
              })}
              titleStyle={{ color: theme.colors.text.secondary }}
              onPress={() => setShowAll(true)}
              showChevron={false}
            />
          ) : null}
        </>
      )}
      {failure ? (
        <SurfaceStateCard
          testID={`${props.testID}:error`}
          kind="error"
          size="line"
          title={t('capabilities.mcp.tools.setFailed')}
          diagnosticCode={failure}
        />
      ) : null}
      {footLines.length > 0 ? (
        <SectionContentRow testID={`${props.testID}:agents`}>
          {footLines.map((line) => (
            <Text key={line} variant="meta" style={styles.note}>
              {line}
            </Text>
          ))}
        </SectionContentRow>
      ) : null}
    </ItemGroup>
  );
});

function settingLabel(value: McpToolSettingV1): string {
    return value === 'off' ? t('capabilities.mcp.tools.off') : value === 'ask' ? t('capabilities.mcp.tools.ask') : t('capabilities.mcp.tools.allow');
}

const McpToolRow = React.memo(function McpToolRow(props: Readonly<{
    tool: ToolRow;
    serverDefault: ServerDefault;
    editable: boolean;
    dimmed: boolean;
    onChange: (value: McpToolSettingV1 | 'inherit') => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const { tool } = props;
    const effect = mcpToolEffect(tool.annotations);
    const set = tool.source === 'tool' && tool.setting !== 'inherit';
    // Normal mode with no tool override can only inherit Ask or Allow.
    const inherited = resolveMcpToolDecisionV1({
        policy: { default: props.serverDefault, overrides: {} },
        toolName: tool.name,
        annotations: tool.annotations,
        permissionMode: 'default',
    }).approval as 'ask' | 'allow';
    const value: McpToolSettingV1 = set ? tool.setting as McpToolSettingV1 : inherited;
    const compact = resolveViewportClass(useWindowDimensions()) === 'compact';
    const title = tool.title ?? tool.name;
    const tabs = React.useMemo(() => [
        { id: 'off' as const, label: t('capabilities.mcp.tools.off') },
        { id: 'ask' as const, label: t('capabilities.mcp.tools.ask') },
        { id: 'allow' as const, label: t('capabilities.mcp.tools.allow') },
    ], []);
    return (
        <Item
            testID={props.testID}
            title={title}
            titleStyle={props.dimmed ? { color: theme.colors.text.secondary } : undefined}
            titleAccessory={(
                <View style={styles.titleAccessory}>
                    {tool.title && tool.title !== tool.name ? <Text variant="micro" style={styles.mono} numberOfLines={1}>{tool.name}</Text> : null}
                    {set ? (
                        // "Set by you": the dot is also the way back to the server's default for this tool.
                        <IconButton
                            testID={`${props.testID}:setByYou`}
                            icon={<StatusDot color={theme.colors.state.info.foreground} size={6} />}
                            size={16}
                            variant="plain"
                            accessibilityLabel={t('capabilities.mcp.tools.backToDefault', { value: settingLabel(inherited) })}
                            tooltip={t('capabilities.mcp.tools.backToDefault', { value: settingLabel(inherited) })}
                            disabled={!props.editable}
                            onPress={() => props.onChange('inherit')}
                        />
                    ) : null}
                </View>
            )}
            subtitle={tool.description}
            subtitleLines={1}
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={(
                <View style={styles.controls}>
                    <McpToolDecisionBadges effect={effect} />
                    {props.dimmed ? null : compact ? (
                        // Phone: the value in a field; the choices (and the way back to the default) in its menu.
                        <ValueFieldSelect
                            testID={`${props.testID}:value`}
                            label={title}
                            items={set ? [...tabs.map((tab) => ({ id: tab.id, title: tab.label })), { id: 'inherit', title: t('capabilities.mcp.tools.useDefault', { value: settingLabel(inherited) }) }]
                                : tabs.map((tab) => ({ id: tab.id, title: tab.label }))}
                            selectedId={value}
                            disabled={!props.editable}
                            onSelect={(id) => props.onChange(id as McpToolSettingV1 | 'inherit')}
                            compact
                        />
                    ) : (
                        // A value choice: choosing on an outlined (default) thumb makes the value the person's own.
                        <SegmentedTabBar<McpToolSettingV1>
                            tabs={tabs}
                            activeTabId={value}
                            onSelectTab={props.onChange}
                            segmentSizing="content"
                            compact
                            disabled={!props.editable}
                            accessibilityLabel={title}
                            role="radiogroup"
                            valueSource={set ? 'set' : 'inherited'}
                            testIDPrefix={props.testID}
                        />
                    )}
                </View>
            )}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
  note: { color: theme.colors.text.secondary },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  search: { minWidth: 160, flexBasis: 180, flexShrink: 1 },
  titleAccessory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
    flexShrink: 1,
  },
  mono: { color: theme.colors.text.tertiary, ...Typography.mono() },
    controls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
}));
