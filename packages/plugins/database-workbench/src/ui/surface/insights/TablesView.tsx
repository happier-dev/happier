import * as React from 'react';
import type { DatabaseRelationV1, DatabaseStatsObservationV1 } from '@happier-dev/database-protocol';
import {
  Collection,
  formatHappierDataBytes,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui/components';
import {
  ErrorState,
  Item,
  ItemGroup,
  Select,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { useDatabaseRelations, useDatabaseInsights } from '../../hooks.js';
import { WORKBENCH_DISPLAY_PAGE_ROWS } from '../mount.js';
import { formatAgo, formatCount, formatPercent, ratio } from './format.js';
import { InsightsSetup } from './InsightsSetup.js';

type TableRow = Extract<
  DatabaseStatsObservationV1,
  { status: 'available'; group: 'tables' }
>['data'][number];
type IndexRow = Extract<
  DatabaseStatsObservationV1,
  { status: 'available'; group: 'indexes' }
>['data'][number];
const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_ROWS: readonly never[] = Object.freeze([]);

function bytes(value: string | undefined): string | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number)
    ? formatHappierDataBytes(number, { kind: 'storage' })
    : null;
}

/** Dead rows as a share of all rows the table holds; unknown stays unknown. */
function deadShare(row: TableRow): number | null {
  if (row.deadRows === undefined || row.liveRows === undefined) return null;
  return ratio(row.deadRows, (BigInt(row.liveRows) + BigInt(row.deadRows)).toString());
}

/** Index-scan evidence (D27 #5): how many scans read the whole table. Evidence only, never advice. */
function scanLine(row: TableRow, translate: PluginTranslate): string | null {
  if (row.sequentialScans === undefined || row.indexScans === undefined)
    return null;
  const share = ratio(
    row.sequentialScans,
    (BigInt(row.sequentialScans) + BigInt(row.indexScans)).toString(),
  );
  if (share === null) return null;
  return translate(
    'plugins.database.insights.seqShare',
    '{share} of scans read the whole table',
    {
      share: formatPercent(share) ?? '',
    },
  );
}

function tableByline(row: TableRow, translate: PluginTranslate): string {
  const estimate = row.liveRows ?? row.estimatedRows;
  return [
    estimate !== undefined
      ? translate('plugins.database.insights.rowsApprox', '~{rows} rows', {
          rows: formatCount(estimate) ?? estimate,
        })
      : null,
    scanLine(row, translate),
  ]
    .filter(Boolean)
    .join(' · ');
}

function vacuumText(row: TableRow, translate: PluginTranslate): string {
  // Autovacuum timestamps join here when the PostgreSQL stats producer reports them (D27 #6, DBW-ADDNOW).
  return (
    formatAgo(translate, row.lastVacuum) ??
    translate('plugins.database.insights.never', 'never')
  );
}

function TablesCollection(
  props: Readonly<{ rows: readonly TableRow[]; loading: boolean; onOpenTable?: (relation: DatabaseRelationV1) => void }>,
) {
  const translate = usePluginTranslation();
  const model = useHappierCollection({
    items: props.rows,
    keyOf: (row) => row.relation.name,
    // A table opens its rows in the workbench.
    openKey: null,
    onOpenChange: (key) => {
      const row = props.rows.find((item) => item.relation.name === key);
      if (row) props.onOpenTable?.(row.relation);
    },
  });
  const anatomy = React.useMemo<CollectionAnatomy<TableRow>>(() => {
    const fields: CollectionField<TableRow>[] = [
      {
        key: 'size',
        title: translate('plugins.database.insights.size', 'Size'),
        minWidth: 90,
        priority: 3,
        align: 'end',
        render: (row) => (
          <Text variant="body" value={bytes(row.size?.bytes) ?? '—'} />
        ),
      },
      {
        key: 'dead',
        title: translate('plugins.database.insights.deadRows', 'Dead rows'),
        minWidth: 96,
        priority: 2,
        align: 'end',
        render: (row) => (
          <Text variant="body" value={formatPercent(deadShare(row)) ?? '—'} />
        ),
      },
      {
        key: 'vacuum',
        title: translate('plugins.database.insights.lastVacuum', 'Last vacuum'),
        minWidth: 110,
        priority: 1,
        align: 'end',
        render: (row) => (
          <Text
            variant="body"
            tone="secondary"
            value={vacuumText(row, translate)}
          />
        ),
      },
    ];
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (row) => row.relation.name,
      titleIdentifier: true,
      byline: (row) => tableByline(row, translate) || null,
      fields,
      accessibilityLabel: (row) => row.relation.name,
      columnTitles: {
        title: translate('plugins.database.insights.table', 'Table'),
      },
    };
  }, [translate]);
  return (
    <Collection
      accessibilityLabel={translate(
        'plugins.database.insights.tables',
        'Tables',
      )}
      title={translate('plugins.database.insights.tables', 'Tables')}
      model={model}
      anatomy={anatomy}
      presentation="table"
      collapsedGroups={EMPTY_SET}
      loading={props.loading && props.rows.length === 0}
      empty={
        <Text
          tone="secondary"
          value={translate(
            'plugins.database.insights.noTables',
            'No tables in this schema',
          )}
        />
      }
      minListWidth={420}
      minDetailWidth={320}
      preferredListRatio={1}
    />
  );
}

