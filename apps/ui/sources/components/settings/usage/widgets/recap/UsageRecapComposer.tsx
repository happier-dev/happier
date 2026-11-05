import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { UsageRecapComposeResultSchema, UsageRecapDeliveryResultSchema, USAGE_RECAP_FIELDS,
  resolveUsageRecapQuery, type UsageRecapSourceSelection } from '@happier-dev/protocol/usage/usageRecap';
import { type UsageRecapField } from '@happier-dev/protocol';
import {
  UsageQuerySchema,
  getUsageQueryKey,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { CustomModalInjectedProps } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  getUsagePeriodDefinition,
  resolveUsagePeriodStartTimeSeconds,
  type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { useDeviceType } from '@/utils/platform/responsive';
import { RECAP_STAGE_INSET_PX, RecapComposerFrame } from './RecapComposerFrame';
import { UsageRecapPublicOutput, type UsageRecapPublicOutputKind } from './UsageRecapPublicOutput';
import { t } from '@/text';
import {
  captureUsageViewPng,
} from '../../usageImageFile';
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
  /** The widget's shown scope/calendar; the composer owns period and execution-source choice. */
  query: UsageQuery;
  serverId: string;
  initialPeriod?: UsagePeriod;
}>;

type ComposeState =
  /** `shown` keeps the last composed card on screen (dimmed, not exportable) until the new one arrives. */
  | Readonly<{ kind: 'composing'; shown?: UsageRecapComposed }>
  | Readonly<{ kind: 'ready'; result: UsageRecapComposed; query: UsageQuery }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'failed'; code: string }>;

/**
 * One sheet behind every Share (lab s2card C/Cp, C1). Where the service offers public profiles it
 * leads with what to share: the private Image, or the published page's Profile link, Badge or Card
 * (`UsageRecapPublicOutput`). Only the chosen output is mounted.
 */
export function UsageRecapComposer(
  props: UsageRecapComposerProps & CustomModalInjectedProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  // Profile link, Badge and Card exist only where this service offers public profiles.
  const publicProfiles = useFeatureDecision('account.publicProfiles', { scopeKind: 'runtime' })?.state === 'enabled';
  const [output, setOutput] = React.useState<RecapOutput>('image');
  // The image choices live here so they survive a visit to another output.
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
  const [sourceSelection, setSourceSelection] = React.useState<UsageRecapSourceSelection>('whole_usage');
  const shown = publicProfiles ? output : 'image';
  return (
    <View style={styles.root} testID="usage-recap-composer">
      {publicProfiles ? (
        <View style={styles.outputs}>
          <SegmentedTabBar
            testIDPrefix="usage-recap-output"
            compact
            segmentSizing="content"
            iconPlacement="leading"
            activeTabId={output}
            onSelectTab={setOutput}
            accessibilityLabel={t('publicIdentity.share.outputLabel')}
            tabs={OUTPUTS.map(({ id, icon }) => ({
              id,
              label: t(`publicIdentity.share.output_${id}`),
              icon: <Icon name={icon} size={14} color={theme.colors.text.secondary} />,
            }))}
          />
        </View>
      ) : null}
      {/* Only the chosen output is mounted: the others read nothing and draw nothing. */}
      {shown === 'image' ? (
        <UsageRecapImageOutput
          query={props.query}
          serverId={props.serverId}
          selection={{ style, format, period, fields, sourceSelection }}
          setStyle={setStyle}
          setFormat={setFormat}
          setPeriod={setPeriod}
          setFields={setFields}
          setSourceSelection={setSourceSelection}
        />
      ) : (
        <UsageRecapPublicOutput kind={shown} serverId={props.serverId} onClose={props.onClose} />
      )}
    </View>
  );
}

type RecapOutput = 'image' | UsageRecapPublicOutputKind;
const OUTPUTS = [
  { id: 'image', icon: 'image' },
  { id: 'profile_link', icon: 'link' },
  { id: 'badge', icon: 'code' },
  { id: 'card', icon: 'credit-card' },
] as const satisfies ReadonlyArray<Readonly<{ id: RecapOutput; icon: string }>>;

