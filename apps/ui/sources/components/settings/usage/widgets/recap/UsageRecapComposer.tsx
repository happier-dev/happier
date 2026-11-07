import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { UsageRecapComposeResultSchema, UsageRecapDeliveryResultSchema, USAGE_RECAP_FIELDS, USAGE_RECAP_PUBLIC_FIELDS,
  resolveUsageRecapQuery, type UsageRecapSourceSelection } from '@happier-dev/protocol/usage/usageRecap';
import { type UsageRecapField } from '@happier-dev/protocol/usage/usageRecap';
import {
  UsageQuerySchema,
  getUsageQueryKey,
  resolveUsageQueryPeriod,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import { Modal, type CustomModalConfig, type CustomModalInjectedProps } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands, type CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import {
  getUsagePeriodDefinition,
  type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { useDeviceType } from '@/utils/platform/responsive';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
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
  /** Where the sheet opens: a just-published page lands on its badge. Ignored where public profiles are off. */
  initialOutput?: UsageRecapPublicOutputKind;
  invocation?: CurrentUiContextCommandInvocation;
}>;

/** The one way to open Share: the recap widget's button and the published profile's Badge both arrive here. */
export function openUsageRecapComposer(props: UsageRecapComposerProps,
  Bridge: NonNullable<CustomModalConfig['commandBridge']>): void {
  Modal.show({
    component: UsageRecapComposer,
    commandBridge: Bridge,
    props,
    chrome: {
      kind: 'card',
      material: 'solid',
      title: t('usage.board.recap.shareTitle'),
      phonePresentation: 'fullscreen',
      // Held to the window, so Copy, Save and Share stay in view while the controls scroll.
      scrollHost: 'body',
      // The stage needs the room of the lab sheet (s2card C): card left, controls right.
      dimensions: { size: 'lg', width: 1120 },
      testID: 'usage-recap-composer.modal',
    },
  });
}

type ComposeState =
  /** `shown` keeps the last composed card on screen (dimmed, not exportable) until the new one arrives. */
  | Readonly<{ kind: 'composing'; shown?: UsageRecapComposed }>
  /** `query` is the private read the card was composed from; a public-profile card has none. */
  | Readonly<{ kind: 'ready'; result: UsageRecapComposed; query: UsageQuery | null }>
  | Readonly<{ kind: 'unavailable'; reason?: string }>
  | Readonly<{ kind: 'failed'; code: string }>;

/** Only typed issue paths/codes enter the existing collapsed diagnostic slot. */
function queryFailureDiagnostic(failure: Readonly<{ errorCode: string; details?: unknown }>): string {
  const details = failure.details;
  if (failure.errorCode !== 'usage_query_result_invalid' || !details || typeof details !== 'object'
    || !('issues' in details) || !Array.isArray(details.issues)) return failure.errorCode;
  const lines: string[] = [];
  for (const issue of details.issues) {
    if (!issue || typeof issue !== 'object' || !('code' in issue) || typeof issue.code !== 'string'
      || !('path' in issue) || !Array.isArray(issue.path)) continue;
    const path: readonly unknown[] = issue.path;
    if (path.every(part => typeof part === 'string' || typeof part === 'number')) lines.push(`${issue.code}: ${path.join('.')}`);
  }
  return [failure.errorCode, ...lines].join('\n');
}

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
  const [output, setOutput] = React.useState<RecapOutput>(props.initialOutput ?? 'image');
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
  // Where the Image's facts come from: private Usage, or the current published public profile (only where
  // public profiles exist). The choice is explicit and shown; there is no fallback from one to the other.
  const [imageSource, setImageSource] = React.useState<RecapImageSource>('usage');
  const router = useRouter();
  const { onClose } = props;
  const openProfile = React.useCallback(() => { onClose(); router.push(SETTINGS_ROUTES.accountPublicProfile); }, [onClose, router]);
  // A selection keeps its bound invocation; the mounted output supplies its own read lifetime.
  const invocation = React.useRef(props.invocation);
  const shown = publicProfiles ? output : 'image';
  const commands = useCurrentUiContextLocalCommands([
    ...(publicProfiles ? OUTPUTS.map(({ id }) => ({ key: `output:${id}`,
      title: `${t('publicIdentity.share.outputLabel')}: ${t(`publicIdentity.share.output_${id}`)}`,
      invoke: (_input: unknown, _context: unknown, origin: CurrentUiContextCommandInvocation) => { invocation.current = origin; setOutput(id); } })) : []),
  ], { foregroundOverlay: true });
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
            onSelectTab={id => { void commands.invoke(`output:${id}`); }}
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
          invocation={invocation}
          selection={{ style, format, period, fields, sourceSelection, imageSource: publicProfiles ? imageSource : 'usage' }}
          {...(publicProfiles ? { setImageSource, openProfile } : {})}
          setStyle={setStyle}
          setFormat={setFormat}
          setPeriod={setPeriod}
          setFields={setFields}
          setSourceSelection={setSourceSelection}
        />
      ) : (
        <UsageRecapPublicOutput kind={shown} serverId={props.serverId} onClose={props.onClose} invocation={invocation} />
      )}
    </View>
  );
}

