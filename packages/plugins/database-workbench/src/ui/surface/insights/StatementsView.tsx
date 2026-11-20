import * as React from 'react';
import type { DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import {
  CapacityBar,
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui/components';
import {
  Metric,
  Row,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { formatCount, formatDuration, formatPercent } from './format.js';
import { StatementDetail } from './StatementDetail.js';
import { summarizeChanges, type StatementView } from './statements.js';

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The quiet second line: rows per call, then what changed since your last look. */
export function statementByline(
  view: StatementView,
  translate: PluginTranslate,
): string {
  const parts: string[] = [];
  if (view.rowsPerCall !== null) {
    const rows = Math.round(view.rowsPerCall);
    parts.push(
      rows === 1
        ? translate('plugins.database.insights.oneRowPerCall', '1 row per call')
        : translate(
            'plugins.database.insights.rowsPerCallLine',
            '{rows} rows per call',
            { rows: formatCount(rows) ?? String(rows) },
          ),
    );
  }
  if (view.change && view.change.meanTimeMs !== null) {
    parts.push(
      translate(
        'plugins.database.insights.meanSinceLine',
        'mean {mean} since your last look',
        {
          mean: formatDuration(view.change.meanTimeMs) ?? '',
        },
      ),
    );
  } else if (view.isNew) {
    parts.push(
      translate(
        'plugins.database.insights.newLine',
        'new since your last look',
      ),
    );
  }
  return parts.join(' · ');
}

export function statementTitle(
  view: StatementView,
  translate: PluginTranslate,
): string {
  return (
    view.row.shape ??
    translate(
      'plugins.database.insights.shapeHiddenTitle',
      'Statement text hidden',
    )
  );
}

/** Four facts lead when the comparison covers rows; otherwise the list stands alone (no invented totals). */
function SinceLastLook(
  props: Readonly<{ views: readonly StatementView[]; complete: boolean }>,
) {
  const translate = usePluginTranslation();
  const summary = summarizeChanges(props.views);
  const top = props.views[0];
  if (!summary || !top) return null;
  const scope = props.complete
    ? translate(
        'plugins.database.insights.sinceLastLook',
        'since your last look',
      )
    : translate(
        'plugins.database.insights.sinceLastLookShown',
        'in the statements shown, since your last look',
      );
  return (
    <Row gap="large" wrap>
      <Metric
        size="stat"
        label={translate('plugins.database.insights.calls', 'Calls')}
        value={
          formatCount(summary.calls.toString()) ?? summary.calls.toString()
        }
        caption={scope}
      />
      {summary.meanMs !== null ? (
        <Metric
          size="stat"
          label={translate('plugins.database.insights.meanTime', 'Mean time')}
          value={formatDuration(summary.meanMs) ?? ''}
          caption={scope}
        />
      ) : null}
      <Metric
        size="stat"
        label={translate(
          'plugins.database.insights.topShare',
          'Costliest statement',
        )}
        value={formatPercent(top.share) ?? ''}
        caption={
          props.complete
            ? translate(
                'plugins.database.insights.ofStatementTime',
                'of statement time',
              )
            : translate(
                'plugins.database.insights.ofShownTime',
                'of the time shown',
              )
        }
      />
    </Row>
  );
}

/** Total time, then its share of the time shown, as the lab's two-line cell. */
function TotalTime(props: Readonly<{ view: StatementView }>) {
  const translate = usePluginTranslation();
  return (
    <Stack gap="none" align="flex-end">
      <Text variant="body" value={formatDuration(props.view.row.totalTimeMs) ?? ''} />
      <Text
        variant="meta"
        tone="secondary"
        value={translate('plugins.database.insights.shareLabel', '{share} of time', {
          share: formatPercent(props.view.share) ?? '',
        })}
      />
    </Stack>
  );
}

/** The second line under the shape, then its share of time as a bar across the statement column. */
function StatementByline(props: Readonly<{ view: StatementView }>) {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const line = statementByline(props.view, translate);
  return (
    <Stack gap="xsmall">
      {line ? <Text variant="meta" tone="secondary" value={line} numberOfLines={1} /> : null}
      <CapacityBar
        theme={theme}
        size="inline"
        showCaption={false}
        label={translate('plugins.database.insights.shareLabel', '{share} of time', {
          share: formatPercent(props.view.share) ?? '',
        })}
        value={Math.round(props.view.share * 1000) / 10}
        capacity={100}
      />
    </Stack>
  );
}

/**
 * Where the database spends its time: statements by total time, the producer's ranking (P4 §9: no thresholds).
 * A statement opens in the details pane; on a phone it pushes.
 */
export function StatementsView(
  props: Readonly<{
    views: readonly StatementView[];
    complete: boolean;
    loading: boolean;
    target: DatabaseTargetV1;
    onOpenConsole?: (sql: string) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const model = useHappierCollection({
    items: props.views,
    keyOf: (view) => view.row.key,
    openKey,
    onOpenChange: setOpenKey,
  });
  const anatomy = React.useMemo<CollectionAnatomy<StatementView>>(() => {
    const fields: CollectionField<StatementView>[] = [
      {
        key: 'calls',
        title: translate('plugins.database.insights.calls', 'Calls'),
        minWidth: 92,
        priority: 2,
        align: 'end',
        render: (view) => (
          <Text
            variant="body"
            value={formatCount(view.row.calls) ?? view.row.calls}
          />
        ),
      },
      {
        key: 'mean',
        title: translate('plugins.database.insights.mean', 'Mean'),
        minWidth: 84,
        priority: 1,
        align: 'end',
        render: (view) => (
          <Text variant="body" value={formatDuration(view.meanMs) ?? '—'} />
        ),
      },
      {
        key: 'total',
        title: translate('plugins.database.insights.totalTime', 'Total time'),
        minWidth: 120,
        priority: 3,
        align: 'end',
        render: (view) => <TotalTime view={view} />,
      },
    ];
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (view) => statementTitle(view, translate),
      titleIdentifier: true,
      byline: (view) => <StatementByline view={view} />,
      fields,
      accessibilityLabel: (view) => statementTitle(view, translate),
      columnTitles: {
        title: translate('plugins.database.insights.statement', 'Statement'),
      },
    };
  }, [translate]);
  const open = openKey
    ? props.views.find((view) => view.row.key === openKey)
    : undefined;
  return (
    <Stack gap="large" grow>
      <SinceLastLook views={props.views} complete={props.complete} />
      <Collection
        accessibilityLabel={translate(
          'plugins.database.insights.statements',
          'Statements',
        )}
        model={model}
        anatomy={anatomy}
        presentation="table"
        detail="auto"
        detailOpenIntent="explicit"
        collapsedGroups={EMPTY_SET}
        loading={props.loading && props.views.length === 0}
        empty={
          <Text
            tone="secondary"
            value={translate(
              'plugins.database.insights.noStatements',
              'No statements yet. They appear here as your apps run them.',
            )}
          />
        }
        minListWidth={420}
        minDetailWidth={340}
        preferredListRatio={0.62}
        detailHeader={() => ({
          title: translate('plugins.database.insights.statement', 'Statement'),
        })}
        renderDetail={() =>
          open ? (
            <StatementDetail
              view={open}
              target={props.target}
              {...(props.onOpenConsole
                ? { onOpenConsole: props.onOpenConsole }
                : {})}
            />
          ) : null
        }
      />
    </Stack>
  );
}
