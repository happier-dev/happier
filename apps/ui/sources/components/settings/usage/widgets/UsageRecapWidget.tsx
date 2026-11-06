import * as React from 'react';
import { UsageAccountingMetricSchema } from '@happier-dev/protocol/inputs/usageQuery';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { formatHappierDataValue, UsageRecapBody, type UsageRecapHighlight } from '@happier-dev/plugin-ui/presentation';
import { getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { UsageExportFieldSchema, UsageFileResultSchema, type UsageExportInput } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import type { UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { buildUsageRecapCardModels } from '@/sync/domains/usage/recap/buildUsageRecapCardModels';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { getPreferredLanguage, t } from '@/text';
import { exportUsageTextDocument } from '../usageExportFile';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import {
  UsageBodyInsufficient,
  UsageBodyNoUsage,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { RecapStorySurface } from './recap/RecapStorySurface';
import { openUsageRecapComposer } from './recap/UsageRecapComposer';
import { formatIdentifierLabel } from '@/utils/format/usageNumbers';
import { UsageWorkAutopsy } from './UsageWorkAutopsy';
import { UsageRecordsStyleBody } from './UsageChartStyleBodies';

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageRecapWidget(props: UsageBodyProps) {
  if (props.presentation?.style === 'personalRecords') return <UsageRecordsStyleBody {...props} />;
  return <UsageRecapWidgetOriginal {...props} />;
}

/**
 * Recap (lab urecap/s2wrap): the period's highlights from the same admitted slice, then the two
 * private outputs — the story, and the one stat-card composer behind Share. Existing summary/JSON/CSV
 * exports stay here as quiet actions on the same facts.
 */
function UsageRecapWidgetOriginal(props: UsageBodyProps): React.ReactElement {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const shownQuery = props.slice.shownQuery;
  const shownKey = getUsageQueryKey(shownQuery);
  const delivery = React.useRef<AbortController | null>(null);
  const [exporting, setExporting] = React.useState<UsageExportInput['format'] | null>(null);
  const [exportFailed, setExportFailed] = React.useState(false);
  React.useEffect(() => {
    setExportFailed(false);
    setExporting(null);
    return () => { delivery.current?.abort(); delivery.current = null; };
  }, [shownKey, props.serverId]);
  const exportFields = React.useMemo(() => Object.keys(props.slice.accounting ?? {}).flatMap(key => {
    const field = UsageExportFieldSchema.safeParse(key);
    return field.success ? [field.data] : [];
  }), [props.slice.accounting]);
  const execution = useMountedActionExecution(props.serverId);
  const writeClipboard = useClipboardWrite(props.serverId);
  const exportFacts = async (format: UsageExportInput['format']) => {
    if (!execution.isCurrent()) return;
    const controller = new AbortController();
    delivery.current?.abort();
    delivery.current = controller;
    const isCurrent = () => !controller.signal.aborted && execution.isCurrent();
    setExporting(format);
    setExportFailed(false);
    try {
      const executed = await execution.execute('usage.export', {
        query: shownQuery, format, fields: format === 'text' ? ['totals']
          : [...new Set([...exportFields, 'contributions' as const])],
      }, { signal: controller.signal });
      if (!isCurrent()) return;
      if (!executed.ok) {
        // A declined approval is the person's own answer, not a failed export.
        if (!isActionApprovalDeclinedErrorCode(executed.errorCode)) throw new Error(executed.errorCode);
        return;
      }
      const file = UsageFileResultSchema.parse(executed.result);
      const content = new TextDecoder().decode(decodeBase64(file.base64));
      const delivered = format === 'text' ? await writeClipboard(content, { signal: controller.signal })
        : await exportUsageTextDocument({ content, fileName: file.fileName, mimeType: file.mediaType, isCurrent });
      if (isCurrent()) setExportFailed(!delivered);
    } catch {
      if (isCurrent()) setExportFailed(true);
    } finally {
      if (delivery.current === controller) { delivery.current = null; setExporting(null); }
    }
  };
  const exportActions: ItemAction[] = [
    { id: `${props.testID}.copySummary`, title: t('common.copyWithLabel', { label: t('usage.summary.title') }), icon: 'copy',
      disabled: exporting !== null, onPress: () => { void exportFacts('text'); } },
    { id: `${props.testID}.json`, title: t('files.repositoryTree.actions.download'), icon: 'download',
      disabled: exporting !== null, onPress: () => { void exportFacts('json'); } },
    { id: `${props.testID}.csv`, title: t('usage.exportCsv'), icon: 'file-arrow-down',
      disabled: exporting !== null, onPress: () => { void exportFacts('csv'); } },
  ];
  const viewModel = useUsageAnalyticsView(props.slice, props.query);
  // Legacy story shaping consumes the admitted response; it does not select a new period.
  const period = 'all' as const;
  const filters = React.useMemo<UsageFilterState>(
    () => ({
      period,
      metric: UsageAccountingMetricSchema.parse(props.query.metric),
      costMode: props.query.costBasis,
      focus: null,
    }),
    [period, props.query.metric, props.query.costBasis],
  );
  const sessionId =
    typeof shownQuery.session === 'string' ? shownQuery.session
      : shownQuery.session?.length === 1 ? shownQuery.session[0] : undefined;
  const highlights = React.useMemo(
    () => viewModel === null ? [] : buildUsageRecapCardModels({ viewModel, filters, query: shownQuery })
      .map((highlight): UsageRecapHighlight => {
        const base = { id: highlight.id, testID: highlight.testID, label: highlight.label,
          value: formatIdentifierLabel(highlight.value), detail: highlight.subtitle };
        const tokens = formatHappierDataValue(viewModel.overview.totalTokens, getPreferredLanguage());
        const amount = viewModel.pageCost?.amountUsd;
        if (highlight.id === 'usage') {
          const money = amount === null || amount === undefined ? null : formatHappierDataValue(amount, getPreferredLanguage());
          const value = filters.metric === 'cost' && money !== null ? `${viewModel.pageCost!.selection?.currency ?? viewModel.costPresentation.currency} ${money}`
            : `${tokens} ${t('usage.tokens')}`;
          const subtitle = `${tokens} ${t('usage.tokens')}`;
          return (!`${highlight.value} ${highlight.subtitle}`.includes(tokens) || money !== null && !`${highlight.value} ${highlight.subtitle}`.includes(money))
            ? { ...base, datum: { label: highlight.label, value, subtitle } } : base;
        }
        const count = highlight.id === 'model' ? viewModel.insights.favoriteModelChangeCount
          : highlight.id === 'rhythm' && highlight.visual?.kind === 'rankBars' ? highlight.visual.rows[0]?.value : undefined;
        const exact = count === undefined ? undefined : formatHappierDataValue(count, getPreferredLanguage());
        return exact !== undefined && !highlight.subtitle.includes(exact)
          ? { ...base, datum: { label: highlight.value, value: `${exact} ${t(highlight.id === 'model' ? 'usage.modelSwitches' : 'usage.events')}`, subtitle: highlight.label } }
          : base;
      }),
    [viewModel, filters, shownQuery],
  );
  useWidgetFrameBodyCaption(
    t('usage.board.recap.captionPeriod', {
      period: usagePeriodPhrase(props.query),
    }),
  );

  const openComposer = React.useCallback(() => {
    openUsageRecapComposer({ query: shownQuery, serverId: props.serverId });
  }, [shownQuery, props.serverId]);
  const playStory = React.useCallback(() => {
    if (!viewModel) return;
    let modalId: string | null = null;
    const close = () => {
      if (modalId) {
        Modal.hide(modalId);
        modalId = null;
      }
    };
    modalId = Modal.show({
      component: RecapStorySurface,
      onRequestClose: close,
      props: {
        viewModel,
        filters,
        query: shownQuery,
        cacheSavings: viewModel.cacheSavings,
        sessionId,
        onDismiss: close,
        onShare: () => { close(); openComposer(); },
      },
    });
  }, [viewModel, filters, shownQuery, sessionId, openComposer]);
  if (!viewModel)
    return (
      <UsageRecapBody theme={theme} model={{ highlights }} testID={props.testID}
        state={<UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />}
        autopsy={<UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />} />
    );
  if (highlights.length === 0)
    return (
      <UsageRecapBody theme={theme} model={{ highlights }} testID={props.testID}
        state={<UsageBodyInsufficient
          testID={`${props.testID}.empty`}
          replacesContent={false}
          title={t('usage.board.recap.noRecapTitle')}
          reason={t('usage.board.recap.noRecapReason')}
        />}
        autopsy={<UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />} />
    );
  return (
    <UsageRecapBody theme={theme} model={{ highlights }} testID={props.testID}
      highlightBorderColor={appTheme.colors.border.subtle} highlightSpacing={appTheme.space}
      autopsy={<UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />}
      actions={<>
        {/* The one primary: the private card is what this widget makes (lab urecap/s2card). */}
        <RoundButton
          size="small"
          title={t('usage.board.recap.shareCard')}
          onPress={openComposer}
          testID={`${props.testID}.share`}
        />
        <RoundButton
          size="small"
          display="secondary"
          title={t('usage.recap.play')}
          onPress={playStory}
          testID={`${props.testID}.play`}
        />
        {/* The facts behind the card are three quiet exports behind one overflow, not three more buttons. */}
        <ItemRowActions
          title={t('common.moreActions')}
          overflowOnly
          overflowTriggerTestID={`${props.testID}.exports`}
          overflowTriggerAccessibilityLabel={t('common.moreActions')}
          actions={exportActions}
        />
      </>}
      notice={exportFailed ? <SurfaceFreshnessLine testID={`${props.testID}.exportNotice`} tone="warning"
        reason={t('usage.board.recap.exportFailed')} /> : null} />
  );
}
