import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Status } from '@happier-dev/plugin-ui';
import { HappierDataMetric, HAPPIER_DATA_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SavedHealthCheckRefV1Schema } from '@happier-dev/protocol/inputs/savedHealthCheckOptions';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { useManagedInventory, type ManagedInventoryQuery } from '@/components/store/inventory/useManagedInventory';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import {
  useWidgetFrameBodyCaption,
  useWidgetFrameBodyIdentity,
  useWidgetFrameBodyMeta,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import { WidgetFrameLoadingBody } from '@/components/widgets/frame/WidgetFrameLoadingBody';
import { Typography } from '@/constants/Typography';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import { ServiceCheckBars, type ServiceCheckBarCell } from './ServiceCheckBars';
import {
  SERVICE_CHECK_ROW_BARS,
  serviceCheckListFacts,
  serviceCheckShownDefinition,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  serviceCheckUptimeText,
} from './serviceCheckPresentation';
import { useEnvironmentName } from './useEnvironmentName';

const m = 'projects.deployments.monitoring' as const;
const CHECK_KINDS = ['configuredCheck'] as const;
const NO_MARK_TITLE = null;

/**
 * The Check widget (D32 key flows, lab p7Surfaces home): one saved Check the person picked, found in the Account's
 * managed inventory (the Checks list's own read, so its name, rule and results are the ones Monitoring shows). It reads
 * only while presented, and names the Check in its frame.
 */
export function ServiceCheckWidgetBody(props: Readonly<{ input: Readonly<Record<string, JsonValue>>; serverId: string; testID: string }>) {
  const parsed = SavedHealthCheckRefV1Schema.safeParse(props.input.check);
  const address = parsed.success && areServerProfileIdentifiersEquivalent(parsed.data.serverId, props.serverId) ? parsed.data : null;
  const presented = useLayoutPresentationActive();
  const lifetime = useActiveServerAccountScopeLifetime();
  const scope = lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.serverId) ? lifetime.scope : null;
  const bound = address !== null;
  // Nothing is read until a Check is chosen and the widget is on screen.
  const query = React.useMemo<ManagedInventoryQuery>(() => ({ scope, machine: null, projectKey: null,
    presented: presented && bound, kinds: CHECK_KINDS }), [bound, presented, scope]);
  const checks = useManagedInventory(query).operationalFamilies.configuredCheck;
  const row = address ? checks.rows.find((candidate) => candidate.automationId === address.automationId
    && candidate.triggerId === address.triggerId) ?? null : null;
  // The picked Check may sit on a later Automation page than the one the inventory read first: read on until it is
  // found or the pages end, as the Checks list's Show more does.
  const more = !row && typeof checks.coverage === 'object' && 'partial' in checks.coverage
    && checks.coverage.partial === 'automation_page' ? checks.continuation : undefined;
  React.useEffect(() => { void more?.(); }, [more]);
  const head = row ? serviceCheckShownDefinition(row.definitionFacts, null) : null;
  const environmentId = presented && head?.kind === 'available' ? head.definition.keyFlow?.environmentId ?? null : null;
  const environment = useEnvironmentName(row?.scope.serverId ?? null, environmentId).name;
  if (!address) return <ServiceCheckWidgetState text={t(`${m}.widgetChooseCheck`)} testID={`${props.testID}.choose`} />;
  if (row) return <ServiceCheckWidgetView row={row} environmentName={environment} testID={props.testID} />;
  const reading = checks.coverage === 'loading' || more !== undefined;
  return reading ? <WidgetFrameLoadingBody testID={`${props.testID}.loading`} accessibilityLabel={t('common.loading')} />
    : <ServiceCheckWidgetState text={t(`${m}.widgetCheckMissing`)} testID={`${props.testID}.missing`} />;
}

function ServiceCheckWidgetState(props: Readonly<{ text: string; testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <Text testID={props.testID} style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary }}>
      {props.text}
    </Text>
  );
}

/**
 * One Check as a glance (lab "Checkout · key flow · Production"): its latest figure, a Key flow's rule or a check's
 * 30-day uptime under it, and its last checks as bars. The figure and the state speak in colour only while the Check
 * is failing; healthy says nothing at the frame's end.
 */
export function ServiceCheckWidgetView(props: Readonly<{ row: ManagedConfiguredCheckRow; environmentName: string | null; testID: string }>) {
  const { theme } = useUnistyles();
  const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const facts = React.useMemo(() => serviceCheckListFacts(props.row), [props.row]);
  const loading = props.row.definitionFacts.kind === 'loading';
  const identity = React.useMemo(() => loading ? NO_MARK_TITLE : { title: facts.title, mark: 'pulse' as const }, [facts.title, loading]);
  useWidgetFrameBodyIdentity(identity);
  useWidgetFrameBodyCaption([facts.kind, props.environmentName].filter(Boolean).join(' · ') || null);
  const tone = props.row.native.enabled ? serviceCheckStatusTone(facts.status) : null;
  const stateWord = !props.row.native.enabled ? t('projects.deployments.services.paused')
    : tone !== null || facts.status === 'unknown' || facts.status === 'notChecked' ? serviceCheckStatusWord(facts.status) : null;
  const meta = React.useMemo(() => stateWord === null ? null : tone
    ? <CorePluginUiPresentationScope><Status tone={tone} label={stateWord} presentation="inline" /></CorePluginUiPresentationScope>
    : <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary }} numberOfLines={1}>{stateWord}</Text>,
  [stateWord, theme.colors.text.secondary, tone]);
  useWidgetFrameBodyMeta(meta);
  const uptime = serviceCheckUptimeText(facts.uptimePercent);
  const caption = facts.ruleText ?? (tone !== null && facts.causeText ? facts.causeText : uptime ? t(`${m}.uptimeOverDays`, { percent: uptime }) : null);
  const cells = React.useMemo((): readonly ServiceCheckBarCell[] => facts.recent.bars.map((bar) => ({ key: bar.key, tone: bar.tone, label: '' })),
    [facts.recent.bars]);
  return (
    <View testID={props.testID} style={{ flexGrow: 1, justifyContent: 'space-between', gap: HAPPIER_DATA_METRICS.blockGapPx }}>
      <CorePluginUiPresentationScope>
        <HappierDataMetric theme={pluginTheme} size="stat" label={facts.title} testID={`${props.testID}.value`}
          value={facts.valueText ?? '—'} {...(caption ? { caption } : {})} {...(tone && facts.valueText ? { tone } : {})} />
      </CorePluginUiPresentationScope>
      <ServiceCheckBars testID={`${props.testID}.bars`} cells={facts.status === 'loading' ? 'loading' : cells} slots={SERVICE_CHECK_ROW_BARS}
        size="inline" label={t(`${m}.columnRecent`, { count: SERVICE_CHECK_ROW_BARS })} partialLead={facts.recent.partialLead} />
    </View>
  );
}
