import * as React from 'react';
import { ErrorState, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui/components';
import {
  useDatabaseRelations,
  useDatabaseSchemaRelations,
  useWorkbenchLocation,
} from '../hooks.js';
import { approxRowsLabel, bytesLabel } from './sizes.js';

type DirectoryRow = ReturnType<
  typeof useDatabaseSchemaRelations
>['relations'][number];
type Sized = DirectoryRow &
  Readonly<{
    size?: Readonly<{
      bytes: string;
      tableBytes?: string;
      indexBytes?: string;
    }>;
  }>;

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Biggest first (D27 #1); a table the producer could not size keeps its catalogue order after the sized ones. */
function bySize(left: Sized, right: Sized): number {
  const a = left.size ? BigInt(left.size.bytes) : -1n;
  const b = right.size ? BigInt(right.size.bytes) : -1n;
  return a === b ? 0 : a > b ? -1 : 1;
}

/**
 * The database Overview's table directory (D27 #1–2): name, the database's own row estimate, and data, index
 * and total bytes. It reads the same relation page the rail's open schema reads; no second catalogue demand.
 */
export function TableDirectory(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const location = useWorkbenchLocation();
  const schemas = useDatabaseRelations(props.targetKey);
  const schema = schemas.schemas[0]?.name;
  return schema ? (
    <SchemaDirectory
      targetKey={props.targetKey}
      schema={schema}
      onOpen={(name) =>
        void location.navigate({
          relation: { schema, name },
          mode: 'data',
        })
      }
    />
  ) : schemas.status === 'unavailable' ? (
    <ErrorState
      layout="line"
      kind="unavailable"
      title={translate(
        'plugins.database.rail.failed',
        'Tables could not be read',
      )}
      details={
        schemas.error instanceof Error ? schemas.error.message : undefined
      }
      onRetry={schemas.refresh}
      retryLabel={translate('plugins.database.retry', 'Try again')}
    />
  ) : null;
}

function SchemaDirectory(
  props: Readonly<{
    targetKey: string;
    schema: string;
    onOpen: (name: string) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const page = useDatabaseSchemaRelations(props.targetKey, props.schema);
  const rows = React.useMemo(
    () =>
      (page.relations as readonly Sized[])
        .filter((row) => row.kind !== 'view')
        .slice()
        .sort(bySize),
    [page.relations],
  );
  const model = useHappierCollection({
    items: rows,
    keyOf: (row) => row.name,
    openKey: null,
    onOpenChange: (key) => {
      if (key) props.onOpen(String(key));
    },
  });
  const anatomy = React.useMemo<CollectionAnatomy<Sized>>(() => {
    const figure = (
      key: string,
      title: string,
      value: (row: Sized) => string | null | undefined,
      minWidth: number,
      priority: number,
    ): CollectionField<Sized> => ({
      key,
      title,
      minWidth,
      priority,
      align: 'end',
      render: (row) => (
        <Text variant="body" value={value(row) ?? '—'} />
      ),
    });
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (row) => row.name,
      titleIdentifier: true,
      // Narrow (phone): the figures drop, so the row says its estimate and total under the name (lab directoryp).
      byline: (row, layout) =>
        layout?.fieldColumns
          ? null
          : [
              approxRowsLabel(row.approxRows) &&
                translate('plugins.database.directory.rowsLine', '{rows} rows', { rows: approxRowsLabel(row.approxRows)! }),
              bytesLabel(row.size?.bytes),
            ]
              .filter(Boolean)
              .join(' · ') || null,
      fields: [
        figure(
          'rows',
          translate('plugins.database.directory.rows', 'Rows'),
          (row) => approxRowsLabel(row.approxRows),
          88,
          4,
        ),
        figure(
          'data',
          translate('plugins.database.directory.data', 'Data'),
          (row) => bytesLabel(row.size?.tableBytes),
          88,
          2,
        ),
        figure(
          'indexes',
          translate('plugins.database.directory.indexes', 'Indexes'),
          (row) => bytesLabel(row.size?.indexBytes),
          88,
          1,
        ),
        figure(
          'total',
          translate('plugins.database.directory.total', 'Total'),
          (row) => bytesLabel(row.size?.bytes),
          88,
          3,
        ),
      ],
      accessibilityLabel: (row) => row.name,
      columnTitles: {
        title: translate('plugins.database.directory.table', 'Table'),
      },
    };
  }, [translate]);
  if (page.status === 'unavailable') {
    return (
      <ErrorState
        layout="line"
        kind="unavailable"
        title={translate(
          'plugins.database.rail.failed',
          'Tables could not be read',
        )}
        details={page.error instanceof Error ? page.error.message : undefined}
        onRetry={page.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  return (
    <Collection
      accessibilityLabel={translate(
        'plugins.database.directory.title',
        'Tables',
      )}
      title={translate('plugins.database.directory.title', 'Tables')}
      header={
        <Text
          tone="secondary"
          value={translate(
            'plugins.database.directory.description',
            'Biggest first. Row counts are the database’s own estimates, so they can be a little behind.',
          )}
        />
      }
      model={model}
      anatomy={anatomy}
      presentation="table"
      collapsedGroups={EMPTY_SET}
      loading={page.status === 'loading' && rows.length === 0}
      empty={
        <Text
          tone="secondary"
          value={translate(
            'plugins.database.directory.empty',
            'No tables in {schema}',
            { schema: props.schema },
          )}
        />
      }
      scroll="page"
      minListWidth={420}
      minDetailWidth={320}
      preferredListRatio={1}
    />
  );
}
