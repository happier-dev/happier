import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  UsageRecapComposeResultSchema,
  UsageRecapExportResultSchema,
  USAGE_RECAP_FIELDS,
  type UsageRecapField,
} from '@happier-dev/protocol';
import {
  UsageQuerySchema,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { CustomModalInjectedProps } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  getUsagePeriodDefinition,
  resolveUsagePeriodStartTimeSeconds,
  type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import {
  captureUsageViewPng,
  deliverUsageImageFile,
} from '../../usageAnalyticsExport';
import { UsageStatCard } from './UsageStatCard';
import {
  buildUsageStatCardModel,
  type UsageRecapComposed,
  type UsageRecapFormat,
  type UsageRecapStyle,
} from './usageStatCardModel';
import {
  USAGE_STAT_CARD_SIZES,
  USAGE_STAT_CARD_STYLES,
} from './usageStatCardStyles';

const PERIODS: readonly UsagePeriod[] = ['30days', '90days', 'year', 'all'];
const FORMATS: readonly UsageRecapFormat[] = [
  'square',
  'story',
  'link-preview',
];
/** Names and dollars are private and off by default; everything else starts on. */
const PRIVATE_FIELDS: readonly UsageRecapField[] = ['names', 'dollars'];
const DEFAULT_FIELDS: readonly UsageRecapField[] = [
  'tokens',
  'activeDays',
  'streak',
  'agentMix',
  'parallel',
  'work',
  'cache',
];

export type UsageRecapComposerProps = Readonly<{
  /** The widget's shown query: its scope and calendar; the composer chooses only the period. */
  query: UsageQuery;
  serverId: string;
  initialPeriod?: UsagePeriod;
}>;

type ComposeState =
  | Readonly<{ kind: 'composing' }>
  | Readonly<{ kind: 'ready'; result: UsageRecapComposed; query: UsageQuery }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'failed'; code: string }>;

/**
 * One sheet behind every Share (lab s2card C/Cp): a live preview at true proportions, seven styles
 * as real-card tiles, format, period and per-field switches. The facts come from `usage.recap.compose`
 * (the same Action agents use); the image is captured on this device and only leaves through Copy,
 * Save or Share that the person presses.
 */
