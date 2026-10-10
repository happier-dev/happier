import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageExportFieldSchema, UsageFileResultSchema, type UsageExportInput } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import type { UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { buildUsageRecapCardModels } from '@/sync/domains/usage/recap/buildUsageRecapCardModels';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';
import { exportUsageTextDocument } from '../usageExportFile';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import {
  UsageBodyInsufficient,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  type UsageBodyProps,
} from './usageBodyKit';
import { RecapStorySurface } from './recap/RecapStorySurface';
import { UsageRecapComposer } from './recap/UsageRecapComposer';
import { UsageRecapHighlights } from './recap/UsageRecapHighlights';
import { UsageWorkAutopsy } from './UsageWorkAutopsy';

/**
 * Recap (lab urecap/s2wrap): the period's highlights from the same admitted slice, then the two
 * private outputs — the story, and the one stat-card composer behind Share. Existing summary/JSON/CSV
 * exports stay here as quiet actions on the same facts.
 */
export function UsageRecapWidget(props: UsageBodyProps): React.ReactElement {
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
  const exportFacts = async (format: UsageExportInput['format']) => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) return;
    const controller = new AbortController();
    delivery.current?.abort();
    delivery.current = controller;
    const retired = lifetime.onRetire(() => controller.abort());
    const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent();
    setExporting(format);
    setExportFailed(false);
    try {
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      controller.signal.throwIfAborted();
      const executed = await createDefaultActionExecutor().execute('usage.export', {
        query: shownQuery, format, fields: format === 'text' ? ['totals'] : exportFields,
      }, { surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
        expectedAccountId: lifetime.scope.accountId, signal: controller.signal });
      if (!isCurrent()) return;
      if (!executed.ok) throw new Error(executed.errorCode);
      const file = UsageFileResultSchema.parse(executed.result);
      const content = new TextDecoder().decode(decodeBase64(file.base64));
      const delivered = format === 'text' ? await setClipboardStringSafe(content)
        : await exportUsageTextDocument({ content, fileName: file.fileName, mimeType: file.mediaType, isCurrent });
      if (isCurrent()) setExportFailed(!delivered);
    } catch {
      if (isCurrent()) setExportFailed(true);
    } finally {
      retired.dispose();
      if (delivery.current === controller) { delivery.current = null; setExporting(null); }
    }
  };
  const viewModel = useUsageAnalyticsView(props.slice, props.query);
  // Legacy story shaping consumes the admitted response; it does not select a new period.
  const period = 'all' as const;
  const filters = React.useMemo<UsageFilterState>(
    () => ({
      period,
      metric: props.query.metric,
      costMode: props.query.costBasis,
      focus: null,
    }),
    [period, props.query.metric, props.query.costBasis],
  );
  const sessionId =
    typeof shownQuery.session === 'string' ? shownQuery.session
      : shownQuery.session?.length === 1 ? shownQuery.session[0] : undefined;
  const hasRecap = React.useMemo(
    () =>
      viewModel !== null &&
      buildUsageRecapCardModels({ viewModel, filters, query: shownQuery }).length > 0,
    [viewModel, filters, shownQuery],
  );
  useWidgetFrameBodyCaption(
    t('usage.board.recap.captionPeriod', {
      period: usagePeriodPhrase(props.query),
    }),
  );

  const openComposer = React.useCallback(() => {
    Modal.show({
      component: UsageRecapComposer,
      props: {
        query: props.query,
        serverId: props.serverId,
      },
      chrome: {
        kind: 'card',
        material: 'solid',
        title: t('usage.board.recap.shareTitle'),
        phonePresentation: 'fullscreen',
        dimensions: { size: 'lg' },
        testID: 'usage-recap-composer.modal',
      },
    });
  }, [props.query, props.serverId]);
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
  if (!viewModel || !hasRecap)
    return (
      <View style={styles.root}>
        <UsageBodyInsufficient
          testID={`${props.testID}.empty`}
          title={t('usage.board.recap.noRecapTitle')}
          reason={t('usage.board.recap.noRecapReason')}
        />
        <UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />
      </View>
    );
  return (
    <View style={styles.root}>
      <UsageRecapHighlights
        viewModel={viewModel}
        filters={filters}
        query={shownQuery}
        testID={`${props.testID}.highlights`}
      />
      <UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />
      <View style={styles.actions}>
        <RoundButton
          size="small"
          display="secondary"
          title={t('usage.recap.play')}
          onPress={playStory}
          testID={`${props.testID}.play`}
        />
        <RoundButton
          size="small"
          display="secondary"
          title={t('usage.board.recap.shareCard')}
          onPress={openComposer}
          testID={`${props.testID}.share`}
        />
        <View style={styles.grow} />
        <RoundButton
          size="small"
          display="inverted"
          title={t('common.copyWithLabel', { label: t('usage.summary.title') })}
          onPress={() => { void exportFacts('text'); }}
          loading={exporting === 'text'}
          disabled={exporting !== null}
          testID={`${props.testID}.copySummary`}
        />
        <RoundButton
          size="small"
          display="inverted"
          title={t('files.repositoryTree.actions.download')}
          onPress={() => { void exportFacts('json'); }}
          loading={exporting === 'json'}
          disabled={exporting !== null}
          testID={`${props.testID}.json`}
        />
        <RoundButton
          size="small"
          display="inverted"
          title={t('usage.exportCsv')}
          onPress={() => { void exportFacts('csv'); }}
          loading={exporting === 'csv'}
          disabled={exporting !== null}
          testID={`${props.testID}.csv`}
        />
      </View>
      {exportFailed ? <SurfaceFreshnessLine testID={`${props.testID}.exportNotice`} tone="warning"
        reason={t('usage.board.recap.exportFailed')} /> : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  root: {
    gap: 16,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  grow: {
    flexGrow: 1,
  },
}));