/**
 * The private image: a live preview at true proportions, seven styles as real-card tiles, format,
 * period and per-field switches. The facts come from `usage.recap.compose` (the same Action agents
 * use); the image is captured on this device and only leaves through Copy, Save or Share that the
 * person presses.
 */
function UsageRecapImageOutput(
  props: Readonly<{
    query: UsageQuery;
    serverId: string;
    selection: Readonly<{ style: UsageRecapStyle; format: UsageRecapFormat; period: UsagePeriod; fields: readonly UsageRecapField[];
      sourceSelection: UsageRecapSourceSelection }>;
    setStyle: (style: UsageRecapStyle) => void;
    setFormat: (format: UsageRecapFormat) => void;
    setPeriod: (period: UsagePeriod) => void;
    setFields: React.Dispatch<React.SetStateAction<readonly UsageRecapField[]>>;
    setSourceSelection: (source: UsageRecapSourceSelection) => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const reducedMotion = useReducedMotionPreference();
  const tone = theme.dark ? 'dark' : 'light';
  const { style, format, period, fields, sourceSelection } = props.selection;
  const { setStyle, setFormat, setPeriod, setFields } = props;
  const [state, setState] = React.useState<ComposeState>({ kind: 'composing' });
  const [composeAttempt, retryCompose] = React.useReducer((attempt: number) => attempt + 1, 0);
  const [delivery, setDelivery] = React.useState<
    'copy' | 'save' | 'share' | null
  >(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const cardRef = React.useRef<React.ElementRef<typeof View>>(null);
  const deliveryController = React.useRef<AbortController | null>(null);
  // The composer owns its period and source. Equivalent parent scopes and field selections
  // must retain the admitted read rather than cancel it during live page updates.
  const queryKey = getUsageQueryKey(resolveUsageRecapQuery({ query: { ...props.query, period: {},
    granularity: getUsagePeriodDefinition(period).granularity }, sourceSelection }));
  const compositionQuery = React.useMemo(() => UsageQuerySchema.parse(JSON.parse(queryKey)), [queryKey]);
  const fieldsKey = USAGE_RECAP_FIELDS.filter(field => fields.includes(field)).join(',');
  const selectedFields = React.useMemo(() => USAGE_RECAP_FIELDS.filter(field => fields.includes(field)), [fieldsKey]);
  React.useEffect(() => () => deliveryController.current?.abort(), [style, format, selectedFields, period, sourceSelection, compositionQuery, props.serverId]);

  // Every selected presentation is admitted with its period and fields by the same compose Action.
  React.useEffect(() => {
    const controller = new AbortController();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const retirement = lifetime?.onRetire(() => {
      controller.abort();
      setState({ kind: 'failed', code: 'usage_scope_unavailable' });
    });
    // A new style, format, period or field set keeps the last card and its style tiles until it is composed.
    setState(previous => {
      const shown = previous.kind === 'ready' ? previous.result : previous.kind === 'composing' ? previous.shown : undefined;
      return shown ? { kind: 'composing', shown } : { kind: 'composing' };
    });
    void (async () => {
      if (
        !lifetime?.isCurrent() ||
        lifetime.scope.serverId !== props.serverId
      ) {
        setState({ kind: 'failed', code: 'usage_scope_unavailable' });
        return;
      }
      const nowMs = Date.now();
      const offset = compositionQuery.timeZoneOffsetMinutes ?? 0;
      const query = UsageQuerySchema.parse({
        ...compositionQuery,
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
          sourceSelection,
          style,
          format,
          selectedFields: [...selectedFields],
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
    })().catch(() => {
      if (!controller.signal.aborted && lifetime?.isCurrent()) {
        setState({ kind: 'failed', code: 'usage_recap_compose_failed' });
      }
    });
    return () => { retirement?.dispose(); controller.abort(); };
  }, [style, format, period, sourceSelection, selectedFields, compositionQuery, props.serverId, composeAttempt]);

  const composed =
    state.kind === 'ready' ? state.result : null;
  const shown = composed ?? (state.kind === 'composing' ? state.shown ?? null : null);
  const model = React.useMemo(
    () => (shown ? buildUsageStatCardModel(shown) : null),
    [shown],
  );
  // The stage holds the card it shows: the kept card keeps its own proportions until the new one lands.
  const size = USAGE_STAT_CARD_SIZES[model?.format ?? format];
  // The card takes the stage it is given (lab s2card C: the left two-thirds), at true proportions.
  const [stageWidth, setStageWidth] = React.useState<number | null>(null);
  const previewWidth = phone ? 300 : Math.max(240, (stageWidth ?? 520) - RECAP_STAGE_INSET_PX * 2);
  const scale = Math.min(
    previewWidth / size.width,
    (phone ? 420 : 520) / size.height,
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
        } }).execute('usage.recap.deliver', { query: state.query, sourceSelection, style, format, selectedFields: [...fields], intent }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
          expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!lifetime.isCurrent() || !executed.ok) throw new Error('usage_recap_export_unavailable');
        const result = UsageRecapDeliveryResultSchema.parse(executed.result);
        if (result.compose.kind !== 'composed') throw new Error('usage_recap_export_unavailable');
        setState({ kind: 'ready', result: result.compose, query: state.query });
        if (controller.signal.aborted || !lifetime.isCurrent()) return;
        setNotice(
          result.kind === 'cancelled' ? null : result.kind === 'delivered'
            ? intent === 'copy'
              ? t('usage.board.recap.copied')
              : null
            : result.kind === 'failed' && result.reason === 'outcome_unobservable'
              ? t('usage.board.recap.deliveryUnconfirmed')
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
    [composed, state, props.serverId, sourceSelection, style, format, fields],
  );

  const toggle = React.useCallback((field: UsageRecapField, on: boolean) => {
    setFields((current) =>
      on
        ? USAGE_RECAP_FIELDS.filter(
            (candidate) => candidate === field || current.includes(candidate),
          )
        : current.filter((candidate) => candidate !== field),
    );
  }, [setFields]);

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

  const formats = (
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
  );
  const preview = (
    <>
      {formats}
      <View style={[styles.stageCard, { minHeight: size.height * scale }]}>
      {state.kind === 'composing' && !model ? (
        // The card's own place at its true proportions: the stage keeps its size while it is composed.
        <View accessible accessibilityLabel={t('usage.board.recap.composing')} accessibilityRole="progressbar">
          <HappierSkeletonBlock
            color={theme.colors.surface.skeleton}
            width={size.width * scale}
            height={size.height * scale}
            radius={18 * scale}
            reducedMotion={reducedMotion}
          />
        </View>
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
            onPress: retryCompose,
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
      </View>
    </>
  );

  const controls = (
    <>
      {/* The style tiles and the period control are their own surfaces: no sheet around them, which
          clipped the last tile row's caption and pressed the tiles against its edge. */}
      <ItemGroup title={t('usage.board.recap.styleLabel')} surface="none">
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
      <ItemGroup title={t('usage.board.recap.periodLabel')} surface="none">
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
    </>
  );

  const actions = (
    <>
        <RoundButton
          size="small"
          display="secondary"
          title={t('usage.board.recap.copy')}
          disabled={!composed || delivery !== null}
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
          disabled={!composed || delivery !== null}
          loading={delivery === 'save'}
          onPress={() => {
            void deliver('save');
          }}
          testID="usage-recap-composer.save"
        />
        <View style={styles.actionsGrow} />
        <RoundButton
          size="small"
          title={t('usage.board.recap.share')}
          disabled={!composed || delivery !== null}
          loading={delivery === 'share'}
          onPress={() => {
            void deliver('share');
          }}
          testID="usage-recap-composer.share"
        />
    </>
  );

  return (
    <RecapComposerFrame
      stage={preview}
      stageTestID="usage-recap-composer.stage"
      onStageWidth={setStageWidth}
      controls={controls}
      note={notice ?? t('usage.board.recap.madeLocally')}
      actions={actions}
    />
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
  // The card is held to the window (scrollHost 'body'): the controls scroll and the actions stay put.
  root: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  // The outputs lead the sheet: what you are sharing comes before how it looks.
  outputs: {
    alignItems: 'flex-start',
    paddingBottom: theme.space.s16,
  },
  // The card hangs under the formats: the stage stretches with the controls column beside it, and a
  // centred card would drift out of view as that column grows.
  stageCard: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: theme.space.s8 },
  card: {
    borderRadius: 18,
  },
  actionsGrow: { flexGrow: 1 },
}));