/** Indexes the database never used for a read since its statistics started: evidence, not a verdict. */
function UnusedIndexes(props: Readonly<{ rows: readonly IndexRow[] }>) {
  const translate = usePluginTranslation();
  const unused = props.rows.filter(
    (row) => row.scans === '0' && !row.primary && !row.constraint,
  );
  if (unused.length === 0) return null;
  return (
    <ItemGroup
      title={translate(
        'plugins.database.insights.unusedIndexes',
        'Indexes with no scans',
      )}
      description={translate(
        'plugins.database.insights.unusedIndexesLine',
        'No read has used these since statistics started. Each one still costs every write; check replicas and rare jobs before removing one.',
      )}
    >
      {unused.map((row) => (
        <Item
          key={`${row.relation.name}.${row.name}`}
          title={row.name}
          titleEllipsizeMode="middle"
          subtitle={[row.relation.name, bytes(row.bytes)]
            .filter(Boolean)
            .join(' · ')}
        />
      ))}
    </ItemGroup>
  );
}

/** Table and index health for one schema: catalog facts read on open, no time window. */
export function TablesView(props: Readonly<{ targetKey: string; onOpenTable?: (relation: DatabaseRelationV1) => void }>) {
  const translate = usePluginTranslation();
  const relations = useDatabaseRelations(props.targetKey);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const schema = chosen ?? relations.schemas[0]?.name;
  if (relations.status === 'unavailable') {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.rail.schemasFailed',
          'Schemas could not be read',
        )}
        details={
          relations.error instanceof Error ? relations.error.message : undefined
        }
        onRetry={relations.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  return (
    <Stack gap="large" grow>
      {relations.schemas.length > 1 ? (
        <Select
          label={translate('plugins.database.insights.schema', 'Schema')}
          options={relations.schemas.map((item) => ({
            value: item.name,
            label: item.name,
          }))}
          value={schema ?? ''}
          onChange={(value) => { if (typeof value === 'string') setChosen(value); }}
        />
      ) : null}
      {schema ? (
        <SchemaHealth targetKey={props.targetKey} schema={schema} {...(props.onOpenTable ? { onOpenTable: props.onOpenTable } : {})} />
      ) : null}
    </Stack>
  );
}

function SchemaHealth(props: Readonly<{ targetKey: string; schema: string; onOpenTable?: (relation: DatabaseRelationV1) => void }>) {
  const translate = usePluginTranslation();
  const selection = React.useMemo(
    () => ({
      schema: props.schema,
      page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 },
    }),
    [props.schema],
  );
  const tables = useDatabaseInsights(props.targetKey, {
    kind: 'stats.read',
    group: 'tables',
    selection,
  });
  const indexes = useDatabaseInsights(props.targetKey, {
    kind: 'stats.read',
    group: 'indexes',
    selection,
  });
  const tableObservation = tables.observation;
  if (tableObservation?.status === 'unavailable')
    return <InsightsSetup observation={tableObservation} />;
  if (tables.status === 'unavailable') {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.insights.tablesFailed',
          'Table statistics could not be read',
        )}
        details={
          tables.error instanceof Error ? tables.error.message : undefined
        }
        onRetry={tables.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  const tableRows =
    tableObservation?.status === 'available' &&
    tableObservation.group === 'tables'
      ? [...tableObservation.data].sort(
          (a, b) => Number(b.size?.bytes ?? 0) - Number(a.size?.bytes ?? 0),
        )
      : NO_ROWS;
  const indexObservation = indexes.observation;
  const indexRows =
    indexObservation?.status === 'available' &&
    indexObservation.group === 'indexes'
      ? indexObservation.data
      : NO_ROWS;
  return (
    <Stack gap="xlarge">
      <TablesCollection
        rows={tableRows}
        loading={tables.status === 'loading'}
        {...(props.onOpenTable ? { onOpenTable: props.onOpenTable } : {})}
      />
      <UnusedIndexes rows={indexRows} />
    </Stack>
  );
}