type RecapOutput = 'image' | UsageRecapPublicOutputKind;
type RecapImageSource = 'usage' | 'public_profile';
const RECAP_IMAGE_SOURCES = ['usage', 'public_profile'] as const satisfies readonly RecapImageSource[];
const isPublicRecapField = (field: UsageRecapField): field is (typeof USAGE_RECAP_PUBLIC_FIELDS)[number] =>
  (USAGE_RECAP_PUBLIC_FIELDS as readonly UsageRecapField[]).includes(field);
const USAGE_RECAP_SOURCE_SELECTIONS = ['whole_usage', 'happier_only'] as const satisfies readonly UsageRecapSourceSelection[];
const OUTPUTS = [
  { id: 'image', icon: 'image' },
  { id: 'profile_link', icon: 'link' },
  { id: 'badge', icon: 'code' },
  { id: 'card', icon: 'credit-card' },
] as const satisfies ReadonlyArray<Readonly<{ id: RecapOutput; icon: string }>>;

/**
 * The private image: a live preview at true proportions, seven styles as real-card tiles, format,
 * period and per-field switches. The facts come from `usage.recap.private.compose` (the same Action agents
 * use); the image is captured on this device and only leaves through Copy, Save or Share that the
 * person presses.
 */
function UsageRecapImageOutput(
  props: Readonly<{
    query: UsageQuery;
    serverId: string;
    invocation: React.MutableRefObject<CurrentUiContextCommandInvocation | undefined>;
    selection: Readonly<{ style: UsageRecapStyle; format: UsageRecapFormat; period: UsagePeriod; fields: readonly UsageRecapField[];
      sourceSelection: UsageRecapSourceSelection; imageSource: RecapImageSource }>;
    /** Present only where public profiles exist: the Image may then come from the current public profile. */
    setImageSource?: (source: RecapImageSource) => void;
    openProfile?: () => void;
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
  const { style, format, period, fields, sourceSelection, imageSource } = props.selection;
  const fromProfile = imageSource === 'public_profile';
  const { setStyle, setFormat, setPeriod, setFields, setSourceSelection } = props;
  const [state, setState] = React.useState<ComposeState>({ kind: 'composing' });
  const [composeAttempt, retryCompose] = React.useReducer((attempt: number) => attempt + 1, 0);
  const [delivery, setDelivery] = React.useState<
    'copy' | 'save' | 'share' | null
  >(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const cardRef = React.useRef<React.ElementRef<typeof View>>(null);
  const execution = useMountedActionExecution(props.serverId);
  const CommandBridge = useCurrentUiContextCommandBridge();
  const { isCurrent: executionIsCurrent } = execution;
  // The compose effect keys on the selection, never on the hook's per-render callbacks.
  const executionRef = React.useRef(execution);
  executionRef.current = execution;
  const deliveryController = React.useRef<AbortController | null>(null);
  // The composer owns its period and source. Equivalent parent scopes and field selections
  // must retain the admitted read rather than cancel it during live page updates.
  const queryKey = getUsageQueryKey(resolveUsageRecapQuery({ query: { ...props.query, period: {},
    granularity: getUsagePeriodDefinition(period).granularity }, sourceSelection }));
  const compositionQuery = React.useMemo(() => UsageQuerySchema.parse(JSON.parse(queryKey)), [queryKey]);
  const fieldsKey = USAGE_RECAP_FIELDS.filter(field => fields.includes(field)).join(',');
  const selectedFields = React.useMemo(() => USAGE_RECAP_FIELDS.filter(field => fields.includes(field)), [fieldsKey]);
  React.useEffect(() => () => deliveryController.current?.abort(), [style, format, selectedFields, period, sourceSelection, imageSource, compositionQuery, props.serverId]);

  // Every selected presentation is admitted with its period and fields by the same compose Action.
  React.useEffect(() => {
    const controller = new AbortController();
    const { execute, isCurrent, binding, resolution } = executionRef.current;
    const origin = props.invocation.current;
    const retirement = binding?.onRetire(() => {
      controller.abort();
      setState({ kind: 'failed', code: 'usage_scope_unavailable' });
    });
    // A new style, format, period or field set keeps the last card and its style tiles until it is composed.
    setState(previous => {
      const shown = previous.kind === 'ready' ? previous.result : previous.kind === 'composing' ? previous.shown : undefined;
      return shown ? { kind: 'composing', shown } : { kind: 'composing' };
    });
    // The Account binding resolves asynchronously; composing waits for it rather than failing early.
    if (!binding && resolution.kind === 'resolving') return () => controller.abort();
    void (async () => {
      if (!isCurrent()) {
        setState({ kind: 'failed', code: 'usage_scope_unavailable' });
        return;
      }
      const operation = { signal: controller.signal };
      if (fromProfile) {
        // The captured Account's current public profile: the public Action reads no private Usage.
        const input = { source: { kind: 'public_profile' as const }, style, format, selectedFields: selectedFields.filter(isPublicRecapField) };
        const executed = origin
          ? await origin.execute(executionRef.current, 'usage.recap.compose', input, operation)
          : await execute('usage.recap.compose', input, operation);
        if (controller.signal.aborted || !isCurrent()) return;
        if (!executed.ok) { setState({ kind: 'failed', code: queryFailureDiagnostic(executed) }); return; }
        const parsed = UsageRecapComposeResultSchema.safeParse(executed.result);
        if (!parsed.success) { setState({ kind: 'failed', code: 'usage_recap_result_invalid' }); return; }
        setState(parsed.data.kind === 'composed' ? { kind: 'ready', result: parsed.data, query: null }
          : { kind: 'unavailable', reason: parsed.data.reason });
        return;
      }
      const nowMs = Date.now();
      const offset = compositionQuery.timeZoneOffsetMinutes ?? 0;
      const query = UsageQuerySchema.parse({
        ...compositionQuery,
        granularity: getUsagePeriodDefinition(period).granularity,
        period: resolveUsageQueryPeriod({ period: { relative: period }, timeZoneOffsetMinutes: offset }, nowMs),
      });
      const input = {
          query,
          sourceSelection,
          style,
          format,
          selectedFields: [...selectedFields],
        };
      const executed = origin
        ? await origin.execute(executionRef.current, 'usage.recap.private.compose', input, operation)
        : await execute('usage.recap.private.compose', input, operation);
      if (controller.signal.aborted || !isCurrent()) return;
      if (!executed.ok) {
        setState({ kind: 'failed', code: queryFailureDiagnostic(executed) });
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
      if (!controller.signal.aborted && isCurrent()) {
        setState({ kind: 'failed', code: 'usage_recap_compose_failed' });
      }
    });
    return () => { retirement?.dispose(); controller.abort(); };
  }, [style, format, period, sourceSelection, imageSource, selectedFields, compositionQuery, execution.binding, composeAttempt]);

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
    async (intent: 'copy' | 'save' | 'share', invocation: CurrentUiContextCommandInvocation, commandSignal?: AbortSignal) => {
      if (!composed || state.kind !== 'ready' || !cardRef.current) return;
      if (!executionIsCurrent()) return;
      const controller = new AbortController();
      deliveryController.current?.abort();
      deliveryController.current = controller;
      const cancellation = mergeAbortSignals([controller.signal, commandSignal]);
      setDelivery(intent);
      setNotice(null);
      try {
        // The render port captures this mounted preview, so it travels with the invocation.
        const render = {
          signal: cancellation.signal, executorOptions: { usageRecapRender: async (result, context) => {
            // Capture the existing preview only when its exact selected/as-of model is still current.
            if (JSON.stringify(result) !== JSON.stringify(composed) || !cardRef.current) {
              return (await import('./renderUsageRecapImage')).renderUsageRecapImage(result, context, CommandBridge);
            }
            return { kind: 'rendered', base64: await captureUsageViewPng(cardRef.current,
              { signal: context.signal, isCurrent: executionIsCurrent }) };
          } } };
        // The same source that composed the card delivers it: public through the public Action, never a private fallback.
        const executed = state.query === null
          ? await invocation.execute(execution, 'usage.recap.deliver', { source: { kind: 'public_profile' }, style, format,
            selectedFields: fields.filter(isPublicRecapField), intent }, render)
          : await invocation.execute(execution, 'usage.recap.private.deliver',
            { query: state.query, sourceSelection, style, format, selectedFields: [...fields], intent }, render);
        cancellation.signal.throwIfAborted();
        if (!executionIsCurrent() || !executed.ok) throw new Error('usage_recap_export_unavailable');
        const result = UsageRecapDeliveryResultSchema.parse(executed.result);
        if (result.compose.kind !== 'composed') throw new Error('usage_recap_export_unavailable');
        setState({ kind: 'ready', result: result.compose, query: state.query });
        if (cancellation.signal.aborted || !executionIsCurrent()) return;
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
        if (!cancellation.signal.aborted && executionIsCurrent()) setNotice(t('usage.board.recap.exportFailed'));
      } finally {
        cancellation.dispose();
        if (deliveryController.current === controller) {
          deliveryController.current = null;
          setDelivery(null);
        }
      }
    },
    [composed, state, execution, executionIsCurrent, sourceSelection, style, format, fields, CommandBridge],
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

  // A public-profile card offers only the fields a public page can carry; names and dollars never appear.
  const offeredFields = fromProfile ? USAGE_RECAP_FIELDS.filter(isPublicRecapField) : USAGE_RECAP_FIELDS;
  const commands = useCurrentUiContextLocalCommands([
    ...USAGE_STAT_CARD_STYLES.map(id => ({ key: `style:${id}`,
      title: `${t('usage.board.recap.styleLabel')}: ${t(`usage.board.recap.style_${id}`)}`,
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; setStyle(id); } })),
    ...FORMATS.map(id => ({ key: `format:${id}`,
      title: t(`usage.board.recap.format_${id === 'link-preview' ? 'linkPreview' : id}`),
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; setFormat(id); } })),
    ...(props.setImageSource ? RECAP_IMAGE_SOURCES.map(id => ({ key: `imageSource:${id}`,
      title: `${t('publicIdentity.share.imageFrom')}: ${t(`publicIdentity.share.imageFrom_${id}`)}`,
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; props.setImageSource?.(id); } })) : []),
    // Period and execution source shape only a private read; the public profile carries its own.
    ...(fromProfile ? [] : PERIODS.map(id => ({ key: `period:${id}`,
      title: `${t('usage.board.recap.periodLabel')}: ${t(getUsagePeriodDefinition(id).shortTranslationKey)}`,
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; setPeriod(id); } }))),
    ...(fromProfile ? [] : USAGE_RECAP_SOURCE_SELECTIONS.map(id => ({ key: `source:${id}`,
      title: `${t('usage.board.recap.sourceLabel')}: ${t(`usage.board.recap.source_${id}`)}`,
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; setSourceSelection(id); } }))),
    ...offeredFields.map(field => ({ key: `field:${field}`,
      title: `${t('usage.board.recap.fieldsLabel')}: ${t(`usage.board.recap.field_${field}`)}`,
      invoke: (input: PluginUiJsonValueV1 | undefined, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; toggle(field, typeof input === 'boolean' ? input : !fields.includes(field)); } })),
    ...(state.kind === 'failed' ? [{ key: 'retry', title: t('common.retry'),
      invoke: (_input: unknown, _context: unknown, invocation: CurrentUiContextCommandInvocation) => { props.invocation.current = invocation; retryCompose(); } }] : []),
    ...(composed && delivery === null ? (['copy', 'save', 'share'] as const).map(intent => ({ key: `deliver:${intent}`,
      title: t(`usage.board.recap.${intent}`), invoke: (_input: unknown, context: ActionExecutorContext, invocation: CurrentUiContextCommandInvocation) => deliver(intent, invocation, context.signal) })) : []),
  ], { foregroundOverlay: true });

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
      onSelectTab={id => { void commands.invoke(`format:${id}`); }}
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
      ) : state.kind === 'unavailable' && fromProfile ? (
        // The prerequisite says itself where the card would be, with the way to meet it.
        state.reason === 'public_profile_unavailable' ? (
          <SurfaceStateCard
            kind="empty"
            layout="inline"
            iconName="globe"
            title={t('publicIdentity.share.unpublished_image')}
            reason={t('publicIdentity.share.unpublishedBody')}
            {...(props.openProfile ? { action: { label: t('publicIdentity.share.previewProfile'), onPress: props.openProfile } } : {})}
          />
        ) : (
          <SurfaceStateCard
            kind="empty"
            layout="inline"
            title={t('publicIdentity.share.serviceUnavailable')}
            reason={t('publicIdentity.share.readFailedBody')}
          />
        )
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
            onPress: () => { void commands.invoke('retry'); },
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

  const imageSourceControl = props.setImageSource ? (
    <ItemGroup title={t('publicIdentity.share.imageFrom')} surface="none">
      <SegmentedTabBar
        testIDPrefix="usage-recap-image-source"
        compact
        segmentSizing="content"
        activeTabId={imageSource}
        onSelectTab={id => { void commands.invoke(`imageSource:${id}`); }}
        accessibilityLabel={t('publicIdentity.share.imageFrom')}
        tabs={RECAP_IMAGE_SOURCES.map(id => ({ id, label: t(`publicIdentity.share.imageFrom_${id}`) }))}
      />
    </ItemGroup>
  ) : null;
  const controls = (
    <>
      {imageSourceControl}
      {/* The style tiles and the period control are their own surfaces: no sheet around them, which
          clipped the last tile row's caption and pressed the tiles against its edge. */}
      <ItemGroup title={t('usage.board.recap.styleLabel')} surface="none">
        <SelectionTiles
          variant="visual"
          density="compact"
          value={style}
          onChange={next => { if (next) void commands.invoke(`style:${next}`); }}
          options={styleOptions}
          testIdPrefix="usage-recap-style"
          accessibilityLabel={t('usage.board.recap.styleLabel')}
        />
      </ItemGroup>
      {fromProfile ? null : <>
      <ItemGroup title={t('usage.board.recap.periodLabel')} surface="none">
        <SegmentedTabBar
          testIDPrefix="usage-recap-period"
          compact
          segmentSizing="content"
          activeTabId={period}
          onSelectTab={id => { void commands.invoke(`period:${id}`); }}
          tabs={PERIODS.map((id) => ({
            id,
            label: t(getUsagePeriodDefinition(id).shortTranslationKey),
          }))}
        />
      </ItemGroup>
      <ItemGroup
        title={t('usage.board.recap.sourceLabel')}
        surface="none"
        description={sourceSelection === 'happier_only' && (composed?.coverage.execution?.status === 'partial' || composed?.coverage.execution?.status === 'unknown')
          ? t('usage.board.recap.sourcePartialHint')
          : t('usage.board.recap.sourceHint')}
      >
        <SegmentedTabBar
          testIDPrefix="usage-recap-source"
          compact
          segmentSizing="content"
          activeTabId={sourceSelection}
          onSelectTab={id => { void commands.invoke(`source:${id}`); }}
          accessibilityLabel={t('usage.board.recap.sourceLabel')}
          tabs={USAGE_RECAP_SOURCE_SELECTIONS.map((id) => ({ id, label: t(`usage.board.recap.source_${id}`) }))}
        />
      </ItemGroup>
      </>}
      <ItemGroup title={t('usage.board.recap.fieldsLabel')}>
        {offeredFields.map((field) => {
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
                  onValueChange={next => { void commands.invoke(`field:${field}`, next); }}
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
            void commands.invoke('deliver:copy');
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
            void commands.invoke('deliver:save');
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
            void commands.invoke('deliver:share');
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
      note={notice ?? (fromProfile ? t('publicIdentity.share.imageFromProfileNote') : t('usage.board.recap.madeLocally'))}
      noteTestID="usage-recap-composer.note"
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
    // The card chrome insets only its title band: the outputs stand on the title's edge.
    paddingHorizontal: theme.space.s16,
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