export function UsageRecapComposer(
  props: UsageRecapComposerProps & CustomModalInjectedProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const tone = theme.dark ? 'dark' : 'light';
  const [style, setStyle] = React.useState<UsageRecapStyle>('daybreak');
  const [format, setFormat] = React.useState<UsageRecapFormat>(
    phone ? 'story' : 'square',
  );
  const [period, setPeriod] = React.useState<UsagePeriod>(
    props.initialPeriod && PERIODS.includes(props.initialPeriod)
      ? props.initialPeriod
      : '90days',
  );
  const [fields, setFields] =
    React.useState<readonly UsageRecapField[]>(DEFAULT_FIELDS);
  const [state, setState] = React.useState<ComposeState>({ kind: 'composing' });
  const [delivery, setDelivery] = React.useState<
    'copy' | 'save' | 'share' | null
  >(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const cardRef = React.useRef<React.ElementRef<typeof View>>(null);
  const deliveryController = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => deliveryController.current?.abort(), [style, format, fields, period, props.query, props.serverId]);

  // Facts are composed for the period and fields; style and format only change how they are drawn.
  React.useEffect(() => {
    const controller = new AbortController();
    const lifetime = captureActiveServerAccountScopeLifetime();
    setState({ kind: 'composing' });
    void (async () => {
      if (
        !lifetime?.isCurrent() ||
        lifetime.scope.serverId !== props.serverId
      ) {
        setState({ kind: 'failed', code: 'usage_scope_unavailable' });
        return;
      }
      const nowMs = Date.now();
      const offset = props.query.timeZoneOffsetMinutes ?? 0;
      const query = UsageQuerySchema.parse({
        ...props.query,
        granularity: getUsagePeriodDefinition(period).granularity,
        period: {
          startMs:
            resolveUsagePeriodStartTimeSeconds(period, nowMs, offset) * 1000,
          endMs: nowMs,
        },
      });
      const { createDefaultActionExecutor } =
        await import('@/sync/ops/actions/defaultActionExecutor');
      if (controller.signal.aborted) return;
      const executed = await createDefaultActionExecutor().execute(
        'usage.recap.compose',
        {
          query,
          style: 'daybreak',
          format: 'square',
          selectedFields: [...fields],
        },
        {
          surface: 'ui',
          actionCaller: { kind: 'host' },
          serverId: lifetime.scope.serverId,
          expectedAccountId: lifetime.scope.accountId,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || !lifetime.isCurrent()) return;
      if (!executed.ok) {
        setState({ kind: 'failed', code: executed.errorCode });
        return;
      }
      const parsed = UsageRecapComposeResultSchema.safeParse(executed.result);
      if (!parsed.success) {
        setState({ kind: 'failed', code: 'usage_recap_result_invalid' });
        return;
      }
      setState(
        parsed.data.kind === 'composed'
          ? { kind: 'ready', result: parsed.data, query }
          : { kind: 'unavailable' },
      );
    })();
    return () => controller.abort();
  }, [period, fields, props.query, props.serverId]);

  const composed =
    state.kind === 'ready' ? { ...state.result, style, format } : null;
  const model = React.useMemo(
    () => (composed ? buildUsageStatCardModel(composed) : null),
    [state, style, format],
  );
  const size = USAGE_STAT_CARD_SIZES[format];
  const previewWidth = phone ? 300 : 460;
  const scale = Math.min(
    previewWidth / size.width,
    (phone ? 420 : 460) / size.height,
  );

  const deliver = React.useCallback(
    async (intent: 'copy' | 'save' | 'share') => {
      if (!composed || state.kind !== 'ready' || !cardRef.current) return;
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) return;
      const controller = new AbortController();
      deliveryController.current?.abort();
      deliveryController.current = controller;
      const retired = lifetime.onRetire(() => controller.abort());
      setDelivery(intent);
      setNotice(null);
      try {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        controller.signal.throwIfAborted();
        const executed = await createDefaultActionExecutor({ usageRecapRender: async (result, context) => {
          // Capture the existing preview only when its exact selected/as-of model is still current.
          if (JSON.stringify(result) !== JSON.stringify(composed) || !cardRef.current) {
            return (await import('./renderUsageRecapImage')).renderUsageRecapImage(result, context);
          }
          return { kind: 'rendered', base64: await captureUsageViewPng(cardRef.current,
            { signal: context.signal, isCurrent: lifetime.isCurrent }) };
        } }).execute('usage.recap.export', { query: state.query, style, format, selectedFields: [...fields] }, {
          surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
          expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!lifetime.isCurrent() || !executed.ok) throw new Error('usage_recap_export_unavailable');
        const result = UsageRecapExportResultSchema.parse(executed.result);
        if (result.kind !== 'exported' || result.compose.kind !== 'composed') throw new Error('usage_recap_export_unavailable');
        setState({ kind: 'ready', result: result.compose, query: state.query });
        const delivered = await deliverUsageImageFile(result.file, intent,
          { signal: controller.signal, isCurrent: lifetime.isCurrent });
        if (controller.signal.aborted || !lifetime.isCurrent()) return;
        setNotice(
          delivered
            ? intent === 'copy'
              ? t('usage.board.recap.copied')
              : null
            : t('usage.board.recap.exportFailed'),
        );
      } catch {
        if (!controller.signal.aborted && lifetime.isCurrent()) setNotice(t('usage.board.recap.exportFailed'));
      } finally {
        retired.dispose();
        if (deliveryController.current === controller) {
          deliveryController.current = null;
          setDelivery(null);
        }
      }
    },
    [composed, state, props.serverId, style, format, fields],
  );

  const toggle = React.useCallback((field: UsageRecapField, on: boolean) => {
    setFields((current) =>
      on
        ? USAGE_RECAP_FIELDS.filter(
            (candidate) => candidate === field || current.includes(candidate),
          )
        : current.filter((candidate) => candidate !== field),
    );
  }, []);

  const styleOptions = React.useMemo(
    () =>
      USAGE_STAT_CARD_STYLES.map((id) => ({
        id,
        title: t(`usage.board.recap.style_${id}`),
        testID: `usage-recap-style-${id}`,
        preview: model ? (
          <StylePreview
            model={{ ...model, style: id, format: 'square' }}
            tone={tone}
          />
        ) : undefined,
      })),
    [model, tone],
  );

  const preview = (
    <View
      style={[styles.stage, { minHeight: size.height * scale + 48 }]}
      testID="usage-recap-composer.stage"
    >
      {state.kind === 'composing' && !model ? (
        <ItemLoadStateRows
          state={{ kind: 'loading' }}
          rows={4}
          lines={2}
          accessibilityLabel={t('usage.board.recap.composing')}
        />
      ) : state.kind === 'unavailable' ? (
        <SurfaceStateCard
          kind="empty"
          layout="inline"
          title={t('usage.board.recap.noRecapTitle')}
          reason={t('usage.board.recap.composeUnavailable')}
        />
      ) : state.kind === 'failed' ? (
        <SurfaceStateCard
          kind="error"
          layout="inline"
          title={t('usage.board.recap.composeFailed')}
          diagnosticCode={state.code}
          action={{
            label: t('common.retry'),
            onPress: () => setFields((current) => [...current]),
          }}
        />
      ) : model ? (
        <View
          style={{
            width: size.width * scale,
            height: size.height * scale,
            opacity: state.kind === 'composing' ? 0.55 : 1,
          }}
        >
          <View
            style={{
              width: size.width,
              height: size.height,
              transform: [{ scale }],
              transformOrigin: 'top left',
            }}
          >
            <UsageStatCard
              ref={cardRef}
              model={model}
              tone={tone}
              testID="usage-recap-composer.card"
              style={styles.card}
            />
          </View>
        </View>
      ) : null}
      <SegmentedTabBar
        testIDPrefix="usage-recap-format"
        compact
        segmentSizing="content"
        activeTabId={format}
        onSelectTab={setFormat}
        tabs={FORMATS.map((id) => ({
          id,
          label: t(
            `usage.board.recap.format_${id === 'link-preview' ? 'linkPreview' : id}`,
          ),
        }))}
      />
    </View>
  );

  const controls = (
    <View style={styles.controls}>
      <ItemGroup title={t('usage.board.recap.styleLabel')}>
        <SelectionTiles
          variant="visual"
          density="compact"
          value={style}
          onChange={(next) => next && setStyle(next)}
          options={styleOptions}
          testIdPrefix="usage-recap-style"
          accessibilityLabel={t('usage.board.recap.styleLabel')}
        />
      </ItemGroup>
      <ItemGroup title={t('usage.board.recap.periodLabel')}>
        <SegmentedTabBar
          testIDPrefix="usage-recap-period"
          compact
          segmentSizing="content"
          activeTabId={period}
          onSelectTab={setPeriod}
          tabs={PERIODS.map((id) => ({
            id,
            label: t(getUsagePeriodDefinition(id).shortTranslationKey),
          }))}
        />
      </ItemGroup>
      <ItemGroup title={t('usage.board.recap.fieldsLabel')}>
        {USAGE_RECAP_FIELDS.map((field) => {
          const on = fields.includes(field);
          const missing = composed?.unavailableFields.includes(field) === true;
          return (
            <Item
              key={field}
              testID={`usage-recap-field-${field}`}
              title={t(`usage.board.recap.field_${field}`)}
              subtitle={
                PRIVATE_FIELDS.includes(field)
                  ? t('usage.board.recap.fieldPrivateHint')
                  : missing
                    ? t('usage.board.recap.fieldUnavailable')
                    : undefined
              }
              rightElement={
                <Switch
                  value={on}
                  onValueChange={(next) => toggle(field, next)}
                  accessibilityLabel={t(`usage.board.recap.field_${field}`)}
                  testID={`usage-recap-field-${field}.switch`}
                />
              }
              showChevron={false}
              rightElementOutsidePressable
            />
          );
        })}
      </ItemGroup>
    </View>
  );

  return (
    <View
      style={[styles.root, phone ? styles.rootPhone : null]}
      testID="usage-recap-composer"
    >
      <View style={[styles.body, phone ? styles.bodyPhone : null]}>
        {preview}
        <ScrollView
          style={phone ? undefined : styles.controlsScroll}
          contentContainerStyle={styles.controlsContent}
        >
          {controls}
        </ScrollView>
      </View>
      <View style={styles.footer}>
        <Text style={styles.note} numberOfLines={2}>
          {notice ?? t('usage.board.recap.madeLocally')}
        </Text>
        <View style={styles.actions}>
          <RoundButton
            size="small"
            display="secondary"
            title={t('usage.board.recap.copy')}
            disabled={!model || delivery !== null}
            loading={delivery === 'copy'}
            onPress={() => {
              void deliver('copy');
            }}
            testID="usage-recap-composer.copy"
          />
          <RoundButton
            size="small"
            display="secondary"
            title={t('usage.board.recap.save')}
            disabled={!model || delivery !== null}
            loading={delivery === 'save'}
            onPress={() => {
              void deliver('save');
            }}
            testID="usage-recap-composer.save"
          />
          <RoundButton
            size="small"
            title={t('usage.board.recap.share')}
            disabled={!model || delivery !== null}
            loading={delivery === 'share'}
            onPress={() => {
              void deliver('share');
            }}
            testID="usage-recap-composer.share"
          />
        </View>
      </View>
    </View>
  );
}

/** A style tile draws the real card at static props, scaled (visual picker rule). */
const StylePreview = React.memo(function StylePreview(
  props: Readonly<{
    model: Parameters<typeof UsageStatCard>[0]['model'];
    tone: 'light' | 'dark';
  }>,
) {
  const size = USAGE_STAT_CARD_SIZES.square;
  const scale = 96 / size.width;
  return (
    <View
      pointerEvents="none"
      style={{
        width: size.width * scale,
        height: size.height * scale,
        overflow: 'hidden',
        borderRadius: 8,
      }}
    >
      <View
        style={{
          width: size.width,
          height: size.height,
          transform: [{ scale }],
          transformOrigin: 'top left',
        }}
      >
        <UsageStatCard model={props.model} tone={props.tone} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: 0,
    minWidth: 0,
  },
  rootPhone: {
    flex: 1,
  },
  body: {
    flexDirection: 'row',
    gap: 24,
    minHeight: 0,
  },
  bodyPhone: {
    flexDirection: 'column',
    gap: 16,
  },
  stage: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 20,
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: theme.colors.surface.inset,
  },
  card: {
    borderRadius: 18,
  },
  controlsScroll: {
    flex: 1,
    maxHeight: 560,
  },
  controlsContent: {
    paddingBottom: 8,
  },
  controls: {
    gap: 4,
    minWidth: 280,
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 16,
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  note: {
    ...Typography.default(),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
}));
